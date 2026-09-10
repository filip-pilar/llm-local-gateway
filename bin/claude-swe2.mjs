#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedClaudeEnvironment, swe2LaunchOptions } from "../src/interfaces/claude-swe2.mjs";

let configDir;
try {
  const options = swe2LaunchOptions(process.argv.slice(2), process.env);
  const response = await fetch(`http://127.0.0.1:${options.port}/__llm_local_gateway/readiness`, {
    signal: AbortSignal.timeout(5_000),
  });
  const readiness = await response.json();
  if (response.headers.get("x-llm-local-gateway") !== "1"
      || !readiness.providers?.devin?.ready
      || !readiness.providers.devin.models?.includes(options.model)) {
    throw new Error("Start an updated llm-local-gateway with Devin ready before launching Claude Code.");
  }
  configDir = await mkdtemp(join(tmpdir(), "claude-swe2-"));
  const child = spawn("claude", [
    "--model", options.model,
    "--effort", options.effort,
    "--setting-sources", "",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    ...options.claudeArgs,
  ], {
    stdio: "inherit",
    env: isolatedClaudeEnvironment(process.env, configDir, options),
  });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
} catch (error) {
  console.error(error.cause?.code === "ECONNREFUSED"
    ? "Gateway is not running. Start it with: bun run llm-local-gateway -- serve"
    : error.message);
  process.exitCode = 1;
} finally {
  if (configDir) await rm(configDir, { recursive: true, force: true });
}
