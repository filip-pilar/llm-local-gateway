import { createServer, request as createRequest } from "node:http";
import { pipeline } from "node:stream";
import { modelOptionsError } from "./model-options.mjs";
import {
  providerForModel,
  supportedModels,
} from "../core/providers.mjs";
import {
  legacyReadinessPath,
  readinessPath,
} from "../core/readiness.mjs";
import {
  createResponseProbe,
  observeRequest,
} from "./boundary-instrumentation.mjs";
import { prepareClaudeChildRequest } from "./claude-child-compat.mjs";
import { prepareCodexChildRequest } from "./codex-child-compat.mjs";

const MAX_RESPONSES_BODY_BYTES = 10 * 1024 * 1024;
const MAX_JSON_DEPTH = 100;
const BRIDGE_IDENTITY_HEADER = "x-llm-local-gateway";
const LEGACY_BRIDGE_IDENTITY_HEADER = "x-llm-gateway";
const LOOPBACK_HOST = "127.0.0.1";
const MAX_INTERNAL_CAPABILITY_BYTES = 1_024;
export const openAIBasePath = "/openai/v1";
export const claudeBasePath = "/claude";
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

export function buildModelsResponse() {
  return {
    object: "list",
    data: supportedModels.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: providerForModel(id),
    })),
  };
}

export function buildAnthropicModelsResponse() {
  const data = supportedModels.map((id) => ({
    type: "model",
    id,
    display_name: id,
    created_at: "1970-01-01T00:00:00Z",
  }));
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  };
}

function sendJson(response, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-length": String(payload.length),
    "content-type": "application/json",
    ...headers,
  });
  response.end(payload);
}

function forwardedHeaders(
  headers,
  upstreamPort,
  bodyLength,
  internalCapability,
) {
  const forwarded = {};
  const connectionTokens = new Set(
    String(headers.connection || "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(headers)) {
    if (
      value == null ||
      HOP_BY_HOP_HEADERS.has(name) ||
      connectionTokens.has(name) ||
      name === "host" ||
      name === "authorization" ||
      name === "x-api-key"
    ) {
      continue;
    }
    if (name === "content-length" && bodyLength != null) continue;
    forwarded[name] = value;
  }
  forwarded.host = `127.0.0.1:${upstreamPort}`;
  if (bodyLength != null) forwarded["content-length"] = String(bodyLength);
  if (internalCapability != null) forwarded["x-api-key"] = internalCapability;
  return forwarded;
}

function responseHeaders(headers) {
  const forwarded = {};
  const connectionTokens = new Set(
    String(headers.connection || "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(headers)) {
    if (
      value == null ||
      HOP_BY_HOP_HEADERS.has(name) ||
      connectionTokens.has(name) ||
      name.startsWith("access-control-")
    ) {
      continue;
    }
    forwarded[name] = value;
  }
  return forwarded;
}

function hasJsonContentType(headers) {
  const value = headers["content-type"];
  if (typeof value !== "string") return false;
  return value.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function isLoopbackHostHeader(value) {
  if (typeof value !== "string") return false;
  const match = /^(?:127\.0\.0\.1|localhost\.?|\[::1\])(?::([0-9]{1,5}))?$/i.exec(value);
  if (!match) return false;
  if (match[1] == null) return true;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535;
}

function isBrowserOriginRequest(headers) {
  if (headers.origin != null) return true;
  return String(headers["sec-fetch-site"] ?? "").toLowerCase() === "cross-site";
}

function rejectNonJsonInference(request, response, protocol) {
  if (hasJsonContentType(request.headers)) return false;
  request.resume();
  if (protocol === "claude") {
    anthropicError(
      response,
      415,
      "invalid_request_error",
      "Content-Type must be application/json.",
    );
  } else {
    sendJson(response, 415, {
      error: {
        type: "invalid_content_type",
        message: "Content-Type must be application/json.",
      },
    });
  }
  return true;
}

function validateInternalCapability(value) {
  if (value == null) return;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_INTERNAL_CAPABILITY_BYTES ||
    /[^\x21-\x7e]/.test(value)
  ) {
    throw new Error("Internal transport capability must be a bounded header-safe string");
  }
}

function exceedsJsonDepth(value, maximumDepth = MAX_JSON_DEPTH) {
  const stack = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current.value || typeof current.value !== "object") continue;
    if (current.depth >= maximumDepth) return true;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
  return false;
}

function handleUpstreamError(error, response, protocol = "openai", provider = "provider") {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy(error);
    return;
  }
  if (protocol === "claude") {
    sendJson(response, 502, {
      type: "error",
      error: {
        type: "api_error",
        message: `The internal ${provider} transport is unavailable.`,
      },
    });
  } else {
    sendJson(response, 502, {
      error: {
        type: "bridge_upstream_unavailable",
        message: `The internal ${provider} transport is unavailable.`,
        provider,
      },
    });
  }
}

function pipeUpstreamResponse(
  upstreamResponse,
  response,
  protocol,
  provider,
  boundaryObserver,
) {
  const headers = responseHeaders(upstreamResponse.headers);
  response.writeHead(
    upstreamResponse.statusCode || 502,
    headers,
  );
  const streams = boundaryObserver
    ? [upstreamResponse, createResponseProbe(boundaryObserver, {
        protocol,
        status: upstreamResponse.statusCode || 502,
        headers: upstreamResponse.headers,
        publicHeaders: { ...headers, [BRIDGE_IDENTITY_HEADER]: "1" },
      }), response]
    : [upstreamResponse, response];
  pipeline(...streams, (error) => {
    if (error) handleUpstreamError(error, response, protocol, provider);
  });
}

function proxyBuffer(
  request,
  response,
  route,
  payload,
  upstreamPath = request.url,
  protocol = "openai",
  boundaryObserver,
  internalCapability,
) {
  const { upstreamPort, provider } = route;
  const outgoingHeaders = forwardedHeaders(
    request.headers,
    upstreamPort,
    payload.length,
    internalCapability,
  );
  observeRequest(boundaryObserver, {
    boundary: "internal_transport",
    protocol,
    method: request.method,
    path: upstreamPath,
    headers: outgoingHeaders,
    payload,
  });
  let upstreamResponse = null;
  const upstreamRequest = createRequest(
    {
      host: "127.0.0.1",
      port: upstreamPort,
      method: request.method,
      path: upstreamPath,
      headers: outgoingHeaders,
    },
    (receivedResponse) => {
      upstreamResponse = receivedResponse;
      pipeUpstreamResponse(
        receivedResponse,
        response,
        protocol,
        provider,
        boundaryObserver,
      );
    },
  );
  const abortUpstream = () => {
    if (response.writableFinished) return;
    upstreamResponse?.destroy();
    upstreamRequest.destroy();
  };
  response.once("close", abortUpstream);
  response.once("finish", () => response.off("close", abortUpstream));
  upstreamRequest.on("error", (error) =>
    handleUpstreamError(error, response, protocol, provider));
  upstreamRequest.end(payload);
}

function providerUnavailable(response, protocol, provider) {
  if (protocol === "claude") {
    sendJson(response, 503, {
      type: "error",
      error: {
        type: "api_error",
        message: `${provider} is not ready. Run \`llm-local-gateway status\` for details.`,
      },
    });
    return;
  }
  sendJson(response, 503, {
    error: {
      type: "provider_unavailable",
      message: `${provider} is not ready. Run \`llm-local-gateway status\` for details.`,
      provider,
    },
  });
}

export function neutralizeAstraInstructions(body) {
  if (!/^gpt-6-astra-(low|medium|high|xhigh|max)$/.test(body.model ?? "")) return body;
  if (body.instructions === undefined) return body;
  const instructions = "You are a helpful coding assistant. Inspect the workspace with the available tools, make requested edits with the available patch tool, run relevant checks, and finish the requested task before responding. Follow the user's instructions.";
  return { ...body, instructions };
}

function forwardResponses({
  request,
  response,
  original,
  parsed: initialBody,
  defaultModel,
  allowedModels,
  routeForModel,
  boundaryObserver,
  internalCapability,
}) {
  if (!initialBody || typeof initialBody !== "object" || Array.isArray(initialBody)) {
    sendJson(response, 400, {
      error: {
        type: "invalid_request_body",
        message: "Responses request body must be a JSON object.",
      },
    });
    return;
  }
  if (exceedsJsonDepth(initialBody)) {
    sendJson(response, 400, {
      error: {
        type: "invalid_request_body",
        message: `Responses request exceeds the maximum JSON depth of ${MAX_JSON_DEPTH}.`,
      },
    });
    return;
  }

  const prepared = prepareCodexChildRequest(request.headers, initialBody);
  let parsed = prepared.body;
  let payload = prepared.changed ? Buffer.from(JSON.stringify(parsed)) : original;
  if (parsed.model == null || parsed.model === "") {
    parsed = { ...parsed, model: defaultModel };
    payload = Buffer.from(JSON.stringify(parsed));
  } else if (typeof parsed.model !== "string" || !allowedModels.has(parsed.model)) {
    const display = typeof parsed.model === "string"
      ? `${JSON.stringify(parsed.model.slice(0, 128))}${parsed.model.length > 128 ? "…" : ""}`
      : Array.isArray(parsed.model)
        ? "an array"
        : `a ${typeof parsed.model}`;
    sendJson(response, 400, {
      error: {
        type: "invalid_model",
        message: `Model ${display} is not available through this bridge.`,
      },
    });
    return;
  }
  const neutralized = neutralizeAstraInstructions(parsed);
  if (neutralized !== parsed) {
    parsed = neutralized;
    payload = Buffer.from(JSON.stringify(parsed));
  }
  const optionsError = modelOptionsError(parsed);
  if (optionsError) {
    sendJson(response, 400, { error: { type: "invalid_request_error", message: optionsError } });
    return;
  }
  if (payload.length > MAX_RESPONSES_BODY_BYTES) {
    sendJson(response, 413, {
      error: {
        type: "request_too_large",
        message: "Responses request exceeds the 10 MiB bridge limit.",
      },
    });
    return;
  }
  const route = routeForModel(parsed.model);
  if (!route?.ready) {
    providerUnavailable(response, "openai", route?.provider ?? providerForModel(parsed.model));
    return;
  }
  proxyBuffer(
    request,
    response,
    route,
    payload,
    "/v1/responses",
    "openai",
    boundaryObserver,
    internalCapability,
  );
}

function proxyResponses(request, response, options) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSES_BODY_BYTES) {
    request.resume();
    sendJson(response, 413, {
      error: {
        type: "request_too_large",
        message: "Responses request exceeds the 10 MiB bridge limit.",
      },
    });
    return;
  }

  const chunks = [];
  let bytes = 0;
  let rejected = false;
  request.on("data", (chunk) => {
    if (rejected) return;
    bytes += chunk.length;
    if (bytes > MAX_RESPONSES_BODY_BYTES) {
      rejected = true;
      chunks.length = 0;
      sendJson(response, 413, {
        error: {
          type: "request_too_large",
          message: "Responses request exceeds the 10 MiB bridge limit.",
        },
      });
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (rejected) return;
    const original = Buffer.concat(chunks);
    observeRequest(options.boundaryObserver, {
      boundary: "public_endpoint",
      protocol: "openai",
      method: request.method,
      path: request.url,
      headers: request.headers,
      payload: original,
    });
    let parsed;
    try {
      parsed = JSON.parse(original.toString("utf8"));
    } catch {
      sendJson(response, 400, {
        error: {
          type: "invalid_request_body",
          message: "Responses request body must be valid JSON.",
        },
      });
      return;
    }
    try {
      forwardResponses({ request, response, original, parsed, ...options });
    } catch {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) response.destroy();
      else {
        sendJson(response, 400, {
          error: {
            type: "invalid_request_body",
            message: "Responses request could not be forwarded safely.",
          },
        });
      }
    }
  });
}

function anthropicError(response, status, type, message) {
  sendJson(response, status, { type: "error", error: { type, message } });
}

function proxyAnthropic(
  request,
  response,
  upstreamPath,
  defaultModel,
  allowedModels,
  routeForModel,
  boundaryObserver,
  internalCapability,
) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSES_BODY_BYTES) {
    request.resume();
    anthropicError(response, 413, "request_too_large", "Request exceeds the 10 MiB bridge limit.");
    return;
  }
  const chunks = [];
  let bytes = 0;
  let rejected = false;
  request.on("data", (chunk) => {
    if (rejected) return;
    bytes += chunk.length;
    if (bytes > MAX_RESPONSES_BODY_BYTES) {
      rejected = true;
      chunks.length = 0;
      anthropicError(response, 413, "request_too_large", "Request exceeds the 10 MiB bridge limit.");
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (rejected) return;
    const original = Buffer.concat(chunks);
    observeRequest(boundaryObserver, {
      boundary: "public_endpoint",
      protocol: "claude",
      method: request.method,
      path: request.url,
      headers: request.headers,
      payload: original,
    });
    let body;
    try {
      body = JSON.parse(original.toString("utf8"));
    } catch {
      anthropicError(
        response,
        400,
        "invalid_request_error",
        "Request body must be valid JSON.",
      );
      return;
    }
    try {
      if (!body || typeof body !== "object" || Array.isArray(body) || exceedsJsonDepth(body)) {
        anthropicError(response, 400, "invalid_request_error", "Messages request must be a JSON object within the bridge depth limit.");
        return;
      }
      if (
        body.model != null &&
        body.model !== "" &&
        (typeof body.model !== "string" || !allowedModels.has(body.model))
      ) {
        anthropicError(response, 400, "invalid_request_error", "The requested model is not available through this bridge.");
        return;
      }
      const withModel = body.model == null || body.model === ""
        ? { ...body, model: defaultModel }
        : body;
      const optionsError = modelOptionsError(withModel);
      if (optionsError) {
        anthropicError(response, 400, "invalid_request_error", optionsError);
        return;
      }
      const prepared = prepareClaudeChildRequest(request.headers, withModel);
      const changed = prepared.changed || withModel !== body;
      const payload = changed ? Buffer.from(JSON.stringify(prepared.body)) : original;
      const route = routeForModel(prepared.body.model);
      if (!route?.ready) {
        providerUnavailable(
          response,
          "claude",
          route?.provider ?? providerForModel(prepared.body.model),
        );
        return;
      }
      proxyBuffer(
        request,
        response,
        route,
        payload,
        upstreamPath,
        "claude",
        boundaryObserver,
        internalCapability,
      );
    } catch {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) response.destroy();
      else {
        anthropicError(
          response,
          400,
          "invalid_request_error",
          "Messages request could not be forwarded safely.",
        );
      }
    }
  });
}

export function createOpenAIEndpoint({
  providerRoutes,
  upstreamPort,
  defaultModel = "swe-1-6-slow",
  isUpstreamReady = () => true,
  boundaryObserver,
  internalCapability,
}) {
  const allowedModels = new Set(supportedModels);
  if (!allowedModels.has(defaultModel)) {
    throw new Error(`Default model is not supported by the bridge: ${defaultModel}`);
  }
  validateInternalCapability(internalCapability);
  const routes = Object.fromEntries(
    ["devin", "grok"].map((provider) => {
      const configured = providerRoutes?.[provider];
      return [
        provider,
        configured ?? (
          upstreamPort == null
            ? null
            : { upstreamPort, isReady: isUpstreamReady }
        ),
      ];
    }),
  );
  const routeForModel = (model) => {
    const provider = providerForModel(model);
    const route = routes[provider];
    let ready = false;
    try {
      ready =
        Number.isInteger(route?.upstreamPort) &&
        (route.isReady?.() ?? true) === true;
    } catch {}
    return {
      provider,
      upstreamPort: route?.upstreamPort,
      ready,
    };
  };
  const providerReadiness = () => Object.fromEntries(
    Object.entries(routes).map(([provider]) => {
      const model = supportedModels.find((id) => providerForModel(id) === provider);
      return [provider, {
        ready: routeForModel(model).ready,
        models: supportedModels.filter((id) => providerForModel(id) === provider),
      }];
    }),
  );

  return createServer((request, response) => {
    response.setHeader(BRIDGE_IDENTITY_HEADER, "1");
    response.setHeader(LEGACY_BRIDGE_IDENTITY_HEADER, "1");
    let url;
    try {
      url = new URL(request.url || "/", "http://127.0.0.1");
    } catch {
      sendJson(response, 400, {
        error: { type: "invalid_request_target", message: "Invalid request target." },
      });
      return;
    }
    if (!isLoopbackHostHeader(request.headers.host)) {
      request.resume();
      sendJson(response, 400, {
        error: {
          type: "invalid_host",
          message: "Host must identify the loopback gateway.",
        },
      });
      return;
    }
    if (isBrowserOriginRequest(request.headers)) {
      request.resume();
      sendJson(response, 403, {
        error: {
          type: "browser_request_rejected",
          message: "Browser-origin requests are not accepted by this loopback gateway.",
        },
      });
      return;
    }

    if (
      url.pathname === readinessPath ||
      url.pathname === legacyReadinessPath
    ) {
      if (request.method !== "GET") {
        sendJson(response, 405, {
          error: { type: "method_not_allowed", message: "Only GET is allowed for readiness." },
        }, { allow: "GET" });
        return;
      }
      const providers = providerReadiness();
      const ready = Object.values(providers).some((provider) => provider.ready);
      sendJson(response, ready ? 200 : 503, {
        ready,
        default_model: defaultModel,
        openai_base_path: openAIBasePath,
        claude_base_path: claudeBasePath,
        providers,
      });
      return;
    }

    if (url.pathname === `${openAIBasePath}/models` || url.pathname === "/v1/models") {
      if (request.method !== "GET") {
        sendJson(response, 405, {
          error: { type: "method_not_allowed", message: "Only GET is allowed for /v1/models." },
        }, { allow: "GET" });
        return;
      }
      sendJson(response, 200, buildModelsResponse());
      return;
    }

    if (url.pathname === `${openAIBasePath}/responses` || url.pathname === "/v1/responses") {
      if (request.method !== "POST") {
        sendJson(response, 405, {
          error: { type: "method_not_allowed", message: "Only POST is allowed for /v1/responses." },
        }, { allow: "POST" });
        return;
      }
      if (rejectNonJsonInference(request, response, "openai")) return;
      proxyResponses(request, response, {
        defaultModel,
        allowedModels,
        routeForModel,
        boundaryObserver,
        internalCapability,
      });
      return;
    }

    if (url.pathname === `${claudeBasePath}/v1/models`) {
      if (request.method !== "GET") {
        anthropicError(response, 405, "invalid_request_error", "Only GET is allowed for this route.");
        return;
      }
      sendJson(response, 200, buildAnthropicModelsResponse());
      return;
    }

    const anthropicRoutes = new Map([
      [`${claudeBasePath}/v1/messages`, "/v1/messages"],
      [`${claudeBasePath}/v1/messages/count_tokens`, "/v1/messages/count_tokens"],
    ]);
    const upstreamPath = anthropicRoutes.get(url.pathname);
    if (upstreamPath) {
      if (request.method !== "POST") {
        anthropicError(response, 405, "invalid_request_error", "Only POST is allowed for this route.");
        return;
      }
      if (rejectNonJsonInference(request, response, "claude")) return;
      proxyAnthropic(
        request,
        response,
        `${upstreamPath}${url.search}`,
        defaultModel,
        allowedModels,
        routeForModel,
        boundaryObserver,
        internalCapability,
      );
      return;
    }

    sendJson(response, 404, {
      error: { type: "not_found", message: "Bridge route not found." },
    });
  });
}

export function startOpenAIEndpoint({ host, port, ...options }) {
  if (host !== LOOPBACK_HOST) {
    throw new Error(`Public bridge must bind to ${LOOPBACK_HOST}`);
  }
  const server = createOpenAIEndpoint(options);
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}
