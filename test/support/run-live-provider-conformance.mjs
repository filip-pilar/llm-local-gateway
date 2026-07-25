import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { providerForModel, supportedModels } from "../../src/core/providers.mjs";
import { startBridge } from "../../src/service/bridge.mjs";

if (process.env.LLM_GATEWAY_LIVE_CONFORMANCE !== "1") {
  throw new Error(
    "Set LLM_GATEWAY_LIVE_CONFORMANCE=1 to run quota-consuming provider probes",
  );
}

const publicPort = Number(process.env.LLM_GATEWAY_LIVE_PORT ?? 4517);
assert.ok(
  Number.isInteger(publicPort) && publicPort > 0 && publicPort <= 65533,
  "LLM_GATEWAY_LIVE_PORT must leave room for two internal ports",
);
const requestedModels = (
  process.env.LLM_GATEWAY_LIVE_MODELS ?? supportedModels.join(",")
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
assert.ok(requestedModels.length > 0, "At least one live model is required");
assert.ok(
  requestedModels.every((model) => supportedModels.includes(model)),
  `Unsupported live model list: ${requestedModels.join(", ")}`,
);

const root = await mkdtemp(resolve(tmpdir(), "llm-gateway-live-conformance-"));
let bridge;
try {
  bridge = await startBridge({
    env: {
      ...process.env,
      LLM_GATEWAY_PORT: String(publicPort),
      LLM_GATEWAY_DEVIN_PORT: String(publicPort + 1),
      LLM_GATEWAY_GROK_PORT: String(publicPort + 2),
      LLM_GATEWAY_DATA_DIR: resolve(root, "gateway-data"),
    },
    log: () => {},
  });

  const providers = new Set(requestedModels.map(providerForModel));
  for (const provider of providers) {
    const state = bridge.providers[provider];
    assert.equal(
      state?.server?.listening,
      true,
      `${provider} transport is not ready: ${state?.error?.message ?? "unknown error"}`,
    );
  }

  const base = `http://127.0.0.1:${publicPort}`;
  const results = [];
  for (const model of requestedModels) {
    try {
      results.push(await verifyModel(base, model));
    } catch (error) {
      results.push({
        model,
        provider: providerForModel(model),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const failed = results.filter((result) => result.ok === false);
  process.stdout.write(`${JSON.stringify({
    ok: failed.length === 0,
    base,
    models: results,
  }, null, 2)}\n`);
  if (failed.length > 0) process.exitCode = 1;
} finally {
  try {
    await bridge?.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyModel(base, model) {
  const provider = providerForModel(model);
  const openAIText = `OPENAI_${randomUUID().replaceAll("-", "")}`;
  const claudeText = `CLAUDE_${randomUUID().replaceAll("-", "")}`;
  const openAITool = `OPENAI_TOOL_${randomUUID().replaceAll("-", "")}`;
  const claudeTool = `CLAUDE_TOOL_${randomUUID().replaceAll("-", "")}`;

  const openAIResponse = await postJson(`${base}/openai/v1/responses`, {
    model,
    input: `Reply with exactly ${openAIText} and nothing else.`,
    max_output_tokens: 64,
    stream: false,
  });
  assert.equal(openAIResponse.status, 200, `${model} OpenAI text failed`);
  assert.equal(openAIOutputText(openAIResponse.body).trim(), openAIText);

  const claudeResponse = await postJson(`${base}/claude/v1/messages`, {
    model,
    max_tokens: 64,
    messages: [{
      role: "user",
      content: `Reply with exactly ${claudeText} and nothing else.`,
    }],
    stream: false,
  }, { "anthropic-version": "2023-06-01" });
  assert.equal(claudeResponse.status, 200, `${model} Claude text failed`);
  assert.equal(anthropicOutputText(claudeResponse.body).trim(), claudeText);

  const openAIStream = await postStream(`${base}/openai/v1/responses`, {
    model,
    input:
      `Call record_probe exactly once with value ${openAITool}. Do not reply with text.`,
    max_output_tokens: 96,
    tools: [openAIToolDefinition()],
    tool_choice: { type: "function", name: "record_probe" },
    stream: true,
  });
  assert.equal(openAIStream.status, 200, `${model} OpenAI stream failed`);
  const openAIEvents = parseSSE(openAIStream.text);
  assert.ok(
    openAIEvents.some((event) => event.type === "response.completed"),
    `${model} OpenAI stream did not complete`,
  );
  const completed = openAIEvents.findLast(
    (event) => event.type === "response.completed",
  )?.response;
  const openAICall = completed?.output?.find(
    (item) =>
      (item?.type === "function_call" || item?.type === "custom_tool_call") &&
      item?.name === "record_probe",
  );
  assert.ok(openAICall, `${model} OpenAI stream emitted no record_probe call`);
  assert.deepEqual(toolArguments(openAICall), { value: openAITool });

  const claudeStream = await postStream(`${base}/claude/v1/messages`, {
    model,
    max_tokens: 96,
    messages: [{
      role: "user",
      content:
        `Call record_probe exactly once with value ${claudeTool}. Do not reply with text.`,
    }],
    tools: [anthropicToolDefinition()],
    tool_choice: { type: "tool", name: "record_probe" },
    stream: true,
  }, { "anthropic-version": "2023-06-01" });
  assert.equal(claudeStream.status, 200, `${model} Claude stream failed`);
  const claudeEvents = parseSSE(claudeStream.text);
  assert.ok(
    claudeEvents.some((event) => event.type === "message_stop"),
    `${model} Claude stream did not stop`,
  );
  const start = claudeEvents.find(
    (event) =>
      event.type === "content_block_start" &&
      event.content_block?.type === "tool_use" &&
      event.content_block?.name === "record_probe",
  );
  assert.ok(start, `${model} Claude stream emitted no record_probe tool_use`);
  const partial = claudeEvents
    .filter(
      (event) =>
        event.type === "content_block_delta" &&
        event.index === start.index &&
        event.delta?.type === "input_json_delta",
    )
    .map((event) => event.delta.partial_json ?? "")
    .join("");
  const input = partial ? JSON.parse(partial) : start.content_block.input;
  assert.deepEqual(input, { value: claudeTool });

  return {
    model,
    provider,
    ok: true,
    openai: {
      non_stream_text: true,
      streaming_completed: true,
      forced_tool_call: true,
      event_types: [...new Set(openAIEvents.map(({ type }) => type).filter(Boolean))],
    },
    claude: {
      non_stream_text: true,
      streaming_completed: true,
      forced_tool_call: true,
      event_types: [...new Set(claudeEvents.map(({ type }) => type).filter(Boolean))],
    },
  };
}

function openAIToolDefinition() {
  return {
    type: "function",
    name: "record_probe",
    description: "Record one synthetic conformance value.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  };
}

function anthropicToolDefinition() {
  return {
    name: "record_probe",
    description: "Record one synthetic conformance value.",
    input_schema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  };
}

function toolArguments(call) {
  if (call?.type === "custom_tool_call") {
    return typeof call.input === "string" ? JSON.parse(call.input) : call.input;
  }
  return typeof call?.arguments === "string"
    ? JSON.parse(call.arguments)
    : call?.arguments;
}

function openAIOutputText(body) {
  return (body?.output ?? [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part?.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
}

function anthropicOutputText(body) {
  return (body?.content ?? [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function parseSSE(source) {
  return source.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith("data:")) return [];
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return [];
    try {
      return [JSON.parse(data)];
    } catch {
      return [];
    }
  });
}

async function postJson(url, body, extraHeaders = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const source = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    parsed = { raw: source };
  }
  return { status: response.status, body: parsed };
}

async function postStream(url, body, extraHeaders = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  return { status: response.status, text: await response.text() };
}
