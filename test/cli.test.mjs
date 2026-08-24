import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../bin/llm-local-gateway.mjs", import.meta.url));

test("the public CLI exposes a side-effect-free help path", () => {
  const result = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage:/);
  assert.equal(result.stderr, "");
});

test("serve CLI rejects an invalid custom port before reading authentication", () => {
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "serve",
      "--port",
      "0",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid LLM_LOCAL_GATEWAY_PORT: 0/);
});

test("smoke rejects invalid network settings before reading bridge state", () => {
  const result = spawnSync(
    process.execPath,
    [cliPath, "smoke"],
    {
      encoding: "utf8",
      env: { ...process.env, LLM_LOCAL_GATEWAY_PORT: "0" },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid LLM_LOCAL_GATEWAY_PORT: 0/);
});

test("unified CLI rejects unknown commands without side effects", () => {
  const result = spawnSync(
    process.execPath,
    [cliPath, "not-a-command"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: not-a-command/);
});
