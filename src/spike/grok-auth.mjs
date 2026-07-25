import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const TARGET_MODELS = Object.freeze([
  "grok-4.5",
  "grok-4.5-latest",
  "grok-build-latest",
  "grok-build",
]);
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

function commandEnvironment(env) {
  const clean = { ...env };
  // This spike is specifically for subscription-backed OAuth. Do not let a
  // convenient shell API key silently turn it into an API-key probe.
  delete clean.XAI_API_KEY;
  delete clean.GROK_API_KEY;
  return clean;
}

function defaultRunner(path, args, env) {
  return spawnSync(path, args, {
    encoding: "utf8",
    env,
    timeout: 15_000,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    windowsHide: true,
  });
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidatePaths(env) {
  const home = resolve(env.HOME || homedir());
  const grokHome = resolve(env.GROK_HOME || join(home, ".grok"));
  return [
    env.GROK_CLI,
    join(grokHome, "bin", "grok"),
    join(home, ".local", "bin", "grok"),
    "/opt/homebrew/bin/grok",
    "/usr/local/bin/grok",
    ...(env.PATH || "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, "grok")),
  ].filter(Boolean);
}

function parseVersion(output) {
  const text = String(output || "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const match = text.match(
    /(?:^|\b)grok(?:\s+version)?\s+v?(\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)(?:\b|$)/i,
  ) || text.trim().match(/^v?(\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)$/i);
  return match?.[1] ?? null;
}

export function parseGrokModelIds(output) {
  const text = String(output || "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const matches = text.match(/\bgrok-[a-z0-9][a-z0-9.-]{0,126}\b/gi) ?? [];
  return [...new Set(matches.map((value) => value.toLowerCase()))].sort();
}

function commandFailure(result) {
  if (result?.error?.code === "ETIMEDOUT" || result?.signal) return "command_terminated";
  if (result?.error?.code === "ENOBUFS") return "output_limit_exceeded";
  return "command_failed";
}

export function probeOfficialGrokCLI({
  env = process.env,
  paths = candidatePaths(env),
  isExecutable = executable,
  run = defaultRunner,
} = {}) {
  const safeEnv = commandEnvironment(env);
  let cli = null;

  for (const path of new Set(paths)) {
    if (!isExecutable(path)) continue;
    const versionResult = run(path, ["version"], safeEnv);
    const version = versionResult?.status === 0
      ? parseVersion(versionResult.stdout)
      : null;
    if (version) {
      cli = { path: resolve(path), version };
      break;
    }
  }

  if (!cli) {
    return {
      status: "cli_missing",
      ready_for_live_verification: false,
      oauth_verified: false,
      subscription_entitlement_verified: false,
      cli: { found: false },
      models: { discovered: false, ids: [] },
      target: { accessible: false, accepted_ids: TARGET_MODELS },
    };
  }

  const modelsResult = run(
    cli.path,
    ["--no-auto-update", "models"],
    safeEnv,
  );
  if (modelsResult?.status !== 0) {
    return {
      status: "model_discovery_failed",
      reason: commandFailure(modelsResult),
      ready_for_live_verification: false,
      oauth_verified: false,
      subscription_entitlement_verified: false,
      cli: { found: true, ...cli },
      models: { discovered: false, ids: [] },
      target: { accessible: false, accepted_ids: TARGET_MODELS },
    };
  }

  const ids = parseGrokModelIds(modelsResult.stdout);
  const matched = TARGET_MODELS.filter((id) => ids.includes(id));
  const accessible = matched.length > 0;
  return {
    status: accessible
      ? "ready_for_live_verification"
      : "target_model_unavailable",
    ready_for_live_verification: accessible,
    // `grok models` is credential-opaque discovery, not proof that a generation
    // used OAuth or that the subscription has inference quota.
    oauth_verified: false,
    subscription_entitlement_verified: false,
    cli: { found: true, ...cli },
    models: { discovered: true, ids },
    target: {
      accessible,
      accepted_ids: TARGET_MODELS,
      matched_ids: matched,
    },
  };
}

export function formatGrokAuthProbe(report) {
  if (!report.cli.found) {
    return [
      "FAIL Official Grok CLI: not found.",
      "Install it from https://x.ai/cli, then run `grok login`.",
      "No credential files were read.",
    ].join("\n");
  }
  if (!report.models.discovered) {
    return [
      `PASS Official Grok CLI: grok ${report.cli.version} at ${report.cli.path}`,
      "FAIL Model discovery: `grok models` did not complete.",
      "Run `grok login`; no command output or credential material was retained.",
    ].join("\n");
  }
  return [
    `PASS Official Grok CLI: grok ${report.cli.version} at ${report.cli.path}`,
    `PASS Model discovery: ${report.models.ids.join(", ") || "no model IDs returned"}`,
    report.target.accessible
      ? `PASS Target candidate: ${report.target.matched_ids.join(", ")}`
      : "FAIL Target candidate: Grok 4.5 / Grok Build was not listed.",
    "PENDING OAuth entitlement: model discovery does not consume quota or prove inference.",
  ].join("\n");
}
