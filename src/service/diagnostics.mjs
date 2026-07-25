import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseTomlString } from "../core/devin-credentials.mjs";
import { providerModels, supportedModels } from "../core/providers.mjs";
import { readinessPath } from "../core/readiness.mjs";
import { probeOfficialGrokCLI } from "../spike/grok-auth.mjs";

const GROK_OIDC_SCOPE =
  "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";

function canonicalPort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return String(port);
}

export function resolveDiagnosticPaths({ env = process.env } = {}) {
  const home = resolve(env.HOME || homedir());
  const dataDir = resolve(
    env.LLM_GATEWAY_DATA_DIR ||
      join(home, ".local", "share", "llm-gateway"),
  );
  const grokHome = resolve(env.GROK_HOME || join(home, ".grok"));
  const port = canonicalPort(
    env.LLM_GATEWAY_PORT ?? "4317",
    "LLM_GATEWAY_PORT",
  );
  return {
    home,
    dataDir,
    port,
    devinCredentials: resolve(
      env.DEVIN_CREDENTIALS_FILE ||
        join(home, ".local", "share", "devin", "credentials.toml"),
    ),
    grokHome,
    grokCredentials: join(grokHome, "auth.json"),
    serviceLog: join(dataDir, "gateway.log"),
    modelsUrl:
      env.LLM_GATEWAY_MODELS_URL ||
      `http://127.0.0.1:${port}/openai/v1/models`,
  };
}

const result = (name, status, message) => ({ name, status, message });
const pass = (name, message) => result(name, "pass", message);
const fail = (name, message) => result(name, "fail", message);
const skip = (name, message) => result(name, "skip", message);

async function readRegularFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("not_regular");
  return { metadata, source: await readFile(path, "utf8") };
}

function findDevinCLI({ env = process.env } = {}) {
  const candidates = [
    env.DEVIN_CLI,
    join(env.HOME || homedir(), ".local", "bin", "devin"),
    "/opt/homebrew/bin/devin",
    "/usr/local/bin/devin",
    ...(env.PATH || "").split(":").filter(Boolean).map((dir) => join(dir, "devin")),
  ].filter(Boolean);
  for (const path of new Set(candidates)) {
    try {
      accessSync(path, constants.X_OK);
    } catch {
      continue;
    }
    const version = spawnSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const text = `${version.stdout || ""}${version.stderr || ""}`.trim();
    if (version.status !== 0 || !text.toLowerCase().startsWith("devin ")) continue;
    const auth = spawnSync(path, ["auth", "status"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const authOutput = `${auth.stdout || ""}\n${auth.stderr || ""}`.trim();
    if (auth.error?.code === "ETIMEDOUT" || auth.signal) {
      return {
        path,
        version: text,
        authState: "error",
        authError: "`devin auth status` timed out or was terminated",
      };
    }
    if (auth.status === 0 && /logged in/i.test(authOutput)) {
      return { path, version: text, authState: "authenticated" };
    }
    if (
      auth.status === 0 &&
      /(not logged in|not authenticated|logged out|auth login)/i.test(authOutput)
    ) {
      return { path, version: text, authState: "signed_out" };
    }
    return {
      path,
      version: text,
      authState: "error",
      authError:
        `\`devin auth status\` failed (exit ${auth.status ?? "unknown"}): ` +
        (authOutput || "no output"),
    };
  }
  return null;
}

async function checkDevinCLI(env, cliCheck) {
  const name = "Official Devin CLI";
  const cli = cliCheck ? await cliCheck({ env }) : findDevinCLI({ env });
  if (!cli) {
    return fail(name, "official Devin CLI not found; see https://docs.devin.ai/cli/quickstart");
  }
  const authState =
    cli.authState ??
    (cli.authenticated === false ? "signed_out" : "authenticated");
  if (authState === "signed_out") {
    return fail(name, `${cli.version} is installed but signed out; run \`devin auth login\``);
  }
  if (authState !== "authenticated") {
    return fail(name, cli.authError || "could not determine Devin authentication status");
  }
  return pass(name, `${cli.version} at ${cli.path}`);
}

async function checkGrokCLI(env, cliCheck) {
  const name = "Official Grok CLI";
  const probe = cliCheck
    ? await cliCheck({ env })
    : probeOfficialGrokCLI({ env });
  if (!probe) {
    return fail(name, "official Grok CLI not found; install `@xai-official/grok`");
  }
  if (probe.path && probe.version) {
    return pass(name, `${probe.version} at ${probe.path}`);
  }
  if (!probe.cli?.found) {
    return fail(name, "official Grok CLI not found; install `@xai-official/grok`");
  }
  if (!probe.models?.discovered) {
    return fail(name, "model discovery failed; run `grok login`");
  }
  if (!providerModels.grok.every((id) => probe.models.ids.includes(id))) {
    return fail(
      name,
      `xAI OAuth account does not list required model: ${providerModels.grok.join(", ")}`,
    );
  }
  return pass(
    name,
    `grok ${probe.cli.version} at ${probe.cli.path}; models: ${probe.models.ids.join(", ")}`,
  );
}

async function checkDevinCredentials(path) {
  const name = "Devin authentication";
  try {
    const { metadata, source } = await readRegularFile(path);
    const mode = metadata.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return fail(name, `${path} has unsafe mode ${mode.toString(8).padStart(3, "0")}`);
    }
    if (!parseTomlString(source, "windsurf_api_key")?.trim()) {
      return fail(name, `credential is missing in ${path}`);
    }
    return pass(name, `authenticated credential found at ${path}`);
  } catch {
    return fail(name, `run \`devin auth login\`; no valid credential found at ${path}`);
  }
}

async function checkGrokCredentials(paths) {
  const name = "Grok authentication";
  try {
    const home = await lstat(paths.grokHome);
    if (!home.isDirectory() || home.isSymbolicLink()) {
      return fail(name, `${paths.grokHome} must be a regular directory`);
    }
    const homeMode = home.mode & 0o777;
    if ((homeMode & 0o077) !== 0) {
      return fail(
        name,
        `${paths.grokHome} has unsafe mode ${homeMode.toString(8).padStart(3, "0")}`,
      );
    }
    const { metadata, source } = await readRegularFile(paths.grokCredentials);
    const mode = metadata.mode & 0o777;
    if (mode !== 0o600) {
      return fail(
        name,
        `${paths.grokCredentials} has unsafe mode ${mode.toString(8).padStart(3, "0")}`,
      );
    }
    const document = JSON.parse(source);
    if (typeof document?.[GROK_OIDC_SCOPE]?.key !== "string") {
      return fail(name, `xAI OIDC session is missing in ${paths.grokCredentials}`);
    }
    return pass(name, `official CLI session found at ${paths.grokCredentials}`);
  } catch {
    return fail(
      name,
      `run \`grok login\`; no valid official CLI session found at ${paths.grokCredentials}`,
    );
  }
}

async function checkDataState(paths) {
  const name = "Gateway data";
  try {
    const directory = await lstat(paths.dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      return fail(name, `${paths.dataDir} must be a regular directory`);
    }
    const mode = directory.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return fail(name, `${paths.dataDir} has unsafe mode ${mode.toString(8).padStart(3, "0")}`);
    }
    try {
      const log = await lstat(paths.serviceLog);
      if (!log.isFile() || (log.mode & 0o777) !== 0o600) {
        return fail(name, `${paths.serviceLog} must be a mode-600 file`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return pass(name, `private gateway state found at ${paths.dataDir}`);
  } catch {
    return fail(name, `gateway state has not been created under ${paths.dataDir}`);
  }
}

async function checkEndpoint({ live, paths, fetchImpl }) {
  if (!live) {
    return [
      skip("Local endpoint", "not requested; rerun with --live"),
      skip("Local Devin transport", "not requested; rerun with --live"),
      skip("Local Grok transport", "not requested; rerun with --live"),
    ];
  }
  try {
    const target = new URL(paths.modelsUrl);
    if (
      target.protocol !== "http:" ||
      target.hostname !== "127.0.0.1" ||
      target.pathname !== "/openai/v1/models" ||
      target.username ||
      target.password
    ) {
      return [
        fail("Local endpoint", "refusing to probe a non-loopback endpoint"),
        skip("Local Devin transport", "endpoint identity was not verified"),
        skip("Local Grok transport", "endpoint identity was not verified"),
      ];
    }
    const readiness = new URL(readinessPath, target);
    const challenge = await fetchImpl(readiness, {
      signal: AbortSignal.timeout(5_000),
    });
    const readinessBody = await challenge.json().catch(() => null);
    if (
      challenge.headers.get("x-llm-gateway") !== "1" ||
      typeof readinessBody?.ready !== "boolean"
    ) {
      return [
        fail("Local endpoint", "loopback listener did not identify itself as llm-gateway"),
        skip("Local Devin transport", "endpoint identity was not verified"),
        skip("Local Grok transport", "endpoint identity was not verified"),
      ];
    }
    const response = await fetchImpl(target, {
      signal: AbortSignal.timeout(5_000),
    });
    const body = response.ok ? await response.json() : null;
    const ids = Array.isArray(body?.data) ? body.data.map(({ id }) => id) : [];
    const missing = supportedModels.filter((id) => !ids.includes(id));
    if (missing.length > 0) {
      return [
        fail("Local endpoint", `OpenAI endpoint is missing models: ${missing.join(", ")}`),
        skip("Local Devin transport", "model discovery failed"),
        skip("Local Grok transport", "model discovery failed"),
      ];
    }
    const claudeTarget = new URL("/claude/v1/models", target);
    const claudeResponse = await fetchImpl(claudeTarget, {
      signal: AbortSignal.timeout(5_000),
    });
    const claudeBody = claudeResponse.ok ? await claudeResponse.json() : null;
    const claudeIds = Array.isArray(claudeBody?.data)
      ? claudeBody.data.map(({ id }) => id)
      : [];
    const claudeMissing = supportedModels.filter((id) => !claudeIds.includes(id));
    const endpoint = claudeMissing.length === 0
      ? pass(
          "Local endpoint",
          `OpenAI and Claude model discovery are available on 127.0.0.1:${paths.port}`,
        )
      : fail(
          "Local endpoint",
          `Claude endpoint is missing models: ${claudeMissing.join(", ")}`,
        );
    return [
      endpoint,
      readinessBody.providers?.devin?.ready
        ? pass("Local Devin transport", "ready")
        : fail("Local Devin transport", "not ready"),
      readinessBody.providers?.grok?.ready
        ? pass("Local Grok transport", "ready")
        : fail("Local Grok transport", "not ready"),
    ];
  } catch {
    return [
      fail("Local endpoint", `cannot reach ${paths.modelsUrl}`),
      skip("Local Devin transport", "endpoint is unavailable"),
      skip("Local Grok transport", "endpoint is unavailable"),
    ];
  }
}

export async function runDiagnostics({
  env = process.env,
  live = false,
  fetchImpl = fetch,
  cliChecks = {},
} = {}) {
  const paths = resolveDiagnosticPaths({ env });
  const [devinCLI, devinCredentials, grokCLI, grokCredentials, data] =
    await Promise.all([
      checkDevinCLI(env, cliChecks.devin),
      checkDevinCredentials(paths.devinCredentials),
      checkGrokCLI(env, cliChecks.grok),
      checkGrokCredentials(paths),
      checkDataState(paths),
    ]);
  const endpointChecks = await checkEndpoint({ live, paths, fetchImpl });
  const checks = [
    devinCLI,
    devinCredentials,
    grokCLI,
    grokCredentials,
    data,
    ...endpointChecks,
  ];
  const summary = {
    passed: checks.filter(({ status }) => status === "pass").length,
    failed: checks.filter(({ status }) => status === "fail").length,
    skipped: checks.filter(({ status }) => status === "skip").length,
  };
  return { ok: summary.failed === 0, checks, summary };
}

export function formatDiagnosticReport(report) {
  return [
    ...report.checks.map(({ status, name, message }) =>
      `${status.toUpperCase()} ${name}: ${message}`),
    `Summary: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped.`,
  ].join("\n");
}
