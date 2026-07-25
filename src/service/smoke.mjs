import { readinessPath } from "../core/readiness.mjs";
import { supportedModels } from "../http/openai-endpoint.mjs";

export async function runDirectSmoke({
  port = 4317,
  model = "swe-1-6-slow",
  timeoutMs = 300_000,
  fetchImpl = fetch,
  protocol = "openai",
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid LLM_GATEWAY_PORT: ${port}`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`Invalid LLM_GATEWAY_TIMEOUT_MS: ${timeoutMs}`);
  }
  if (!supportedModels.includes(model)) {
    throw new Error(`Unsupported gateway model: ${model}`);
  }
  if (!new Set(["openai", "claude"]).has(protocol)) {
    throw new Error(`Unsupported bridge protocol: ${protocol}`);
  }
  const expected = "BRIDGE_OK";
  const challenge = await fetchImpl(
    `http://127.0.0.1:${port}${readinessPath}`,
    { signal: AbortSignal.timeout(Math.min(timeoutMs, 5_000)) },
  );
  const readiness = await challenge.json().catch(() => null);
  const provider = model.startsWith("swe-") ? "devin" : "grok";
  if (
    !challenge.ok ||
    challenge.headers.get("x-llm-gateway") !== "1" ||
    readiness?.providers?.[provider]?.ready !== true
  ) {
    throw new Error(`The loopback gateway does not report ${provider} ready`);
  }

  const isClaude = protocol === "claude";
  const response = await fetchImpl(
    `http://127.0.0.1:${port}${isClaude ? "/claude/v1/messages" : "/openai/v1/responses"}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(isClaude ? { "anthropic-version": "2023-06-01" } : {}),
      },
      body: JSON.stringify(isClaude ? {
        model,
        max_tokens: 64,
        messages: [{ role: "user", content: `Reply with exactly: ${expected}` }],
        stream: false,
      } : {
        model,
        input: `Reply with exactly: ${expected}`,
        max_output_tokens: 64,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Direct request failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  const text = isClaude
    ? (body?.content || []).filter((part) => part?.type === "text").map((part) => part.text).join("")
    : (body?.output || [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content || [])
    .filter((part) => part?.type === "output_text")
    .map((part) => part.text)
    .join("");
  if (text.trim() !== expected) {
    throw new Error(`Bridge returned ${JSON.stringify(text)}, expected ${expected}`);
  }
  return { protocol, model, text: text.trim() };
}
