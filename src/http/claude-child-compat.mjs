const CLAUDE_CHILD_MARKERS = Object.freeze([
  "Messages from the agent that launched you",
  "Agent threads always have their cwd reset between bash calls",
]);

const CHILD_POLICY_START = "Notes:\n- Agent threads always have their cwd reset between bash calls";
const CHILD_POLICY_END = "\n\nHere is useful information about the environment you are running in:";
const NEUTRAL_CHILD_POLICY = [
  "Notes:",
  "- The working directory resets between shell calls, so use only absolute file paths.",
  "- In the final response, include relevant absolute file paths and only load-bearing code snippets.",
  "- Do not use emojis.",
  "- Use a period, not a colon, immediately before invoking a tool.",
  "- Return findings in the final response instead of creating report, summary, findings, or analysis files. Files needed as tool inputs are allowed.",
].join("\n");

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function isRoutedClaudeChild(headers) {
  return Boolean(
    String(headerValue(headers, "x-claude-code-session-id") ?? "").trim()
    && String(headerValue(headers, "x-claude-code-agent-id") ?? "").trim(),
  );
}

/**
 * Neutralize one live-bisected Grok policy fingerprint in Claude Code's
 * built-in child prompt. The rewrite is deliberately gated by the real child
 * headers and stable surrounding markers so parent requests and unrelated
 * system prompts remain byte-for-byte unchanged.
 */
export function prepareClaudeChildRequest(headers, body) {
  if (!isRoutedClaudeChild(headers) || !Array.isArray(body?.system)) {
    return { body, changed: false };
  }

  const blockIndex = body.system.findIndex((block) => {
    const text = typeof block?.text === "string" ? block.text : "";
    return CLAUDE_CHILD_MARKERS.every((marker) => text.includes(marker))
      && text.includes(CHILD_POLICY_START)
      && text.includes(CHILD_POLICY_END);
  });
  if (blockIndex < 0) return { body, changed: false };

  const system = body.system.slice();
  const block = system[blockIndex];
  const start = block.text.indexOf("Notes:");
  const end = block.text.indexOf(CHILD_POLICY_END, start);
  const text = `${block.text.slice(0, start)}${NEUTRAL_CHILD_POLICY}${block.text.slice(end)}`;
  system[blockIndex] = { ...block, text };
  return { body: { ...body, system }, changed: true };
}
