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
  const dir = mkdtempSync(join(tmpdir(), "llm-local-gateway-devin-credential-"));
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

test("Grok OAuth refresh stays owned by the official CLI and isolates its environment", async () => {
  const secret = "refresh-token-that-must-not-escape";
  let call;
  await refreshGrokOAuthSession({
    cliPath: "/fixture/grok",
    env: {
      HOME: "/fixture/home",
      GROK_HOME: "/fixture/grok-home",
      PATH: "/fixture/bin",
      API_KEY: secret,
      XAI_API_KEY: secret,
      GROK_API_KEY: secret,
      CODEIUM_API_KEY: "placeholder-devin",
      DASHBOARD_PASSWORD: "placeholder-dashboard",
      DEVIN_CONNECT: "1",
      WINDSURFAPI_TRACE: "1",
      WINDSURF_TRACE: "1",
      POLICY_BLOCK_SAMPLE: "raw-policy-sample",
      ASTRAFLOW_STATE: "provider-state",
      DEBUG_REQUEST_BODIES: "1",
    },
    run: (path, args, options, callback) => {
      call = { path, args, options };
      queueMicrotask(() => callback(null, secret, secret));
    },
  });
  assert.equal(call.path, "/fixture/grok");
  assert.deepEqual(call.args, ["--no-auto-update", "models"]);
  assert.equal(call.options.env.HOME, "/fixture/home");
  assert.equal(call.options.env.GROK_HOME, "/fixture/grok-home");
  assert.equal(call.options.env.PATH, "/fixture/bin");
  assert.equal(call.options.env.API_KEY, undefined);
  assert.equal(call.options.env.XAI_API_KEY, undefined);
  assert.equal(call.options.env.GROK_API_KEY, undefined);
  assert.equal(call.options.env.CODEIUM_API_KEY, undefined);
  assert.equal(call.options.env.DASHBOARD_PASSWORD, undefined);
  assert.equal(call.options.env.DEVIN_CONNECT, undefined);
  assert.equal(call.options.env.WINDSURFAPI_TRACE, undefined);
  assert.equal(call.options.env.WINDSURF_TRACE, undefined);
  assert.equal(call.options.env.POLICY_BLOCK_SAMPLE, undefined);
  assert.equal(call.options.env.ASTRAFLOW_STATE, undefined);
  assert.equal(call.options.env.DEBUG_REQUEST_BODIES, undefined);

  await assert.rejects(
    refreshGrokOAuthSession({
      cliPath: "/fixture/grok",
      run: (_path, _args, _options, callback) => {
        queueMicrotask(() => callback(Object.assign(new Error(secret), { code: 1 })));
      },
    }),
    (error) => !error.message.includes(secret),
  );
});

test("Grok OAuth refresh does not block the event loop", async () => {
  let childFinished = false;
  const refresh = refreshGrokOAuthSession({
    cliPath: "/fixture/grok",
    run: (_path, _args, _options, callback) => {
      setTimeout(() => {
        childFinished = true;
        callback(null, "", "");
      }, 25);
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(childFinished, false);
  await refresh;
  assert.equal(childFinished, true);
});

test("accepts only a recognizable official Grok CLI version", () => {
  let versionEnvironment;
  assert.equal(readGrokCLIVersion({
    cliPath: "/fixture/grok",
    env: {
      HOME: "/fixture/home",
      CODEIUM_API_KEY: "placeholder-devin",
      DASHBOARD_PASSWORD: "placeholder-dashboard",
      POLICY_BLOCK_SAMPLE: "raw-policy-sample",
    },
    run: (_path, _args, options) => {
      versionEnvironment = options.env;
      return { status: 0, stdout: "grok 0.2.111 (fixture)\n" };
    },
  }), "0.2.111");
  assert.equal(versionEnvironment.HOME, "/fixture/home");
  assert.equal(versionEnvironment.CODEIUM_API_KEY, undefined);
  assert.equal(versionEnvironment.DASHBOARD_PASSWORD, undefined);
  assert.equal(versionEnvironment.POLICY_BLOCK_SAMPLE, undefined);
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
