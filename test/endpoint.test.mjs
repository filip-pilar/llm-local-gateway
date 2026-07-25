import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as createRequest } from "node:http";
import test from "node:test";
import {
  buildModelsResponse,
  buildAnthropicModelsResponse,
  createOpenAIEndpoint,
  startOpenAIEndpoint,
  supportedModels,
} from "../src/http/openai-endpoint.mjs";
import { providerForModel } from "../src/core/providers.mjs";
import { prepareCodexChildRequest } from "../src/http/codex-child-compat.mjs";
import { summarizeRequestBody } from "../src/http/boundary-instrumentation.mjs";

test("hashes tool-output tokens independently of preceding prompt volume", () => {
  const nonce = "CODEX_CHILD_0123456789abcdef0123456789abcdef";
  const summary = summarizeRequestBody(JSON.stringify({
    input: [
      { type: "message", role: "developer", content: "large ".repeat(2000) },
      { type: "custom_tool_call_output", call_id: "call_1", output: `wrapped result: ${nonce}` },
    ],
  }));
  assert.ok(summary.input.function_call_output_token_hashes.includes(createHash("sha256").update(nonce).digest("hex")));
});

test("promotes only real Codex child additional_tools and compacts only exec guidance", () => {
  const execTool = { type: "custom", name: "exec", description: "Compose child coding tools" };
  const body = {
    model: "grok-4.5",
    input: [
      { type: "additional_tools", role: "developer", tools: [execTool] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the file." }] },
    ],
  };
  assert.deepEqual(prepareCodexChildRequest({}, body), { body, changed: false });
  const prepared = prepareCodexChildRequest({ "x-openai-subagent": "collab_spawn" }, body);
  assert.equal(prepared.changed, true);
  assert.deepEqual(prepared.body.tools.map(({ description, ...tool }) => tool), [{ type: "custom", name: "exec" }]);
  assert.match(prepared.body.tools[0].description, /ALL_TOOLS/);
  assert.match(prepared.body.tools[0].description, /tools\.exec_command/);
  assert.ok(prepared.body.tools[0].description.length < execTool.description.length + 300);
  assert.deepEqual(prepared.body.input, [body.input[1]]);

  const explicit = { ...body, tools: [{ type: "function", name: "already_present" }] };
  assert.deepEqual(prepareCodexChildRequest({ "x-openai-subagent": "collab_spawn" }, explicit), { body: explicit, changed: false });
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function requestWithDeclaredLength(port, length) {
  return new Promise((resolve, reject) => {
    const request = createRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/v1/responses",
      headers: {
        "content-length": String(length),
        "content-type": "application/json",
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.on("error", reject);
    request.end(Buffer.alloc(length, 0x20));
  });
}

test("publishes a minimal standard OpenAI model list", () => {
  const response = buildModelsResponse();
  assert.equal(response.object, "list");
  assert.deepEqual(response.data.map(({ id }) => id), supportedModels);
  for (const model of response.data) {
    assert.deepEqual(Object.keys(model), ["id", "object", "created", "owned_by"]);
    assert.equal(model.object, "model");
    assert.equal(model.owned_by, providerForModel(model.id));
  }
});

test("publishes an Anthropic-compatible model list", () => {
  const response = buildAnthropicModelsResponse();
  assert.deepEqual(response.data.map(({ id }) => id), supportedModels);
  assert.equal(response.has_more, false);
  assert.equal(response.first_id, supportedModels[0]);
  assert.equal(response.last_id, supportedModels.at(-1));
});

test("refuses a non-loopback public binding", () => {
  assert.throws(
    () => startOpenAIEndpoint({ host: "0.0.0.0", port: 4317, upstreamPort: 4318 }),
    /must bind to 127\.0\.0\.1/,
  );
});

test("forwards direct Responses requests unchanged and injects only a missing model", async () => {
  const received = [];
  const records = [];
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  const upstreamPort = await listen(upstream);
  const endpoint = createOpenAIEndpoint({
    upstreamPort,
    defaultModel: "grok-4.5",
    boundaryObserver: (record) => records.push(record),
  });
  const port = await listen(endpoint);
  try {
    const explicit = {
      model: "grok-4.5",
      instructions: "Keep exactly",
      input: [{ role: "user", content: "Hello" }],
      tools: [{ type: "function", name: "keep_me" }],
    };
    for (const body of [explicit, { input: "Use the default" }]) {
      const response = await fetch(`http://127.0.0.1:${port}/openai/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(received[0], explicit);
    assert.deepEqual(received[1], { model: "grok-4.5", input: "Use the default" });
    const requests = records.filter((record) => record.direction === "request");
    assert.equal(requests[2].boundary, "public_endpoint");
    assert.equal(requests[2].body.model, null);
    assert.equal(requests[3].boundary, "internal_transport");
    assert.equal(requests[3].body.model, "grok-4.5");
    assert.notEqual(requests[2].body.sha256, requests[3].body.sha256);
  } finally {
    await close(endpoint);
    await close(upstream);
  }
});

test("routes every supported model to its provider and applies the default on both protocols", async () => {
  const received = { devin: [], grok: [] };
  const makeUpstream = (provider) => createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received[provider].push({
        path: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.url.startsWith("/v1/messages")
        ? JSON.stringify({ type: "message", role: "assistant", content: [] })
        : JSON.stringify({ id: "resp_fixture", object: "response", output: [] }));
    });
  });
  const devin = makeUpstream("devin");
  const grok = makeUpstream("grok");
  const devinPort = await listen(devin);
  const grokPort = await listen(grok);
  const endpoint = createOpenAIEndpoint({
    defaultModel: "swe-1-7-lightning",
    providerRoutes: {
      devin: { upstreamPort: devinPort },
      grok: { upstreamPort: grokPort },
    },
  });
  const port = await listen(endpoint);
  try {
    for (const model of supportedModels) {
      const response = await fetch(`http://127.0.0.1:${port}/openai/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: "route me" }),
      });
      assert.equal(response.status, 200);
    }
    for (const body of [
      { max_tokens: 1, messages: [] },
      { model: "", max_tokens: 1, messages: [] },
    ]) {
      const defaulted = await fetch(
        `http://127.0.0.1:${port}/claude/v1/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      assert.equal(defaulted.status, 200);
    }
    assert.deepEqual(
      received.devin.map(({ body }) => body.model),
      [
        "swe-1-6-slow",
        "swe-1-7-lightning",
        "swe-1-7-lightning",
        "swe-1-7-lightning",
      ],
    );
    assert.deepEqual(
      received.grok.map(({ body }) => body.model),
      ["grok-4.5"],
    );
    assert.equal(received.devin.at(-1).path, "/v1/messages");
  } finally {
    await close(endpoint);
    await close(devin);
    await close(grok);
  }
});

test("discards client authentication headers before the internal transport", async () => {
  let receivedHeaders;
  const upstream = createServer((request, response) => {
    receivedHeaders = request.headers;
    request.resume();
    request.once("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  const upstreamPort = await listen(upstream);
  const endpoint = createOpenAIEndpoint({ upstreamPort });
  const port = await listen(endpoint);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/openai/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer ignored",
        "x-api-key": "ignored",
        "content-type": "application/json",
      },
      body: JSON.stringify({ input: "hello" }),
    });
    assert.equal(response.status, 200);
    assert.equal(receivedHeaders.authorization, undefined);
    assert.equal(receivedHeaders["x-api-key"], undefined);
  } finally {
    await close(endpoint);
    await close(upstream);
  }
});

test("exposes unauthenticated Anthropic Messages and token counting", async () => {
  const received = [];
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        path: request.url,
        version: request.headers["anthropic-version"],
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      });
      response.end(JSON.stringify(request.url.endsWith("count_tokens")
        ? { input_tokens: 7 }
        : { type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] }));
    });
  });
  const upstreamPort = await listen(upstream);
  const endpoint = createOpenAIEndpoint({ upstreamPort });
  const port = await listen(endpoint);
  const headers = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  const body = { model: "grok-4.5", max_tokens: 32, messages: [{ role: "user", content: "hi" }] };
  try {
    const message = await fetch(`http://127.0.0.1:${port}/claude/v1/messages`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    assert.equal(message.status, 200);
    assert.equal((await message.json()).content[0].text, "ok");
    const count = await fetch(`http://127.0.0.1:${port}/claude/v1/messages/count_tokens`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    assert.deepEqual(await count.json(), { input_tokens: 7 });
    assert.deepEqual(received.map(({ path }) => path), ["/v1/messages", "/v1/messages/count_tokens"]);
    assert.equal(received[0].version, "2023-06-01");
    assert.deepEqual(received[0].body, body);
  } finally {
    await close(endpoint);
    await close(upstream);
  }
});

test("streams Anthropic SSE unchanged and rejects unsupported models before upstream", async () => {
  let requests = 0;
  const upstream = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
  });
  const upstreamPort = await listen(upstream);
  const endpoint = createOpenAIEndpoint({ upstreamPort });
  const port = await listen(endpoint);
  const headers = { "content-type": "application/json" };
  try {
    const rejected = await fetch(`http://127.0.0.1:${port}/claude/v1/messages`, {
      method: "POST", headers, body: JSON.stringify({ model: "unknown", messages: [] }),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).type, "error");
    assert.equal(requests, 0);
    const streamed = await fetch(`http://127.0.0.1:${port}/claude/v1/messages`, {
      method: "POST", headers, body: JSON.stringify({ model: "grok-4.5", messages: [], stream: true }),
    });
    assert.equal(streamed.headers.get("content-type"), "text/event-stream");
    assert.match(await streamed.text(), /event: message_stop/);
    assert.equal(requests, 1);
  } finally {
    await close(endpoint);
    await close(upstream);
  }
});

test("records an Anthropic error type carried by an HTTP 200 stream", async () => {
  const upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"redacted"}}\n\n');
    });
  });
  const upstreamPort = await listen(upstream);
  const records = [];
  const endpoint = createOpenAIEndpoint({ upstreamPort, boundaryObserver: (record) => records.push(record) });
  const port = await listen(endpoint);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/claude/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "grok-4.5", max_tokens: 1, messages: [] }),
    });
    assert.equal(response.status, 200);
    await response.text();
    const observed = records.find((record) => record.boundary === "public_endpoint" && record.direction === "response");
    assert.deepEqual(observed.stream_event_types, ["error"]);
    assert.equal(observed.error_type, "invalid_request_error");
    assert.doesNotMatch(JSON.stringify(observed), /redacted/);
  } finally {
    await close(endpoint);
    await close(upstream);
  }
});

test("preserves a Claude Code child request and records only redacted structure at both boundaries", async () => {
  const captured = [];
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      captured.push({ headers: request.headers, body: Buffer.concat(chunks) });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        'event: message_start\ndata: {"type":"message_start","message":{"type":"message","content":[]}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"README.md\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""));
    });
  });
  const upstreamPort = await listen(upstream);
  const records = [];
  const endpoint = createOpenAIEndpoint({ upstreamPort, boundaryObserver: (record) => records.push(record) });
  const port = await listen(endpoint);
  const secret = "SENSITIVE_PROMPT_SENTINEL";
  const body = {
    model: "grok-4.5",
    max_tokens: 512,
    stream: true,
    system: [
      { type: "text", text: `You are a Claude agent. ${secret}`, cache_control: { type: "ephemeral" } },
      { type: "text", text: "Follow the child assignment." },
    ],
    tools: [{
      name: "Read",
      description: "Read a file",
      input_schema: {
        type: "object",
        properties: { file_path: { type: "string" }, offset: { type: "integer" } },
        required: ["file_path"],
      },
    }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Inspect the repository." }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_previous", name: "Read", input: { file_path: "package.json" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_previous", content: "{}" }] },
    ],
    metadata: { user_id: "session-test" },
  };
  const payload = Buffer.from(JSON.stringify(body));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/claude/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        authorization: "Bearer must-not-be-recorded",
        "x-api-key": "must-not-be-recorded",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
        "x-claude-code-session-id": "session-sensitive",
        "x-claude-code-agent-id": "agent-sensitive",
        "content-type": "application/json",
      },
      body: payload,
    });
    const streamed = await response.text();
    assert.match(streamed, /input_json_delta/);
    assert.deepEqual(captured[0].body, payload);
    assert.equal(captured[0].headers["anthropic-version"], "2023-06-01");
    assert.equal(captured[0].headers["anthropic-beta"], "prompt-caching-2024-07-31");
    assert.equal(captured[0].headers["x-claude-code-session-id"], "session-sensitive");
    assert.equal(captured[0].headers.authorization, undefined);
    assert.equal(captured[0].headers["x-api-key"], undefined);

    const publicRequest = records.find((record) => record.boundary === "public_endpoint" && record.direction === "request");
    const internalRequest = records.find((record) => record.boundary === "internal_transport" && record.direction === "request");
    assert.equal(publicRequest.body.sha256, internalRequest.body.sha256);
    assert.deepEqual(publicRequest.body.tools.names, ["Read"]);
    assert.deepEqual(publicRequest.body.system.block_types, ["text", "text"]);
    assert.equal(publicRequest.headers.authorization.present, true);
    assert.equal(internalRequest.headers.authorization, undefined);
    assert.equal(publicRequest.headers["x-claude-code-session-id"].present, true);
    const publicResponse = records.find((record) => record.boundary === "public_endpoint" && record.direction === "response");
    assert.deepEqual(publicResponse.stream_event_types, [
      "message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_stop",
    ]);
    const serialized = JSON.stringify(records);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.doesNotMatch(serialized, /must-not-be-recorded|session-sensitive|agent-sensitive/);

    const realChildStructure = {
      context_management: { edits: [{ type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 100000 } }] },
      max_tokens: 32000,
      messages: [{ role: "user", content: [{ type: "text", text: "Child assignment" }] }],
      metadata: { user_id: "session-structure" },
      model: "grok-4.5",
      output_config: { effort: "high" },
      stream: true,
      system: [
        { type: "text", text: "identity block", cache_control: { type: "ephemeral" } },
        { type: "text", text: "policy block", cache_control: { type: "ephemeral" } },
        { type: "text", text: "environment block", cache_control: { type: "ephemeral" } },
      ],
      thinking: { type: "enabled", budget_tokens: 1000 },
      tools: [],
    };
    const realPayload = Buffer.from(JSON.stringify(realChildStructure));
    const realResponse = await fetch(`http://127.0.0.1:${port}/claude/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "x-claude-code-session-id": "real-structure-session",
        "x-claude-code-agent-id": "real-structure-agent",
        "content-type": "application/json",
      },
      body: realPayload,
    });
    await realResponse.text();
    assert.deepEqual(captured[1].body, realPayload);
    const realRequests = records.filter((record) => record.direction === "request" && record.body.system.count === 3);
    assert.equal(realRequests.length, 2);
    assert.equal(realRequests[0].body.sha256, realRequests[1].body.sha256);
    assert.equal(realRequests[0].body.tools.count, 0);
    assert.deepEqual(realRequests[0].body.messages.roles, ["user"]);
  } finally {
    await close(endpoint);
    await close(upstream);
  }
});

test("neutralizes only the bisected routed-child policy paragraph", async () => {
  const captured = [];
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "message", role: "assistant", content: [] }));
    });
  });
  const upstreamPort = await listen(upstream);
  const records = [];
  const endpoint = createOpenAIEndpoint({ upstreamPort, boundaryObserver: (record) => records.push(record) });
  const port = await listen(endpoint);
  const originalClause = "the parent agent reads your text output";
  const childBlock = [
    "Messages from the agent that launched you — your task and any mid-task course corrections — direct your work.",
    "Notes:",
    "- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.",
    '- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.',
    `- Do NOT Write report/summary/findings/analysis .md files. Return findings directly as your final assistant message — ${originalClause}, not files you create. (Files written as input to another tool are fine; this note is about report files.)`,
    "",
    "Here is useful information about the environment you are running in:",
    "<env>Working directory: /tmp/project</env>",
  ].join("\n");
  const assignment = "Return exactly CHILD_ASSIGNMENT_NONCE";
  const body = {
    model: "grok-4.5",
    stream: true,
    system: [
      { type: "text", text: "identity" },
      { type: "text", text: "policy" },
      { type: "text", text: childBlock, cache_control: { type: "ephemeral" } },
    ],
    tools: [{ name: "Read", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: assignment }],
  };
  try {
    const childResponse = await fetch(`http://127.0.0.1:${port}/claude/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "session",
        "x-claude-code-agent-id": "agent",
      },
      body: JSON.stringify(body),
    });
    await childResponse.text();
    assert.equal(captured[0].system[2].text.includes(originalClause), false);
    assert.match(captured[0].system[2].text, /working directory resets between shell calls/);
    assert.match(captured[0].system[2].text, /Use a period, not a colon/);
    assert.match(captured[0].system[2].text, /Return findings in the final response/);
    assert.equal(captured[0].system[2].cache_control.type, "ephemeral");
    assert.deepEqual(captured[0].messages, body.messages);
    assert.deepEqual(captured[0].tools, body.tools);

    const parentResponse = await fetch(`http://127.0.0.1:${port}/claude/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await parentResponse.text();
    assert.equal(captured[1].system[2].text, childBlock);

    const unrelated = structuredClone(body);
    unrelated.system[2].text = `Unrelated prompt: ${originalClause}.`;
    const unrelatedResponse = await fetch(`http://127.0.0.1:${port}/claude/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "session",
        "x-claude-code-agent-id": "agent",
      },
      body: JSON.stringify(unrelated),
    });
    await unrelatedResponse.text();
    assert.equal(captured[2].system[2].text, unrelated.system[2].text);

    const requests = records.filter((record) => record.direction === "request");
    assert.notEqual(requests[0].body.sha256, requests[1].body.sha256);
    assert.equal(requests[0].body.tools.schema_hashes[0], requests[1].body.tools.schema_hashes[0]);
    assert.equal(requests[0].body.messages.sha256, requests[1].body.messages.sha256);
    assert.equal(requests[2].body.sha256, requests[3].body.sha256);
    assert.equal(requests[4].body.sha256, requests[5].body.sha256);
  } finally {
    await close(endpoint);
    await close(upstream);
  }
});

test("preserves Codex child coding tools, namespaces, function history, and streaming events", async () => {
  let captured;
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      captured = Buffer.concat(chunks);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","namespace":"workspace","name":"apply_patch","arguments":"","status":"in_progress"}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"patch\\":\\"edit\\"}"}\n\n',
        'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"fc_1","output_index":0,"arguments":"{\\"patch\\":\\"edit\\"}"}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","namespace":"workspace","name":"apply_patch","arguments":"{\\"patch\\":\\"edit\\"}","status":"completed"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n',
      ].join(""));
    });
  });
  const upstreamPort = await listen(upstream);
  const records = [];
  const endpoint = createOpenAIEndpoint({ upstreamPort, boundaryObserver: (record) => records.push(record) });
  const port = await listen(endpoint);
  const body = {
    model: "grok-4.5",
    stream: true,
    instructions: "Use the provided workspace coding tools.",
    tools: [{
      type: "namespace",
      name: "workspace",
      tools: [{
        type: "function",
        name: "apply_patch",
        description: "Apply a workspace patch",
        parameters: {
          type: "object",
          properties: { patch: { type: "string" } },
          required: ["patch"],
          additionalProperties: false,
        },
      }],
    }],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Apply the edit." }] },
      { type: "function_call", call_id: "prior_call", namespace: "workspace", name: "apply_patch", arguments: "{\"patch\":\"prior\"}" },
      { type: "function_call_output", call_id: "prior_call", output: "done" },
    ],
  };
  const payload = Buffer.from(JSON.stringify(body));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/openai/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer local-only", "content-type": "application/json" },
      body: payload,
    });
    const streamed = await response.text();
    assert.match(streamed, /"namespace":"workspace"/);
    assert.deepEqual(captured, payload);
    const publicRequest = records.find((record) => record.boundary === "public_endpoint" && record.direction === "request");
    const internalRequest = records.find((record) => record.boundary === "internal_transport" && record.direction === "request");
    assert.equal(publicRequest.body.sha256, internalRequest.body.sha256);
    assert.deepEqual(publicRequest.body.tools, {
      count: 1,
      names: ["apply_patch"],
      namespaces: ["workspace"],
      types: ["function"],
      schema_hashes: publicRequest.body.tools.schema_hashes,
    });
    assert.deepEqual(publicRequest.body.input.function_calls, [
      { type: "function_call", name: "apply_patch", namespace: "workspace" },
    ]);
    assert.equal(publicRequest.body.input.function_call_outputs, 1);
    assert.equal(internalRequest.headers.authorization, undefined);
    const publicResponse = records.find((record) => record.boundary === "public_endpoint" && record.direction === "response");
    assert.deepEqual(publicResponse.stream_event_types, [
      "response.created",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    assert.deepEqual(publicResponse.tool_calls, [{
      type: "function_call",
      name: "apply_patch",
      namespace: "workspace",
      input_sha256: publicResponse.tool_calls[0].input_sha256,
      invokes_exec_command: false,
    }]);
  } finally {
    await close(endpoint);
    await close(upstream);
  }
});

test("serves model discovery and readiness without authentication", async () => {
  const endpoint = createOpenAIEndpoint({ upstreamPort: 1 });
  const port = await listen(endpoint);
  try {
    const models = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(models.status, 200);
    assert.equal(models.headers.get("x-llm-gateway"), "1");

    const readiness = await fetch(`http://127.0.0.1:${port}/__llm_gateway/readiness`);
    assert.equal(readiness.status, 200);
    assert.equal(readiness.headers.get("x-llm-gateway"), "1");
    assert.deepEqual(await readiness.json(), {
      ready: true,
      default_model: "swe-1-6-slow",
      openai_base_path: "/openai/v1",
      claude_base_path: "/claude",
      providers: {
        devin: {
          ready: true,
          models: ["swe-1-6-slow", "swe-1-7-lightning"],
        },
        grok: {
          ready: true,
          models: ["grok-4.5"],
        },
      },
    });
  } finally {
    await close(endpoint);
  }
});

test("reports not ready after the internal transport stops", async () => {
  const upstream = createServer();
  const upstreamPort = await listen(upstream);
  const endpoint = createOpenAIEndpoint({
    upstreamPort,
    isUpstreamReady: () => upstream.listening,
  });
  const port = await listen(endpoint);
  try {
    const ready = await fetch(`http://127.0.0.1:${port}/__llm_gateway/readiness`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).ready, true);

    await close(upstream);
    const unavailable = await fetch(`http://127.0.0.1:${port}/__llm_gateway/readiness`);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("x-llm-gateway"), "1");
    assert.equal((await unavailable.json()).ready, false);
  } finally {
    await close(endpoint);
    if (upstream.listening) await close(upstream);
  }
});

test("keeps provider readiness and failures independent", async () => {
  let grokRequests = 0;
  const grok = createServer((request, response) => {
    grokRequests += 1;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "resp_grok", object: "response", output: [] }));
    });
  });
  const grokPort = await listen(grok);
  const endpoint = createOpenAIEndpoint({
    providerRoutes: {
      devin: { upstreamPort: 1, isReady: () => false },
      grok: { upstreamPort: grokPort, isReady: () => true },
    },
  });
  const port = await listen(endpoint);
  try {
    const readiness = await fetch(
      `http://127.0.0.1:${port}/__llm_gateway/readiness`,
    );
    assert.equal(readiness.status, 200);
    const status = await readiness.json();
    assert.equal(status.providers.devin.ready, false);
    assert.equal(status.providers.grok.ready, true);

    const devin = await fetch(`http://127.0.0.1:${port}/openai/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "swe-1-6-slow", input: "hello" }),
    });
    assert.equal(devin.status, 503);
    assert.deepEqual(await devin.json(), {
      error: {
        type: "provider_unavailable",
        message: "devin is not ready. Run `llm-gateway status` for details.",
        provider: "devin",
      },
    });

    const grokResponse = await fetch(
      `http://127.0.0.1:${port}/openai/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "grok-4.5", input: "hello" }),
      },
    );
    assert.equal(grokResponse.status, 200);
    assert.equal(grokRequests, 1);
  } finally {
    await close(endpoint);
    await close(grok);
  }
});

test("rejects unsupported models before contacting Grok", async () => {
  let requests = 0;
  const upstream = createServer((_request, response) => {
    requests += 1;
    response.end();
  });
  const upstreamPort = await listen(upstream);
  const endpoint = createOpenAIEndpoint({ upstreamPort });
  const port = await listen(endpoint);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "not-a-grok-model", input: "No" }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.type, "invalid_model");
    assert.equal(requests, 0);
  } finally {
    await close(endpoint);
    await close(upstream);
  }
});

test("rejects unknown routes and unsupported methods", async () => {
  const endpoint = createOpenAIEndpoint({ upstreamPort: 1 });
  const port = await listen(endpoint);
  try {
    const unknown = await fetch(`http://127.0.0.1:${port}/unknown`);
    assert.equal(unknown.status, 404);
    const models = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      method: "POST",
    });
    assert.equal(models.status, 405);
    assert.equal(models.headers.get("allow"), "GET");
    const responses = await fetch(`http://127.0.0.1:${port}/v1/responses`);
    assert.equal(responses.status, 405);
    assert.equal(responses.headers.get("allow"), "POST");
  } finally {
    await close(endpoint);
  }
});

test("rejects oversized and excessively deep requests before upstream", async () => {
  let requests = 0;
  const upstream = createServer((_request, response) => {
    requests += 1;
    response.end();
  });
  const upstreamPort = await listen(upstream);
  const endpoint = createOpenAIEndpoint({ upstreamPort });
  const port = await listen(endpoint);
  try {
    const oversized = await requestWithDeclaredLength(port, 10 * 1024 * 1024 + 1);
    assert.equal(oversized.status, 413);
    const depth = 200;
    const deep = `{"model":${"[".repeat(depth)}"nested"${"]".repeat(depth)},"input":"deep"}`;
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: deep,
    });
    assert.equal(response.status, 400);
    assert.equal(requests, 0);
  } finally {
    await close(endpoint);
    await close(upstream);
  }
});

test("rejects invalid JSON before model routing", async () => {
  let received;
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = Buffer.concat(chunks).toString("utf8");
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "upstream-invalid-json" }));
    });
  });
  const upstreamPort = await listen(upstream);
  const endpoint = createOpenAIEndpoint({ upstreamPort });
  const port = await listen(endpoint);
  try {
    const body = '{"unterminated":';
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(response.status, 400);
    assert.equal(received, undefined);
  } finally {
    await close(endpoint);
    await close(upstream);
  }
});

test("returns a stable 502 when the internal transport is unavailable", async () => {
  const unavailable = createServer();
  const upstreamPort = await listen(unavailable);
  await close(unavailable);
  const endpoint = createOpenAIEndpoint({ upstreamPort });
  const port = await listen(endpoint);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello" }),
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.type, "bridge_upstream_unavailable");
  } finally {
    await close(endpoint);
  }
});

test("cancels upstream work when the downstream client aborts", async () => {
  let markStarted;
  let markClosed;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const closed = new Promise((resolve) => { markClosed = resolve; });
  const upstream = createServer((request, response) => {
    request.resume();
    request.once("end", markStarted);
    response.once("close", markClosed);
  });
  const upstreamPort = await listen(upstream);
  const endpoint = createOpenAIEndpoint({ upstreamPort });
  const port = await listen(endpoint);
  try {
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "cancel" }),
      signal: controller.signal,
    }).catch(() => null);
    await started;
    controller.abort();
    await pending;
    await Promise.race([
      closed,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("upstream connection stayed open")), 1_000)),
    ]);
  } finally {
    await close(endpoint);
    await close(upstream);
  }
});
