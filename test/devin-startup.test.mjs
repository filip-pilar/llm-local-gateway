import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  protectInternalServer,
  startDevinTransport,
} from "../src/transport/devin.mjs";

const upstreamEnvironmentKeys = [
  "API_KEY",
  "CODEIUM_API_KEY",
  "CODEIUM_API_URL",
  "DATA_DIR",
  "DEBUG_REQUEST_BODIES",
  "DEFAULT_MODEL",
  "DEVIN_CONNECT",
  "DEVIN_CONNECT_IMAGE_TAG",
  "DEVIN_CONNECT_DEBUG_META",
  "DEVIN_CONNECT_DUMP_RAW",
  "DEVIN_CONNECT_WIRE_DUMP",
  "HOST",
  "LOG_LEVEL",
  "POLICY_BLOCK_RING",
  "PORT",
  "WINDSURFAPI_ALLOW_UNAUTHENTICATED",
  "WINDSURFAPI_DUMP_SYSTEM_PROMPT",
  "WINDSURFAPI_NO_OPEN",
  "WINDSURFAPI_PROTO_TRACE",
  "WINDSURFAPI_PROTO_TRACE_ERROR_STRINGS",
  "WINDSURFAPI_PROTO_TRACE_READ_WRAPPER_STRINGS",
  "WINDSURFAPI_PROTO_TRACE_STRINGS",
  "WINDSURFAPI_SKIP_DOTENV",
  "WINDSURFAPI_TRACE",
  "WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT",
];

const internalCapability = "fixture-internal-capability";

function sendRequest(port, { method = "GET", path = "/health", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const upstream = request({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    upstream.on("error", reject);
    upstream.end();
  });
}

test("internal Devin listener requires the capability on every route", async (t) => {
  const visited = [];
  const server = createServer((incoming, response) => {
    visited.push(`${incoming.method} ${incoming.url}`);
    response.writeHead(200, {
      "access-control-allow-origin": "*",
      "content-type": "application/json",
    });
    response.end('{"ok":true}');
  });
  protectInternalServer(server, internalCapability);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, "object");

  for (const candidate of [
    { method: "GET", path: "/health" },
    {
      method: "OPTIONS",
      path: "/v1/responses",
      headers: { origin: "https://fixture.invalid" },
    },
  ]) {
    const response = await sendRequest(address.port, candidate);
    assert.equal(response.status, 401);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  }
  assert.deepEqual(visited, []);

  const authorized = await sendRequest(address.port, {
    headers: { "x-api-key": internalCapability },
  });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.body, '{"ok":true}');
  assert.deepEqual(visited, ["GET /health"]);
});

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
  let scrubCall;
  let loaderCapability;
  let loaded = false;

  try {
    for (const key of upstreamEnvironmentKeys) process.env[key] = "ambient-value";
    const result = await startDevinTransport({
      port: 4318,
      token: "fixture-token",
      dataDir: "/fixture/private-state",
      defaultModel: "swe-1-6-slow",
      internalCapability,
      log: (message) => logs.push(message),
      reconcile: (dataDir, token) => {
        reconcileCall = { dataDir, token };
        return { removed: 2 };
      },
      scrubPolicySamples: (dataDir) => {
        scrubCall = dataDir;
        return { removed: 1 };
      },
      loadUpstream: async (capability) => {
        loaderCapability = capability;
        loaded = true;
        return () => server;
      },
    });

    assert.equal(result, server);
    assert.deepEqual(reconcileCall, {
      dataDir: "/fixture/private-state",
      token: "fixture-token",
    });
    assert.equal(scrubCall, "/fixture/private-state");
    assert.equal(loaderCapability, internalCapability);
    assert.equal(loaded, true);
    assert.match(logs[0], /removed 2 stale upstream account record/);
    assert.match(logs[1], /removed 1 persisted upstream policy sample/);
    assert.match(logs[2], /starting internal transport on 127\.0\.0\.1:4318/);
    assert.equal(process.env.API_KEY, internalCapability);
    assert.equal(process.env.CODEIUM_API_KEY, "fixture-token");
    assert.equal(process.env.DATA_DIR, "/fixture/private-state");
    assert.equal(process.env.DEFAULT_MODEL, "swe-1-6-slow");
    assert.equal(process.env.DEVIN_CONNECT_IMAGE_TAG, "10");
    assert.equal(process.env.HOST, "127.0.0.1");
    assert.equal(process.env.PORT, "4318");
    assert.equal(process.env.WINDSURFAPI_ALLOW_UNAUTHENTICATED, "0");
    assert.equal(process.env.POLICY_BLOCK_RING, "-1");
    assert.equal(process.env.WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT, "0");
    assert.equal(process.env.LOG_LEVEL, "error");
    for (const key of [
      "DEBUG_REQUEST_BODIES",
      "DEVIN_CONNECT_DEBUG_META",
      "DEVIN_CONNECT_DUMP_RAW",
      "DEVIN_CONNECT_WIRE_DUMP",
      "WINDSURFAPI_DUMP_SYSTEM_PROMPT",
      "WINDSURFAPI_PROTO_TRACE",
      "WINDSURFAPI_PROTO_TRACE_ERROR_STRINGS",
      "WINDSURFAPI_PROTO_TRACE_READ_WRAPPER_STRINGS",
      "WINDSURFAPI_PROTO_TRACE_STRINGS",
      "WINDSURFAPI_TRACE",
  "WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT",
    ]) {
      assert.equal(process.env[key], "0", key);
    }
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
      internalCapability,
      reconcile: () => {
        reconciled = true;
        return { removed: 0 };
      },
    }),
    /must bind to 127\.0\.0\.1/,
  );
  assert.equal(reconciled, false);
});

test("Devin startup rejects missing or unbounded internal capabilities before touching state", async () => {
  let reconciled = false;
  for (const value of [
    undefined,
    "short",
    "x".repeat(513),
    "invalid-capability\nvalue",
  ]) {
    await assert.rejects(
      startDevinTransport({
        port: 4318,
        token: "fixture-token",
        dataDir: "/fixture/private-state",
        defaultModel: "swe-1-6-slow",
        internalCapability: value,
        reconcile: () => {
          reconciled = true;
          return { removed: 0 };
        },
      }),
      /Internal Devin capability must be/,
    );
  }
  assert.equal(reconciled, false);
});

test("pinned upstream policy blocks retain counts without retaining raw samples", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "devin-policy-privacy-"));
  const placeholder = "placeholder-system-prompt-that-must-not-persist";
  const script = `
    const { recordPolicyBlocked, exportStats } = await import("windsurf-api/src/dashboard/stats.js");
    recordPolicyBlocked({
      ts: Date.now(),
      model: "fixture-model",
      promptHash: "fixture-hash",
      promptSample: ${JSON.stringify("placeholder-system-prompt-that-must-not-persist")},
    });
    const state = exportStats();
    if (state.policyBlockedCount !== 1 || state.recentPolicyBlocks.length !== 0) process.exit(2);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      HOME: dataDir,
      PATH: process.env.PATH ?? "",
      TMPDIR: tmpdir(),
      DATA_DIR: dataDir,
      POLICY_BLOCK_RING: "-1",
      WINDSURFAPI_SKIP_DOTENV: "1",
    },
    timeout: 10_000,
  });

  assert.equal(result.status, 0, result.stderr);
  const persisted = readFileSync(join(dataDir, "stats.json"), "utf8");
  assert.doesNotMatch(persisted, new RegExp(placeholder));
  assert.equal(JSON.parse(persisted).policyBlockedCount, 1);
  assert.deepEqual(JSON.parse(persisted).recentPolicyBlocks, []);
});
