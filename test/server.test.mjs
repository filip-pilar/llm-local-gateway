import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startBridge } from "../src/service/bridge.mjs";
import { startDevinTransport } from "../src/transport/devin.mjs";
import { startGrokTransport } from "../src/transport/grok.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function availablePort() {
  const probe = createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
}

function missingProviderEnv(root, values = {}) {
  return {
    HOME: root,
    PATH: "",
    LLM_GATEWAY_DATA_DIR: join(root, "gateway-data"),
    DEVIN_CREDENTIALS_FILE: join(root, "missing-devin.toml"),
    GROK_HOME: join(root, "missing-grok-home"),
    GROK_CLI: join(root, "missing-grok"),
    ...values,
  };
}

test("an occupied provider port does not prevent the other provider lifecycle or public endpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "llm-gateway-provider-collision-"));
  const occupied = createServer((_request, response) => response.end("sentinel"));
  const devinPort = await listen(occupied);
  const publicPort = await availablePort();
  const grokPort = await availablePort();
  const logs = [];
  const bridge = await startBridge({
    env: missingProviderEnv(root, {
      LLM_GATEWAY_PORT: String(publicPort),
      LLM_GATEWAY_DEVIN_PORT: String(devinPort),
      LLM_GATEWAY_GROK_PORT: String(grokPort),
    }),
    log: (message) => logs.push(message),
  });
  try {
    assert.equal(bridge.providers.devin.server, null);
    assert.match(
      bridge.providers.devin.error.message,
      new RegExp(`Internal Devin transport port 127\\.0\\.0\\.1:${devinPort} is already in use`),
    );
    const readiness = await fetch(
      `http://127.0.0.1:${publicPort}/__llm_gateway/readiness`,
    );
    assert.equal(readiness.status, 503);
    const body = await readiness.json();
    assert.equal(body.providers.devin.ready, false);
    assert.equal(body.providers.grok.ready, false);
    assert.ok(logs.some((message) => message.includes("Devin transport unavailable")));
  } finally {
    await bridge.stop();
    await close(occupied);
  }
});

test("server rejects an occupied public port before reading any provider secret", async () => {
  const root = mkdtempSync(join(tmpdir(), "llm-gateway-public-collision-"));
  const occupied = createServer();
  const publicPort = await listen(occupied);
  const devinPort = await availablePort();
  const grokPort = await availablePort();
  try {
    await assert.rejects(
      startBridge({
        env: missingProviderEnv(root, {
          LLM_GATEWAY_PORT: String(publicPort),
          LLM_GATEWAY_DEVIN_PORT: String(devinPort),
          LLM_GATEWAY_GROK_PORT: String(grokPort),
        }),
        log: () => {},
      }),
      new RegExp(`Public gateway port 127\\.0\\.0\\.1:${publicPort} is already in use`),
    );
  } finally {
    await close(occupied);
  }
});

test("internal transports refuse non-loopback bindings", async () => {
  await assert.rejects(
    startDevinTransport({
      port: 4318,
      token: "fixture-token",
      dataDir: "/unused",
      defaultModel: "swe-1-6-slow",
      host: "0.0.0.0",
    }),
    /must bind to 127\.0\.0\.1/,
  );
  assert.throws(
    () => startGrokTransport({
      port: 4319,
      credentialPath: "/unused",
      cliPath: "/unused",
      host: "0.0.0.0",
    }),
    /must bind to 127\.0\.0\.1/,
  );
});
