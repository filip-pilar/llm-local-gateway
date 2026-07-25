import assert from "node:assert/strict";
import test from "node:test";
import {
  formatGrokAuthProbe,
  parseGrokModelIds,
  probeOfficialGrokCLI,
} from "../src/spike/grok-auth.mjs";

test("extracts only model-id-shaped values from Grok model discovery", () => {
  assert.deepEqual(
    parseGrokModelIds([
      "\u001b[32mGrok 4.5\u001b[0m  grok-4.5",
      "alias: grok-build-latest",
      "duplicate: GROK-4.5",
      "not a model: xai-secret-value",
    ].join("\n")),
    ["grok-4.5", "grok-build-latest"],
  );
});

test("reports a missing CLI without reading credentials or running commands", () => {
  let called = false;
  const report = probeOfficialGrokCLI({
    env: { HOME: "/fixture", PATH: "" },
    paths: ["/fixture/.grok/bin/grok"],
    isExecutable: () => false,
    run: () => {
      called = true;
      throw new Error("must not run");
    },
  });

  assert.equal(called, false);
  assert.equal(report.status, "cli_missing");
  assert.equal(report.oauth_verified, false);
  assert.doesNotMatch(JSON.stringify(report), /auth\.json|access_token|refresh_token/);
});

test("discovers target models through the official CLI without shell API keys", () => {
  const calls = [];
  const report = probeOfficialGrokCLI({
    env: {
      HOME: "/fixture",
      PATH: "/fixture/bin",
      XAI_API_KEY: "must-not-reach-child",
      GROK_API_KEY: "must-not-reach-child",
    },
    paths: ["/fixture/bin/grok"],
    isExecutable: () => true,
    run: (path, args, env) => {
      calls.push({ path, args, env });
      if (args[0] === "version") {
        return { status: 0, stdout: "grok 0.2.111\n", stderr: "" };
      }
      return {
        status: 0,
        stdout: "Grok 4.5  grok-4.5\nGrok Build  grok-build-latest\n",
        stderr: "",
      };
    },
  });

  assert.equal(report.status, "ready_for_live_verification");
  assert.equal(report.ready_for_live_verification, true);
  assert.equal(report.oauth_verified, false);
  assert.equal(report.subscription_entitlement_verified, false);
  assert.deepEqual(report.models.ids, ["grok-4.5", "grok-build-latest"]);
  assert.deepEqual(calls[1].args, ["--no-auto-update", "models"]);
  assert.equal(calls[1].env.XAI_API_KEY, undefined);
  assert.equal(calls[1].env.GROK_API_KEY, undefined);
});

test("never returns or formats raw command errors", () => {
  const secret = "refresh-token-that-must-not-escape";
  const report = probeOfficialGrokCLI({
    env: { HOME: "/fixture", PATH: "" },
    paths: ["/fixture/grok"],
    isExecutable: () => true,
    run: (_path, args) => args[0] === "version"
      ? { status: 0, stdout: "grok 0.2.111\n", stderr: "" }
      : { status: 1, stdout: "", stderr: secret },
  });
  const rendered = `${JSON.stringify(report)}\n${formatGrokAuthProbe(report)}`;

  assert.equal(report.reason, "command_failed");
  assert.doesNotMatch(rendered, new RegExp(secret));
});
