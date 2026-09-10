export function swe2LaunchOptions(args, env) {
  const [effort = "medium", ...claudeArgs] = args;
  if (!["medium", "high", "max"].includes(effort)) {
    throw new Error("Usage: node bin/claude-swe2.mjs [medium|high|max] [Claude Code arguments]");
  }
  // These options would override the launcher's selected model or isolation.
  const reserved = ["--model", "--effort", "--fallback-model", "--settings", "--setting-sources", "--plugin-dir", "--mcp-config"];
  if (claudeArgs.some((arg) => reserved.some((key) => arg === key || arg.startsWith(`${key}=`)))) {
    throw new Error("Model, effort, settings, plugins, and MCP configuration are owned by this isolated launcher.");
  }
  const port = Number(env.LLM_LOCAL_GATEWAY_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid LLM_LOCAL_GATEWAY_PORT");
  return { effort, model: `swe-2-${effort}`, port, claudeArgs };
}

export function isolatedClaudeEnvironment(env, configDir, { model, effort, port }) {
  // In particular, do not inherit provider secrets or the embedded transport's
  // process-wide CODEIUM_API_KEY after a caller has started a gateway.
  const result = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "COLORTERM", "COLUMNS", "LINES"]) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  return {
    ...result,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/claude`,
    ANTHROPIC_API_KEY: "local-gateway",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_EFFORT_LEVEL: effort,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
  };
}
