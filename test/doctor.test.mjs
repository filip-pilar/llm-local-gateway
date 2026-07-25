import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatDiagnosticReport,
  runDiagnostics,
} from "../src/service/diagnostics.mjs";
import { supportedModels } from "../src/core/providers.mjs";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "llm-gateway-doctor-"));
  const dataDir = join(home, ".local", "share", "llm-gateway");
  const devinCredentials = join(
    home,
    ".local",
    "share",
    "devin",
    "credentials.toml",
  );
  const grokHome = join(home, ".grok");
  const grokCredentials = join(grokHome, "auth.json");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".local", "share", "devin"), {
    recursive: true,
    mode: 0o700,
  });
  mkdirSync(grokHome, { recursive: true, mode: 0o700 });
  writeFileSync(
    devinCredentials,
    'windsurf_api_key = "fixture-devin-token"\n',
    { mode: 0o600 },
  );
  writeFileSync(grokCredentials, JSON.stringify({
    "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
      key: "fixture-grok-token",
    },
  }), { mode: 0o600 });
  return {
    home,
    dataDir,
    devinCredentials,
    grokCredentials,
    env: { HOME: home, LLM_GATEWAY_DATA_DIR: dataDir },
  };
}

const cliChecks = {
  devin: async () => ({
    path: "/fixture/devin",
    version: "devin 1.2.3",
    authState: "authenticated",
  }),
  grok: async () => ({
    path: "/fixture/grok",
    version: "grok 0.2.111",
  }),
};

function find(report, name) {
  return report.checks.find((check) => check.name === name);
}

test("status validates both provider authentications and private gateway state", async () => {
  const value = fixture();
  const report = await runDiagnostics({ env: value.env, cliChecks });
  assert.equal(report.ok, true);
  assert.equal(find(report, "Official Devin CLI").status, "pass");
  assert.equal(find(report, "Devin authentication").status, "pass");
  assert.equal(find(report, "Official Grok CLI").status, "pass");
  assert.equal(find(report, "Grok authentication").status, "pass");
  assert.equal(find(report, "Gateway data").status, "pass");
  assert.equal(find(report, "Local endpoint").status, "skip");
  assert.match(formatDiagnosticReport(report), /5 passed, 0 failed, 3 skipped/);
});

test("live status checks model discovery and each provider readiness", async () => {
  const value = fixture();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    calls.push({ target, options });
    if (target.pathname === "/__llm_gateway/readiness") {
      return new Response(JSON.stringify({
        ready: true,
        default_model: "swe-1-6-slow",
        providers: {
          devin: { ready: true },
          grok: { ready: true },
        },
      }), {
        status: 200,
        headers: { "x-llm-gateway": "1" },
      });
    }
    return new Response(JSON.stringify({
      object: "list",
      data: supportedModels.map((id) => ({ id })),
    }), { status: 200 });
  };
  const report = await runDiagnostics({
    env: value.env,
    live: true,
    fetchImpl,
    cliChecks,
  });
  assert.equal(report.ok, true);
  assert.equal(find(report, "Local endpoint").status, "pass");
  assert.equal(find(report, "Local Devin transport").status, "pass");
  assert.equal(find(report, "Local Grok transport").status, "pass");
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(calls[2].target.pathname, "/claude/v1/models");
});

test("live status reports provider readiness independently", async () => {
  const value = fixture();
  const fetchImpl = async (url) => {
    const target = new URL(url);
    if (target.pathname === "/__llm_gateway/readiness") {
      return new Response(JSON.stringify({
        ready: true,
        providers: {
          devin: { ready: false },
          grok: { ready: true },
        },
      }), {
        status: 200,
        headers: { "x-llm-gateway": "1" },
      });
    }
    return new Response(JSON.stringify({
      data: supportedModels.map((id) => ({ id })),
    }), { status: 200 });
  };
  const report = await runDiagnostics({
    env: value.env,
    live: true,
    fetchImpl,
    cliChecks,
  });
  assert.equal(find(report, "Local Devin transport").status, "fail");
  assert.equal(find(report, "Local Grok transport").status, "pass");
});

test("live status refuses to probe outside loopback", async () => {
  const value = fixture();
  let called = false;
  const report = await runDiagnostics({
    env: {
      ...value.env,
      LLM_GATEWAY_MODELS_URL: "https://example.com/openai/v1/models",
    },
    live: true,
    cliChecks,
    fetchImpl: async () => {
      called = true;
      throw new Error("must not fetch");
    },
  });
  assert.equal(find(report, "Local endpoint").status, "fail");
  assert.equal(called, false);
});

test("status rejects unsafe provider credential permissions without exposing secrets", async () => {
  const value = fixture();
  chmodSync(value.devinCredentials, 0o644);
  chmodSync(value.grokCredentials, 0o644);
  const report = await runDiagnostics({ env: value.env, cliChecks });
  assert.equal(find(report, "Devin authentication").status, "fail");
  assert.equal(find(report, "Grok authentication").status, "fail");
  assert.doesNotMatch(
    JSON.stringify(report),
    /fixture-devin-token|fixture-grok-token/,
  );
});

test("status reports each missing official provider CLI", async () => {
  const value = fixture();
  const report = await runDiagnostics({
    env: value.env,
    cliChecks: {
      devin: async () => null,
      grok: async () => null,
    },
  });
  assert.match(find(report, "Official Devin CLI").message, /not found/);
  assert.match(find(report, "Official Grok CLI").message, /not found/);
});

test("status reports failed Grok model discovery without exposing command output", async () => {
  const value = fixture();
  const report = await runDiagnostics({
    env: value.env,
    cliChecks: {
      ...cliChecks,
      grok: async () => ({
        cli: { found: true, path: "/fixture/grok", version: "0.2.111" },
        models: { discovered: false, ids: [] },
      }),
    },
  });
  assert.match(find(report, "Official Grok CLI").message, /grok login/);
});

test("status reports a missing entitled Grok model", async () => {
  const value = fixture();
  const report = await runDiagnostics({
    env: value.env,
    cliChecks: {
      ...cliChecks,
      grok: async () => ({
        cli: { found: true, path: "/fixture/grok", version: "0.2.111" },
        models: { discovered: true, ids: ["grok-other"] },
      }),
    },
  });
  assert.match(
    find(report, "Official Grok CLI").message,
    /does not list required model/,
  );
});
