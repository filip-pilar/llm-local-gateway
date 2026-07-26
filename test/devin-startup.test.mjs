import assert from "node:assert/strict";
import test from "node:test";
import { startDevinTransport } from "../src/transport/devin.mjs";

const upstreamEnvironmentKeys = [
  "API_KEY",
  "CODEIUM_API_KEY",
  "CODEIUM_API_URL",
  "DATA_DIR",
  "DEFAULT_MODEL",
  "DEVIN_CONNECT",
  "HOST",
  "PORT",
  "WINDSURFAPI_ALLOW_UNAUTHENTICATED",
  "WINDSURFAPI_NO_OPEN",
  "WINDSURFAPI_SKIP_DOTENV",
];

test("Devin startup reconciles state and configures the pinned upstream", async () => {
  const previous = new Map(
    upstreamEnvironmentKeys.map((key) => [key, process.env[key]]),
  );
  const logs = [];
  const server = {
    listening: true,
    address: () => ({ address: "127.0.0.1", port: 4318 }),
  };
  let reconcileCall;
  let loaded = false;

  try {
    const result = await startDevinTransport({
      port: 4318,
      token: "fixture-token",
      dataDir: "/fixture/private-state",
      defaultModel: "swe-1-6-slow",
      log: (message) => logs.push(message),
      reconcile: (dataDir, token) => {
        reconcileCall = { dataDir, token };
        return { removed: 2 };
      },
      loadUpstream: async () => {
        loaded = true;
        return () => server;
      },
    });

    assert.equal(result, server);
    assert.deepEqual(reconcileCall, {
      dataDir: "/fixture/private-state",
      token: "fixture-token",
    });
    assert.equal(loaded, true);
    assert.match(logs[0], /removed 2 stale upstream account record/);
    assert.match(logs[1], /starting internal transport on 127\.0\.0\.1:4318/);
    assert.equal(process.env.API_KEY, "");
    assert.equal(process.env.CODEIUM_API_KEY, "fixture-token");
    assert.equal(process.env.DATA_DIR, "/fixture/private-state");
    assert.equal(process.env.DEFAULT_MODEL, "swe-1-6-slow");
    assert.equal(process.env.HOST, "127.0.0.1");
    assert.equal(process.env.PORT, "4318");
    assert.equal(process.env.WINDSURFAPI_ALLOW_UNAUTHENTICATED, "1");
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Devin startup rejects non-loopback hosts before touching state", async () => {
  let reconciled = false;
  await assert.rejects(
    startDevinTransport({
      host: "0.0.0.0",
      port: 4318,
      token: "fixture-token",
      dataDir: "/fixture/private-state",
      defaultModel: "swe-1-6-slow",
      reconcile: () => {
        reconciled = true;
        return { removed: 0 };
      },
    }),
    /must bind to 127\.0\.0\.1/,
  );
  assert.equal(reconciled, false);
});
