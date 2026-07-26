import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { gatewayEnvironmentValue } from "../core/environment.mjs";
import {
  formatDiagnosticReport,
  runDiagnostics,
} from "../service/diagnostics.mjs";
import { runBridgeProcess } from "../service/bridge.mjs";
import { runDirectSmoke } from "../service/smoke.mjs";

const usage = `Usage: llm-local-gateway <command> [options]

Commands:
  serve                    Run the loopback OpenAI and Claude-compatible gateway
  status                   Check each provider and the local endpoint
  smoke                    Make one real request (consumes provider quota)
  help                     Show this help

Authentication remains owned by the official provider CLIs:
  Devin: run \`devin auth login\`
  Grok:  run \`grok login\`
`;

function parse(options, args) {
  return parseArgs({ args, options, allowPositionals: true, strict: true });
}

function applyCommonEnvironment(values, env = process.env) {
  if (values["data-dir"]) {
    env.LLM_LOCAL_GATEWAY_DATA_DIR = resolve(values["data-dir"]);
  }
  if (values["devin-credentials"]) {
    env.DEVIN_CREDENTIALS_FILE = resolve(values["devin-credentials"]);
  }
  if (values["grok-home"]) env.GROK_HOME = resolve(values["grok-home"]);
  if (values.port) env.LLM_LOCAL_GATEWAY_PORT = values.port;
  if (values["devin-port"]) {
    env.LLM_LOCAL_GATEWAY_DEVIN_PORT = values["devin-port"];
  }
  if (values["grok-port"]) {
    env.LLM_LOCAL_GATEWAY_GROK_PORT = values["grok-port"];
  }
  if (values.model) env.LLM_LOCAL_GATEWAY_MODEL = values.model;
  return env;
}

const commonOptions = {
  "data-dir": { type: "string" },
  "devin-credentials": { type: "string" },
  "grok-home": { type: "string" },
  port: { type: "string" },
  "devin-port": { type: "string" },
  "grok-port": { type: "string" },
  model: { type: "string" },
};

export async function runCli(argv = process.argv.slice(2)) {
  const [command = "help", ...args] = argv;
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage);
    return;
  }
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(usage);
      return;
    case "serve": {
      const { values, positionals } = parse({
        ...commonOptions,
        "parent-lifeline": { type: "boolean" },
      }, args);
      if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
      applyCommonEnvironment(values);
      await runBridgeProcess({ parentLifeline: values["parent-lifeline"] });
      return;
    }
    case "status": {
      const { values, positionals } = parse({
        ...commonOptions,
        live: { type: "boolean" },
        json: { type: "boolean" },
        home: { type: "string" },
      }, args);
      if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
      const env = { ...process.env };
      if (values.home) env.HOME = resolve(values.home);
      applyCommonEnvironment(values, env);
      const report = await runDiagnostics({ env, live: values.live });
      process.stdout.write(values.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${formatDiagnosticReport(report)}\n`);
      if (!report.ok) process.exitCode = 1;
      return;
    }
    case "smoke": {
      const { values, positionals } = parse({
        ...commonOptions,
        "timeout-ms": { type: "string" },
        protocol: { type: "string" },
        json: { type: "boolean" },
      }, args);
      if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
      applyCommonEnvironment(values);
      const result = await runDirectSmoke({
        port: Number(
          values.port ?? gatewayEnvironmentValue(process.env, "PORT") ?? 4317,
        ),
        model:
          values.model ??
          gatewayEnvironmentValue(process.env, "MODEL") ??
          "swe-1-6-slow",
        timeoutMs: Number(
          values["timeout-ms"] ??
          gatewayEnvironmentValue(process.env, "TIMEOUT_MS") ??
          300_000
        ),
        protocol: values.protocol ?? "openai",
      });
      process.stdout.write(values.json
        ? `${JSON.stringify({ ok: true, ...result })}\n`
        : `PASS ${result.model}: ${result.text}\n`);
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

export function formatCliError(error) {
  return error instanceof Error ? error.message : String(error);
}
