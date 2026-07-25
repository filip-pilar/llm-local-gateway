import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const commands = [
  "llm-gateway.mjs",
  "doctor.mjs",
  "smoke.mjs",
];

test("every public CLI exposes a side-effect-free help path", () => {
  for (const command of commands) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(`../bin/${command}`, import.meta.url)), "--help"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.match(result.stdout, /^Usage:/, command);
    assert.equal(result.stderr, "", command);
  }
});

test("serve CLI rejects an invalid custom port before reading authentication", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../bin/llm-gateway.mjs", import.meta.url)),
      "serve",
      "--port",
      "0",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid LLM_GATEWAY_PORT: 0/);
});

test("smoke rejects invalid network settings before reading bridge state", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../bin/smoke.mjs", import.meta.url))],
    {
      encoding: "utf8",
      env: { ...process.env, LLM_GATEWAY_PORT: "0" },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid LLM_GATEWAY_PORT: 0/);
});

test("unified CLI rejects unknown commands without side effects", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../bin/llm-gateway.mjs", import.meta.url)), "not-a-command"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: not-a-command/);
});

test("the obsolete endpoint key command is not available", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../bin/llm-gateway.mjs", import.meta.url)), "key"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: key/);
});
