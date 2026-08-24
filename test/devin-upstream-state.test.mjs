import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  reconcileUpstreamAccounts,
  scrubUpstreamPolicySamples,
} from "../src/core/devin-upstream-state.mjs";

test("keeps only the current Devin credential in persisted upstream state", () => {
  const root = mkdtempSync(join(tmpdir(), "devin-bridge-upstream-state-"));
  const dataDir = join(root, "windsurfapi");
  const accountsPath = join(dataDir, "accounts.json");
  mkdirSync(dataDir, { mode: 0o700 });
  writeFileSync(
    accountsPath,
    `${JSON.stringify([
      { apiKey: "old-token", status: "active" },
      { apiKey: "current-token", status: "active", total: 3 },
      { apiKey: "current-token", status: "duplicate" },
      { apiKey: "older-token", status: "error" },
    ])}\n`,
  );
  chmodSync(accountsPath, 0o644);

  const result = reconcileUpstreamAccounts(dataDir, "current-token");
  assert.deepEqual(result, { accountsPath, removed: 3, retained: 1 });
  assert.deepEqual(JSON.parse(readFileSync(accountsPath, "utf8")), [
    { apiKey: "current-token", status: "active", total: 3 },
  ]);
  assert.equal(statSync(accountsPath).mode & 0o777, 0o600);
});

test("fails closed on malformed persisted upstream state", () => {
  const root = mkdtempSync(join(tmpdir(), "devin-bridge-upstream-malformed-"));
  const accountsPath = join(root, "accounts.json");
  writeFileSync(accountsPath, "not-json\n", { mode: 0o600 });

  assert.throws(
    () => reconcileUpstreamAccounts(root, "current-token"),
    /Cannot parse upstream accounts state/,
  );
  assert.equal(readFileSync(accountsPath, "utf8"), "not-json\n");
});

test("creates an empty primary account file before legacy replicas can migrate", () => {
  const root = mkdtempSync(join(tmpdir(), "devin-bridge-upstream-replicas-"));
  const replicaDir = join(root, "replica-legacy");
  const accountsPath = join(root, "accounts.json");
  mkdirSync(replicaDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(replicaDir, "accounts.json"),
    `${JSON.stringify([{ apiKey: "rotated-token", status: "active" }])}\n`,
    { mode: 0o600 },
  );

  const result = reconcileUpstreamAccounts(root, "current-token");

  assert.deepEqual(result, { accountsPath, removed: 0, retained: 0 });
  assert.deepEqual(JSON.parse(readFileSync(accountsPath, "utf8")), []);
  assert.equal(statSync(accountsPath).mode & 0o777, 0o600);
});

test("refuses a symlinked upstream state directory", () => {
  const root = mkdtempSync(join(tmpdir(), "devin-bridge-upstream-state-"));
  const outside = join(root, "outside");
  const linked = join(root, "windsurfapi");
  mkdirSync(outside, { mode: 0o700 });
  symlinkSync(outside, linked, "dir");

  assert.throws(
    () => reconcileUpstreamAccounts(linked, "current-token"),
    /unsafe upstream state directory/,
  );
  assert.equal(existsSync(join(outside, "accounts.json")), false);
});

test("refuses a symlinked upstream accounts file without changing its target", () => {
  const root = mkdtempSync(join(tmpdir(), "devin-bridge-upstream-accounts-"));
  const target = join(root, "outside.json");
  const accountsPath = join(root, "accounts.json");
  writeFileSync(target, "[]\n", { mode: 0o644 });
  symlinkSync(target, accountsPath);

  assert.throws(
    () => reconcileUpstreamAccounts(root, "current-token"),
    /unsafe upstream accounts file/,
  );
  assert.equal(statSync(target).mode & 0o777, 0o644);
  assert.equal(readFileSync(target, "utf8"), "[]\n");
});

test("removes persisted policy samples without changing aggregate stats", () => {
  const root = mkdtempSync(join(tmpdir(), "devin-bridge-upstream-stats-"));
  const statsPath = join(root, "stats.json");
  const placeholder = "placeholder-system-prompt-that-must-not-persist";
  writeFileSync(statsPath, `${JSON.stringify({
    totalRequests: 4,
    policyBlockedCount: 2,
    recentPolicyBlocks: [
      { promptHash: "first", promptSample: placeholder },
      { promptHash: "second", promptSample: "another-placeholder" },
    ],
  })}\n`, { mode: 0o644 });

  assert.deepEqual(scrubUpstreamPolicySamples(root), {
    statsPath,
    removed: 2,
  });
  const persisted = readFileSync(statsPath, "utf8");
  assert.doesNotMatch(persisted, new RegExp(placeholder));
  assert.deepEqual(JSON.parse(persisted), {
    totalRequests: 4,
    policyBlockedCount: 2,
    recentPolicyBlocks: [],
  });
  assert.equal(statSync(statsPath).mode & 0o777, 0o600);
});

test("refuses a symlinked upstream stats file without changing its target", () => {
  const root = mkdtempSync(join(tmpdir(), "devin-bridge-upstream-stats-link-"));
  const target = join(root, "outside.json");
  const statsPath = join(root, "stats.json");
  const source = JSON.stringify({
    recentPolicyBlocks: [{ promptSample: "placeholder-secret" }],
  });
  writeFileSync(target, source, { mode: 0o644 });
  symlinkSync(target, statsPath);

  assert.throws(
    () => scrubUpstreamPolicySamples(root),
    /unsafe upstream stats file/,
  );
  assert.equal(readFileSync(target, "utf8"), source);
  assert.equal(statSync(target).mode & 0o777, 0o644);
});
