import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { request as createHTTPSRequest } from "node:https";
import { Transform, pipeline } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  readGrokAccessToken,
  refreshGrokOAuthSession,
  sanitizeGrokChildEnvironment,
} from "../core/grok-credentials.mjs";
import {
  anthropicToResponses,
  countAnthropicTokens,
  createAnthropicSSETransform,
  responsesToAnthropic,
} from "./anthropic-responses.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_INTERNAL_CAPABILITY_BYTES = 1_024;
const MAX_PROMPT_CACHE_KEY_BYTES = 256;
const MAX_UPSTREAM_RESPONSE_BYTES = 64 * 1024 * 1024;
const UPSTREAM_HOST = "cli-chat-proxy.grok.com";
const UPSTREAM_PATH = "/v1/responses";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

class InvalidRequestError extends Error {}

function sendJson(response, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-length": String(payload.length),
    "content-type": "application/json",
    ...headers,
  });
  response.end(payload);
}

function sendInvalidRequest(response, isAnthropic, message) {
  if (isAnthropic) {
    sendJson(response, 400, {
      type: "error",
      error: { type: "invalid_request_error", message },
    });
    return;
  }
  sendJson(response, 400, {
    error: { type: "invalid_request_error", message },
  });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function adapterRequestProblem(body, isAnthropic) {
  if (!isObject(body)) return "Request body must be a JSON object.";
  if (!isAnthropic) return null;
  if (!Array.isArray(body.messages)) return "messages must be an array.";
  if (body.messages.some((message) => !isObject(message))) {
    return "Each message must be an object.";
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    return "tools must be an array.";
  }
  if (body.tools?.some((tool) => !isObject(tool))) {
    return "Each tool must be an object.";
  }
  return null;
}

function promptCacheSessionID(body) {
  if (!Object.hasOwn(body, "prompt_cache_key")) return randomUUID();
  const value = body.prompt_cache_key;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PROMPT_CACHE_KEY_BYTES
  ) {
    throw new InvalidRequestError(
      `prompt_cache_key must be a non-empty string of at most ${MAX_PROMPT_CACHE_KEY_BYTES} UTF-8 bytes.`,
    );
  }
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function matchesInternalCapability(received, expected) {
  if (typeof received !== "string") return false;
  const receivedBytes = Buffer.from(received, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return receivedBytes.length === expectedBytes.length &&
    timingSafeEqual(receivedBytes, expectedBytes);
}

function jsonArguments(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function customInput(argumentsText) {
  try {
    const parsed = JSON.parse(argumentsText || "{}");
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 &&
      typeof parsed.input === "string"
    ) {
      return parsed.input;
    }
  } catch {}
  return argumentsText || "";
}

function qualify(namespace, name) {
  if (!namespace || !name || name.startsWith("mcp__")) return name;
  const prefix = namespace.endsWith("__") ? namespace : `${namespace}__`;
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

function normalizeTool(tool, maps, namespace = "") {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
  if (tool.type === "namespace") {
    const nested = Array.isArray(tool.tools)
      ? tool.tools
      : Array.isArray(tool.children)
        ? tool.children
        : [];
    return nested
      .map((child) => normalizeTool(child, maps, tool.name || tool.namespace || ""))
      .flat()
      .filter(Boolean);
  }
  if (tool.type === "tool_search" || tool.type === "image_generation") return null;

  const normalized = { ...tool };
  if (tool.type === "custom") {
    maps.customNames.add(tool.name);
    normalized.type = "function";
    normalized.parameters = tool.parameters ?? {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
      additionalProperties: false,
    };
  }
  if (normalized.type === "function" && !normalized.parameters) {
    normalized.parameters = { type: "object", properties: {} };
  }
  if (namespace && normalized.type === "function" && normalized.name) {
    const qualified = qualify(namespace, normalized.name);
    maps.namespaces.set(qualified, { namespace, name: normalized.name });
    normalized.name = qualified;
  }
  return normalized;
}

function normalizeInputItem(item, maps) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  if (item.type === "custom_tool_call") {
    const name = qualify(item.namespace, item.name);
    if (item.namespace && name) {
      maps.namespaces.set(name, {
        namespace: item.namespace,
        name: item.name,
      });
    }
    return {
      type: "function_call",
      call_id: item.call_id,
      name,
      arguments: jsonArguments(
        typeof item.input === "string" ? { input: item.input } : item.input,
      ),
    };
  }
  if (item.type === "custom_tool_call_output") {
    return {
      type: "function_call_output",
      call_id: item.call_id,
      output:
        typeof item.output === "string"
          ? item.output
          : JSON.stringify(item.output ?? ""),
    };
  }
  if (item.type === "function_call" && item.namespace) {
    return {
      ...item,
      name: qualify(item.namespace, item.name),
      namespace: undefined,
    };
  }
  return item;
}

export function prepareGrokResponsesRequest(body) {
  const maps = { customNames: new Set(), namespaces: new Map() };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { body, maps };
  }

  const input = [];
  const promotedTools = [];
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item?.type === "additional_tools" && Array.isArray(item.tools)) {
      promotedTools.push(...item.tools);
    } else if (item?.type === "reasoning") {
      // Reasoning and compaction state is encrypted by the originating
      // provider. It is not portable across Responses implementations, so
      // retain the visible transcript and tool history but omit it.
      continue;
    } else {
      input.push(normalizeInputItem(item, maps));
    }
  }
  const originalTools = [
    ...(Array.isArray(body.tools) ? body.tools : []),
    ...promotedTools,
  ];
  const tools = originalTools
    .flatMap((tool) => normalizeTool(tool, maps) ?? [])
    .filter(Boolean);

  const prepared = {
    ...body,
    stream: true,
    ...(Array.isArray(body.input) ? { input } : {}),
  };
  delete prepared.previous_response_id;
  delete prepared.prompt_cache_retention;
  delete prepared.safety_identifier;
  delete prepared.stream_options;
  if (originalTools.length > 0) {
    if (tools.length > 0) prepared.tools = tools;
    else delete prepared.tools;
  }
  if (!prepared.tools?.length) {
    delete prepared.tool_choice;
    delete prepared.parallel_tool_calls;
  }
  return { body: prepared, maps };
}

function restoreToolItem(item, maps) {
  if (!item || typeof item !== "object" || item.type !== "function_call") {
    return item;
  }
  const namespace = maps.namespaces.get(item.name);
  const base = namespace
    ? { ...item, name: namespace.name, namespace: namespace.namespace }
    : item;
  if (!maps.customNames.has(base.name)) return base;
  const restored = {
    ...base,
    type: "custom_tool_call",
    input: customInput(base.arguments),
  };
  delete restored.arguments;
  return restored;
}

export function restoreGrokResponsesEvent(event, maps) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return event;
  let restored = { ...event };
  if (restored.item) restored.item = restoreToolItem(restored.item, maps);
  if (restored.response?.output) {
    restored.response = {
      ...restored.response,
      output: restored.response.output.map((item) => restoreToolItem(item, maps)),
    };
  }
  const itemName = restored.item?.name;
  const isCustom =
    restored.item?.type === "custom_tool_call" ||
    (itemName && maps.customNames.has(itemName));
  if (isCustom) {
    if (restored.type === "response.function_call_arguments.delta") {
      restored.type = "response.custom_tool_call_input.delta";
    } else if (restored.type === "response.function_call_arguments.done") {
      restored.type = "response.custom_tool_call_input.done";
      restored.input = customInput(restored.arguments);
      delete restored.arguments;
    }
  }
  return restored;
}

function createSSETransform(maps) {
  let pending = "";
  const decoder = new StringDecoder("utf8");
  const customItemIDs = new Set();
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += decoder.write(chunk);
      const records = pending.split(/\r?\n\r?\n/);
      pending = records.pop() ?? "";
      for (const record of records) {
        this.push(transformSSERecord(record, maps, customItemIDs));
      }
      callback();
    },
    flush(callback) {
      pending += decoder.end();
      if (pending) this.push(transformSSERecord(pending, maps, customItemIDs));
      callback();
    },
  });
}

function transformSSERecord(record, maps, customItemIDs) {
  const lines = record.split(/\r?\n/);
  const transformed = lines.map((line) => {
    if (!line.startsWith("data:")) return line;
    const value = line.slice(5).trim();
    if (!value || value === "[DONE]") return line;
    try {
      const restored = restoreGrokResponsesEvent(JSON.parse(value), maps);
      if (
        restored.type === "response.output_item.added" &&
        restored.item?.type === "custom_tool_call" &&
        (restored.item.id || restored.item.call_id)
      ) {
        customItemIDs.add(restored.item.id ?? restored.item.call_id);
      }
      if (
        customItemIDs.has(restored.item_id) &&
        restored.type === "response.function_call_arguments.delta"
      ) {
        restored.type = "response.custom_tool_call_input.delta";
      } else if (
        customItemIDs.has(restored.item_id) &&
        restored.type === "response.function_call_arguments.done"
      ) {
        restored.type = "response.custom_tool_call_input.done";
        restored.input = customInput(restored.arguments);
        delete restored.arguments;
      }
      return `data: ${JSON.stringify(restored)}`;
    } catch {
      return line;
    }
  });
  return `${transformed.join("\n")}\n\n`;
}

function forwardedUpstreamHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value == null || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === "content-length") continue;
    result[name] = value;
  }
  return result;
}

function collectResponse(response, maximumBytes = MAX_UPSTREAM_RESPONSE_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    response.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        response.destroy();
        reject(new Error("xAI response exceeded the bridge limit"));
        return;
      }
      chunks.push(chunk);
    });
    response.once("end", () => resolve(Buffer.concat(chunks)));
    response.once("error", reject);
  });
}

function parsedResponseFromSSE(payload, maps) {
  let completed = null;
  let error = null;
  for (const line of payload.toString("utf8").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = restoreGrokResponsesEvent(
        JSON.parse(line.slice(5).trim()),
        maps,
      );
      if (
        event?.type === "response.completed" ||
        event?.type === "response.incomplete"
      ) {
        completed = event.response;
      }
      if (event?.type === "response.failed" || event?.type === "error") {
        error = event.error ?? event.response?.error ?? {
          type: "api_error",
          message: "xAI request failed",
        };
      }
    } catch {}
  }
  return { completed, error };
}

function createByteLimitTransform(maximumBytes = MAX_UPSTREAM_RESPONSE_BYTES) {
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        callback(new Error("xAI response exceeded the bridge limit"));
        return;
      }
      callback(null, chunk);
    },
  });
}

function upstreamRequest({
  payload,
  token,
  sessionID,
  cliVersion,
  requestImpl,
  onResponse,
}) {
  const request = requestImpl(
    {
      protocol: "https:",
      hostname: UPSTREAM_HOST,
      port: 443,
      method: "POST",
      path: UPSTREAM_PATH,
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
        "content-length": String(payload.length),
        "content-type": "application/json",
        "user-agent": `xai-grok-workspace/${cliVersion}`,
        "x-grok-client-version": cliVersion,
        "x-xai-token-auth": "xai-grok-cli",
        ...(sessionID ? { "x-grok-conv-id": sessionID } : {}),
      },
    },
    onResponse,
  );
  request.end(payload);
  return request;
}

function openUpstreamRequest(options, onError) {
  try {
    const request = upstreamRequest(options);
    request.once("error", onError);
    return request;
  } catch (error) {
    onError(error);
    return null;
  }
}

export function createGrokTransport({
  credentialPath,
  cliPath,
  cliVersion = "0.2.111",
  tokenProvider = readGrokAccessToken,
  refresh = refreshGrokOAuthSession,
  requestImpl = createHTTPSRequest,
  cliEnvironment = process.env,
  internalCapability,
  maximumUpstreamResponseBytes = MAX_UPSTREAM_RESPONSE_BYTES,
  log = () => {},
}) {
  if (
    typeof internalCapability !== "string" ||
    internalCapability.length === 0 ||
    Buffer.byteLength(internalCapability, "utf8") > MAX_INTERNAL_CAPABILITY_BYTES ||
    /[^\x21-\x7e]/.test(internalCapability)
  ) {
    throw new Error(
      "Internal Grok transport capability must be a bounded header-safe string",
    );
  }
  const childEnvironment = sanitizeGrokChildEnvironment(cliEnvironment);
  let refreshInFlight = null;
  const refreshSession = () => {
    if (!refreshInFlight) {
      refreshInFlight = Promise.resolve()
        .then(() => refresh({ cliPath, env: childEnvironment }))
        .finally(() => {
          refreshInFlight = null;
        });
    }
    return refreshInFlight;
  };

  return createServer((request, response) => {
    if (!matchesInternalCapability(request.headers["x-api-key"], internalCapability)) {
      sendJson(response, 401, {
        error: {
          type: "authentication_error",
          message: "Internal Grok transport authentication failed.",
        },
      });
      return;
    }

    let url;
    try {
      url = new URL(request.url || "/", "http://127.0.0.1");
    } catch {
      sendJson(response, 400, {
        error: { type: "invalid_request_error", message: "Request URL is invalid." },
      });
      return;
    }
    const isResponses = url.pathname === "/v1/responses";
    const isAnthropic = url.pathname === "/v1/messages";
    const isTokenCount = url.pathname === "/v1/messages/count_tokens";
    if (
      request.method !== "POST" ||
      (!isResponses && !isAnthropic && !isTokenCount)
    ) {
      sendJson(response, 404, {
        error: { type: "not_found", message: "Internal Grok route not found." },
      });
      return;
    }

    const chunks = [];
    let bytes = 0;
    let rejected = false;
    request.on("data", (chunk) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        rejected = true;
        sendJson(response, 413, {
          error: { type: "request_too_large", message: "Request exceeds 10 MiB." },
        });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      const original = Buffer.concat(chunks);
      let parsed;
      try {
        parsed = JSON.parse(original.toString("utf8"));
      } catch {
        if (isAnthropic || isTokenCount) {
          sendJson(response, 400, {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Request body is not valid JSON.",
            },
          });
        } else {
          sendJson(response, 400, {
            error: { type: "invalid_request_body", message: "Request body is not valid JSON." },
          });
        }
        return;
      }
      const requestProblem = adapterRequestProblem(
        parsed,
        isAnthropic || isTokenCount,
      );
      if (requestProblem) {
        sendInvalidRequest(response, isAnthropic || isTokenCount, requestProblem);
        return;
      }
      if (isTokenCount) {
        try {
          sendJson(response, 200, {
            input_tokens: countAnthropicTokens(parsed),
          });
        } catch {
          sendInvalidRequest(response, true, "Request body could not be processed.");
        }
        return;
      }
      let clientStream;
      let prepared;
      let payload;
      let sessionID;
      try {
        clientStream = parsed.stream === true;
        prepared = prepareGrokResponsesRequest(
          isAnthropic ? anthropicToResponses(parsed) : parsed,
        );
        payload = Buffer.from(JSON.stringify(prepared.body));
        sessionID = promptCacheSessionID(parsed);
      } catch (error) {
        sendInvalidRequest(
          response,
          isAnthropic,
          error instanceof InvalidRequestError
            ? error.message
            : "Request body could not be processed.",
        );
        return;
      }
      let activeUpstream = null;
      let retried = false;

      const fail = (error) => {
        if (response.destroyed || response.writableEnded) return;
        log(`xAI transport error: ${error?.code ?? error?.name ?? "request_failed"}`);
        if (isAnthropic) {
          sendJson(response, 502, {
            type: "error",
            error: {
              type: "api_error",
              message: "The xAI inference proxy is unavailable.",
            },
          });
        } else {
          sendJson(response, 502, {
            error: {
              type: "bridge_upstream_unavailable",
              message: "The xAI inference proxy is unavailable.",
            },
          });
        }
      };
      const send = () => {
        let token;
        try {
          token = tokenProvider(credentialPath);
        } catch (error) {
          fail(error);
          return;
        }
        activeUpstream = openUpstreamRequest({
          payload,
          token,
          sessionID,
          cliVersion,
          requestImpl,
          onResponse: async (upstream) => {
            if (upstream.statusCode === 401 && !retried) {
              retried = true;
              upstream.resume();
              try {
                await refreshSession();
              } catch (error) {
                fail(error);
                return;
              }
              if (response.destroyed || response.writableEnded) return;
              send();
              return;
            }
            if ((upstream.statusCode ?? 500) >= 400) {
              try {
                const body = await collectResponse(
                  upstream,
                  maximumUpstreamResponseBytes,
                );
                if (isAnthropic) {
                  let detail = "The xAI inference request failed.";
                  try {
                    const parsedError = JSON.parse(body.toString("utf8"));
                    detail =
                      parsedError?.error?.message ??
                      parsedError?.error ??
                      parsedError?.message ??
                      detail;
                  } catch {}
                  const type =
                    upstream.statusCode === 429
                      ? "rate_limit_error"
                      : upstream.statusCode === 401 || upstream.statusCode === 403
                        ? "authentication_error"
                        : upstream.statusCode === 400
                          ? "invalid_request_error"
                          : "api_error";
                  sendJson(response, upstream.statusCode, {
                    type: "error",
                    error: { type, message: String(detail).slice(0, 2048) },
                  });
                } else {
                  const headers = forwardedUpstreamHeaders(upstream.headers);
                  response.writeHead(upstream.statusCode, headers);
                  response.end(body);
                }
              } catch (error) {
                fail(error);
              }
              return;
            }
            if (clientStream) {
              const headers = forwardedUpstreamHeaders(upstream.headers);
              response.writeHead(upstream.statusCode || 200, {
                ...headers,
                "content-type": "text/event-stream",
              });
              pipeline(
                upstream,
                createByteLimitTransform(maximumUpstreamResponseBytes),
                isAnthropic
                  ? createAnthropicSSETransform({
                      restoreEvent: (event) =>
                        restoreGrokResponsesEvent(event, prepared.maps),
                    })
                  : createSSETransform(prepared.maps),
                response,
                (error) => {
                  if (error && !response.destroyed) response.destroy(error);
                },
              );
              return;
            }
            try {
              const body = await collectResponse(
                upstream,
                maximumUpstreamResponseBytes,
              );
              const { completed, error } = parsedResponseFromSSE(
                body,
                prepared.maps,
              );
              if (error) {
                if (isAnthropic) {
                  sendJson(response, 502, {
                    type: "error",
                    error: {
                      type: error.type ?? "api_error",
                      message: error.message ?? "The xAI inference request failed.",
                    },
                  });
                } else {
                  sendJson(response, 502, { error });
                }
                return;
              }
              if (!completed) {
                fail(new Error("xAI stream ended without response.completed"));
                return;
              }
              sendJson(
                response,
                200,
                isAnthropic ? responsesToAnthropic(completed) : completed,
              );
            } catch (error) {
              fail(error);
            }
          },
        }, fail);
      };
      const abortUpstream = () => {
        if (!response.writableFinished) activeUpstream?.destroy();
      };
      request.once("aborted", abortUpstream);
      response.once("close", abortUpstream);
      response.once("finish", () => {
        request.off("aborted", abortUpstream);
        response.off("close", abortUpstream);
      });
      send();
    });
  });
}

export function startGrokTransport({
  host = LOOPBACK_HOST,
  port,
  ...options
}) {
  if (host !== LOOPBACK_HOST) {
    throw new Error(`Internal Grok transport must bind to ${LOOPBACK_HOST}`);
  }
  const server = createGrokTransport(options);
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}
