import { createHash } from "node:crypto";
import { Transform } from "node:stream";

const VALUE_HEADERS = new Set([
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "content-encoding",
  "content-type",
  "x-llm-gateway",
]);
const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function hashed(value) {
  return { sha256: sha256(stableJson(value)) };
}

function textHashes(value, result = [], depth = 0) {
  if (result.length >= 256 || depth > 20 || value == null) return result;
  if (typeof value === "string") {
    result.push(sha256(value));
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) textHashes(item, result, depth + 1);
    return result;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) textHashes(item, result, depth + 1);
  }
  return result;
}

function lineHashes(value, result = [], depth = 0) {
  if (result.length >= 512 || depth > 20 || value == null) return result;
  if (typeof value === "string") {
    for (const line of value.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) result.push(sha256(trimmed));
    }
    try {
      const parsed = JSON.parse(value);
      if (parsed !== value) lineHashes(parsed, result, depth + 1);
    } catch {}
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) lineHashes(item, result, depth + 1);
    return result;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) lineHashes(item, result, depth + 1);
  }
  return result;
}

function tokenHashes(value, result = [], depth = 0) {
  if (result.length >= 512 || depth > 20 || value == null) return result;
  if (typeof value === "string") {
    for (const token of value.match(/[A-Za-z0-9_]{8,}/g) ?? []) result.push(sha256(token));
    try {
      const parsed = JSON.parse(value);
      if (parsed !== value) tokenHashes(parsed, result, depth + 1);
    } catch {}
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) tokenHashes(item, result, depth + 1);
    return result;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) tokenHashes(item, result, depth + 1);
  }
  return result;
}

function contentStructure(value) {
  if (typeof value === "string") return { type: "string", ...hashed(value) };
  if (!Array.isArray(value)) return value == null ? { type: "absent" } : { type: typeof value, ...hashed(value) };
  return {
    type: "array",
    count: value.length,
    block_types: value.map((item) => item?.type ?? typeof item),
    text_hashes: textHashes(value),
    ...hashed(value),
  };
}

function toolStructure(tools) {
  if (!Array.isArray(tools)) return { count: 0, names: [], types: [], schema_hashes: [] };
  const flattened = tools.flatMap((tool) => {
    if (tool?.type !== "namespace") return [{ tool, namespace: tool?.namespace ?? null }];
    const children = tool.tools ?? tool.children ?? tool.functions ?? tool.items ?? [];
    return Array.isArray(children)
      ? children.map((child) => ({ tool: child, namespace: tool.name ?? tool.namespace ?? null }))
      : [{ tool, namespace: tool.name ?? tool.namespace ?? null }];
  });
  return {
    count: flattened.length,
    names: flattened.map(({ tool }) => tool?.name ?? tool?.function?.name ?? null),
    namespaces: flattened.map(({ namespace }) => namespace),
    types: flattened.map(({ tool }) => tool?.type ?? null),
    schema_hashes: flattened.map(({ tool }) => sha256(stableJson(tool?.input_schema ?? tool?.parameters ?? tool?.function?.parameters ?? null))),
  };
}

function sequenceStructure(value) {
  if (typeof value === "string") return { type: "string", ...hashed(value) };
  if (!Array.isArray(value)) return { type: value == null ? "absent" : typeof value };
  const functionCallOutputs = value.filter((item) => item?.type === "function_call_output" || item?.type === "custom_tool_call_output");
  return {
    type: "array",
    count: value.length,
    roles: value.map((item) => item?.role ?? null),
    item_types: value.map((item) => item?.type ?? null),
    content_types: value.map((item) => Array.isArray(item?.content)
      ? item.content.map((part) => part?.type ?? typeof part)
      : typeof item?.content),
    function_calls: value
      .filter((item) => item?.type === "function_call" || item?.type === "custom_tool_call")
      .map((item) => ({ type: item.type, name: item.name ?? null, namespace: item.namespace ?? null })),
    function_call_outputs: functionCallOutputs.length,
    function_call_output_token_hashes: tokenHashes(functionCallOutputs),
    text_hashes: textHashes(value),
    line_hashes: lineHashes(value),
    token_hashes: tokenHashes(value),
    ...hashed(value),
  };
}

export function summarizeHeaders(headers = {}) {
  const summary = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue == null) continue;
    const name = rawName.toLowerCase();
    const value = Array.isArray(rawValue) ? rawValue.join(",") : String(rawValue);
    if (SECRET_HEADERS.has(name)) summary[name] = { present: true };
    else if (VALUE_HEADERS.has(name)) summary[name] = value;
    else if (name.startsWith("x-claude-code-") || ["user-agent", "thread-id", "x-codex-parent-thread-id", "x-openai-subagent"].includes(name)) {
      summary[name] = { present: true, sha256: sha256(value) };
    }
  }
  return summary;
}

export function summarizeRequestBody(payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? "");
  const base = { bytes: bytes.length, sha256: sha256(bytes) };
  let body;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ...base, valid_json: false };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ...base, valid_json: true, json_type: Array.isArray(body) ? "array" : typeof body };
  }
  const additionalTools = Array.isArray(body.input)
    ? body.input.filter((item) => item?.type === "additional_tools").flatMap((item) => Array.isArray(item.tools) ? item.tools : [])
    : [];
  return {
    ...base,
    valid_json: true,
    model: typeof body.model === "string" ? body.model : null,
    stream: body.stream === true,
    tools: toolStructure(body.tools),
    additional_tools: toolStructure(additionalTools),
    system: contentStructure(body.system),
    instructions: contentStructure(body.instructions),
    messages: sequenceStructure(body.messages),
    input: sequenceStructure(body.input),
  };
}

export function observeBoundary(observer, record) {
  if (typeof observer !== "function") return;
  try {
    observer(Object.freeze(record));
  } catch {
    // Test instrumentation must never change bridge behavior.
  }
}

export function observeRequest(observer, { boundary, protocol, method, path, headers, payload }) {
  observeBoundary(observer, {
    boundary,
    direction: "request",
    protocol,
    method,
    path,
    headers: summarizeHeaders(headers),
    body: summarizeRequestBody(payload),
  });
}

function errorTypeFromJson(buffer) {
  try {
    const parsed = JSON.parse(buffer.toString("utf8"));
    return parsed?.error?.type ?? (parsed?.type === "error" ? parsed?.error?.type : null) ?? null;
  } catch {
    return null;
  }
}

export function createResponseProbe(observer, { protocol, status, headers, publicHeaders = headers }) {
  let pending = "";
  const eventTypes = [];
  const eventTypeSet = new Set();
  const bodyChunks = [];
  let bodyBytes = 0;
  const maximumErrorBytes = 64 * 1024;
  let streamErrorType = null;
  const toolCalls = new Map();
  const itemKeys = new Map();
  const recordEvent = (type) => {
    if (!type || eventTypeSet.has(type)) return;
    eventTypeSet.add(type);
    eventTypes.push(type);
  };
  const recordToolEvent = (event) => {
    const item = event?.item;
    if (item?.type === "custom_tool_call" || item?.type === "function_call") {
      const key = item.call_id ?? item.id;
      if (key) {
        itemKeys.set(item.id, key);
        const prior = toolCalls.get(key) ?? {};
        toolCalls.set(key, {
          type: item.type,
          name: item.name ?? prior.name ?? null,
          namespace: item.namespace ?? prior.namespace ?? null,
          input: item.input ?? item.arguments ?? prior.input ?? "",
        });
      }
    }
    if (event?.type === "response.custom_tool_call_input.delta" || event?.type === "response.function_call_arguments.delta") {
      const key = itemKeys.get(event.item_id);
      if (key) {
        const prior = toolCalls.get(key);
        toolCalls.set(key, { ...prior, input: `${prior?.input ?? ""}${event.delta ?? ""}` });
      }
    }
    if (event?.type === "response.custom_tool_call_input.done" || event?.type === "response.function_call_arguments.done") {
      const key = itemKeys.get(event.item_id);
      if (key) {
        const prior = toolCalls.get(key);
        toolCalls.set(key, { ...prior, input: event.input ?? event.arguments ?? prior?.input ?? "" });
      }
    }
  };
  const probe = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (status >= 400 && bodyBytes < maximumErrorBytes) {
        bodyChunks.push(buffer.subarray(0, maximumErrorBytes - bodyBytes));
      }
      bodyBytes += buffer.length;
      pending += buffer.toString("utf8");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("event:")) recordEvent(line.slice(6).trim());
        if (line.startsWith("data:")) {
          try {
            const event = JSON.parse(line.slice(5).trim());
            recordEvent(event?.type);
            recordToolEvent(event);
            if (event?.type === "error") streamErrorType = event?.error?.type ?? null;
          } catch {}
        }
      }
      callback(null, chunk);
    },
  });
  probe.once("end", () => {
    const contentType = String(headers?.["content-type"] ?? "");
    const errorType = contentType.includes("text/event-stream")
      ? streamErrorType
      : errorTypeFromJson(Buffer.concat(bodyChunks));
    const summarizedToolCalls = [...toolCalls.values()].map(({ input, ...call }) => ({
      ...call,
      input_sha256: sha256(input ?? ""),
      invokes_exec_command: /\btools\.exec_command\s*\(/.test(input ?? ""),
    }));
    const common = { direction: "response", protocol, status, stream_event_types: eventTypes, tool_calls: summarizedToolCalls, error_type: errorType };
    observeBoundary(observer, { boundary: "internal_transport", ...common, headers: summarizeHeaders(headers) });
    observeBoundary(observer, { boundary: "public_endpoint", ...common, headers: summarizeHeaders(publicHeaders) });
  });
  return probe;
}
