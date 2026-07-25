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
  parseTomlString,
  readDevinSessionToken,
} from "../src/core/devin-credentials.mjs";
import {
  readGrokAccessToken,
  readGrokCLIVersion,
  refreshGrokOAuthSession,
} from "../src/core/grok-credentials.mjs";
import {
  ensurePrivateDirectory,
  removeLegacyGatewayKey,
} from "../src/core/private-state.mjs";

test("parses the official Devin credential key without exposing unrelated values", () => {
  const source = [
    'windsurf_api_key = "devin-session-token$abc123"',
    'api_server_url = "https://server.codeium.com"',
  ].join("\n");

  assert.equal(
    parseTomlString(source, "windsurf_api_key"),
    "devin-session-token$abc123",
  );
  assert.equal(parseTomlString(source, "missing"), null);
  assert.equal(
    parseTomlString(
      "  windsurf_api_key = 'literal-token' # current login\n",
      "windsurf_api_key",
    ),
    "literal-token",
  );
});

test("Devin credential reads repair permissions and reject symbolic links", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-gateway-devin-credential-"));
  const credentials = join(dir, "credentials.toml");
  const link = join(dir, "linked-credentials.toml");
  writeFileSync(credentials, 'windsurf_api_key = "secret-token"\n', {
    mode: 0o644,
  });

  assert.equal(readDevinSessionToken(credentials), "secret-token");
  assert.equal(statSync(credentials).mode & 0o777, 0o600);
  symlinkSync(credentials, link);
  assert.throws(() => readDevinSessionToken(link), /Cannot securely read/);
});

test("Grok OAuth reads repair permissions and reject symbolic links", () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-bridge-oauth-security-"));
  const credentials = join(dir, "auth.json");
  const link = join(dir, "linked-auth.json");
  const token = "opaque-access-token";
  writeFileSync(credentials, JSON.stringify({
    "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
      key: token,
    },
  }), { mode: 0o644 });

  assert.equal(readGrokAccessToken(credentials), token);
  assert.equal(statSync(credentials).mode & 0o777, 0o600);
  symlinkSync(credentials, link);
  assert.throws(() => readGrokAccessToken(link), /Cannot securely read/);
});

test("Grok OAuth refresh stays owned by the official CLI and redacts failures", () => {
  const secret = "refresh-token-that-must-not-escape";
  let call;
  refreshGrokOAuthSession({
    cliPath: "/fixture/grok",
    env: { XAI_API_KEY: secret, GROK_API_KEY: secret },
    run: (path, args, options) => {
      call = { path, args, options };
      return { status: 0, stdout: secret, stderr: secret };
    },
  });
  assert.equal(call.path, "/fixture/grok");
  assert.deepEqual(call.args, ["--no-auto-update", "models"]);
  assert.equal(call.options.env.XAI_API_KEY, undefined);
  assert.equal(call.options.env.GROK_API_KEY, undefined);

  assert.throws(
    () => refreshGrokOAuthSession({
      cliPath: "/fixture/grok",
      run: () => ({ status: 1, stderr: secret }),
    }),
    (error) => !error.message.includes(secret),
  );
});

test("accepts only a recognizable official Grok CLI version", () => {
  assert.equal(readGrokCLIVersion({
    cliPath: "/fixture/grok",
    run: () => ({ status: 0, stdout: "grok 0.2.111 (fixture)\n" }),
  }), "0.2.111");
  assert.throws(
    () => readGrokCLIVersion({
      cliPath: "/fixture/not-grok",
      run: () => ({ status: 0, stdout: "other 1.0.0\n" }),
    }),
    /not a supported official Grok CLI/,
  );
});

test("runtime enforces a private bridge data directory and rejects symbolic links", () => {
  const root = mkdtempSync(join(tmpdir(), "grok-bridge-data-security-"));
  const privateDir = join(root, "private");
  const outside = join(root, "outside");
  const linked = join(root, "bridge-data");
  mkdirSync(privateDir, { mode: 0o755 });
  mkdirSync(outside, { mode: 0o755 });
  symlinkSync(outside, linked);

  ensurePrivateDirectory(privateDir);
  assert.equal(statSync(privateDir).mode & 0o777, 0o700);
  assert.throws(() => ensurePrivateDirectory(linked), /unsafe bridge data directory/);
  assert.equal(statSync(outside).mode & 0o777, 0o755);
});

test("removes a regular legacy gateway key without following symbolic links", () => {
  const root = mkdtempSync(join(tmpdir(), "grok-bridge-legacy-key-"));
  const regular = join(root, "gateway.key");
  const target = join(root, "outside.txt");
  const linked = join(root, "linked.key");
  writeFileSync(regular, "obsolete\n", { mode: 0o600 });
  writeFileSync(target, "outside\n", { mode: 0o644 });
  symlinkSync(target, linked);

  assert.equal(removeLegacyGatewayKey(regular), true);
  assert.equal(existsSync(regular), false);
  assert.equal(removeLegacyGatewayKey(regular), false);
  assert.throws(() => removeLegacyGatewayKey(linked), /unsafe legacy gateway key/);
  assert.equal(readFileSync(target, "utf8"), "outside\n");
  assert.equal(statSync(target).mode & 0o777, 0o644);
});
