import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import {
  prepareGrokResponsesRequest,
  restoreGrokResponsesEvent,
  startGrokTransport,
} from "../src/transport/grok.mjs";

function fakeRequestSequence(responses, calls) {
  return (options, onResponse) => {
    const request = new EventEmitter();
    request.destroy = () => request.emit("close");
    request.end = (payload) => {
      calls.push({ options, payload: Buffer.from(payload) });
      const next = responses.shift();
      queueMicrotask(() => {
        const response = Readable.from([next.body]);
        response.statusCode = next.status;
        response.headers = next.headers ?? {
          "content-type": "text/event-stream",
        };
        onResponse(response);
      });
    };
    return request;
  };
}

function completedSSE(response) {
  return Buffer.from(
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response,
    })}\n\n`,
  );
}

async function listen(options) {
  const server = await startGrokTransport({ host: "127.0.0.1", port: 0, ...options });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1/responses`,
  };
}

test("normalizes caller-owned custom and namespace tools for xAI", () => {
  const prepared = prepareGrokResponsesRequest({
    model: "grok-4.5",
    stream: false,
    input: [
      { type: "custom_tool_call", call_id: "call_1", name: "exec", input: "return 1" },
      { type: "custom_tool_call_output", call_id: "call_1", output: "1" },
      { type: "function_call", call_id: "call_2", namespace: "files", name: "read", arguments: "{}" },
    ],
    tools: [
      { type: "custom", name: "exec", description: "Run code" },
      {
        type: "namespace",
        name: "files",
        tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
      },
    ],
  });

  assert.equal(prepared.body.stream, true);
  assert.deepEqual(
    prepared.body.tools.map(({ type, name }) => ({ type, name })),
    [
      { type: "function", name: "exec" },
      { type: "function", name: "files__read" },
    ],
  );
  assert.equal(prepared.body.input[0].type, "function_call");
  assert.equal(prepared.body.input[1].type, "function_call_output");
  assert.equal(prepared.body.input[2].name, "files__read");

  const custom = restoreGrokResponsesEvent({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: "call_1",
      name: "exec",
      arguments: '{"input":"return 1"}',
    },
  }, prepared.maps);
  assert.equal(custom.item.type, "custom_tool_call");
  assert.equal(custom.item.input, "return 1");

  const namespaced = restoreGrokResponsesEvent({
    type: "response.output_item.added",
    item: {
      type: "function_call",
      call_id: "call_2",
      name: "files__read",
      arguments: "{}",
    },
  }, prepared.maps);
  assert.equal(namespaced.item.name, "read");
  assert.equal(namespaced.item.namespace, "files");
});

test("drops provider-private reasoning while preserving visible tool history", () => {
  const prepared = prepareGrokResponsesRequest({
    model: "grok-4.5",
    input: [
      { type: "message", role: "user", content: "Run the requested check." },
      {
        type: "reasoning",
        content: null,
        encrypted_content: "foreign-provider-compaction-blob",
        summary: [],
      },
      { type: "custom_tool_call", call_id: "call_1", name: "exec", input: "return 1" },
      { type: "custom_tool_call_output", call_id: "call_1", output: "1" },
    ],
    tools: [{ type: "custom", name: "exec" }],
  });

  assert.deepEqual(
    prepared.body.input.map((item) => item?.type),
    ["message", "function_call", "function_call_output"],
  );
  assert.equal(prepared.body.input[0].content, "Run the requested check.");
  assert.equal(prepared.body.input[1].call_id, "call_1");
  assert.equal(prepared.body.input[2].output, "1");
  assert.doesNotMatch(
    JSON.stringify(prepared.body),
    /foreign-provider-compaction-blob/,
  );
});

test("qualifies and restores namespaced custom call history", () => {
  const prepared = prepareGrokResponsesRequest({
    model: "grok-4.5",
    tools: [{
      type: "namespace",
      name: "workspace",
      tools: [{ type: "custom", name: "exec" }],
    }],
    input: [{
      type: "custom_tool_call",
      namespace: "workspace",
      name: "exec",
      call_id: "call_1",
      input: "pwd",
    }],
  });
  assert.equal(prepared.body.input[0].name, "workspace__exec");
  const restored = restoreGrokResponsesEvent({
    type: "response.completed",
    response: {
      output: [{
        type: "function_call",
        name: "workspace__exec",
        call_id: "call_2",
        arguments: '{"input":"ls"}',
      }],
    },
  }, prepared.maps);
  assert.deepEqual(restored.response.output[0], {
    type: "custom_tool_call",
    namespace: "workspace",
    name: "exec",
    call_id: "call_2",
    input: "ls",
  });
});

test("uses the Grok CLI proxy and reconstructs a non-streaming Responses result", async (t) => {
  const calls = [];
  const secret = "opaque-access-token";
  const response = {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "grok-4.5",
    output: [{
      type: "function_call",
      call_id: "call_1",
      name: "exec",
      arguments: '{"input":"return 1"}',
    }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const fixture = await listen({
    credentialPath: "/fixture/auth.json",
    cliPath: "/fixture/grok",
    tokenProvider: () => secret,
    requestImpl: fakeRequestSequence([
      { status: 200, body: completedSSE(response) },
    ], calls),
  });
  t.after(() => fixture.server.close());

  const result = await fetch(fixture.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-4.5",
      input: "call the tool",
      tools: [{ type: "custom", name: "exec", description: "Run code" }],
      stream: false,
    }),
  });
  const body = await result.json();

  assert.equal(result.status, 200);
  assert.equal(body.output[0].type, "custom_tool_call");
  assert.equal(body.output[0].input, "return 1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.hostname, "cli-chat-proxy.grok.com");
  assert.equal(calls[0].options.path, "/v1/responses");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${secret}`);
  assert.equal(calls[0].options.headers["x-xai-token-auth"], "xai-grok-cli");
  assert.equal(JSON.parse(calls[0].payload).stream, true);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
});

test("refreshes through the official CLI and retries once after HTTP 401", async (t) => {
  const calls = [];
  let refreshed = 0;
  const fixture = await listen({
    credentialPath: "/fixture/auth.json",
    cliPath: "/fixture/grok",
    tokenProvider: () => refreshed ? "fresh-token" : "expired-token",
    refresh: ({ cliPath }) => {
      assert.equal(cliPath, "/fixture/grok");
      refreshed += 1;
    },
    requestImpl: fakeRequestSequence([
      { status: 401, headers: { "content-type": "application/json" }, body: Buffer.from('{"error":"expired"}') },
      {
        status: 200,
        body: completedSSE({
          id: "resp_2",
          object: "response",
          status: "completed",
          model: "grok-4.5",
          output: [],
        }),
      },
    ], calls),
  });
  t.after(() => fixture.server.close());

  const result = await fetch(fixture.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "grok-4.5", input: "hello" }),
  });

  assert.equal(result.status, 200);
  assert.equal(refreshed, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.authorization, "Bearer fresh-token");
});

test("rewrites custom tool events while preserving SSE streaming", async (t) => {
  const calls = [];
  const fixture = await listen({
    credentialPath: "/fixture/auth.json",
    cliPath: "/fixture/grok",
    tokenProvider: () => "token",
    requestImpl: fakeRequestSequence([{
      status: 200,
      body: Buffer.from([
        'event: response.output_item.added',
        'data: {"type":"response.output_item.added","item":{"id":"item_1","type":"function_call","call_id":"call_1","name":"exec","arguments":""}}',
        "",
        "event: response.function_call_arguments.delta",
        'data: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":"{\\"input\\":\\"x\\"}"}',
        "",
      ].join("\n")),
    }], calls),
  });
  t.after(() => fixture.server.close());

  const result = await fetch(fixture.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-4.5",
      input: "call exec",
      stream: true,
      tools: [{ type: "custom", name: "exec" }],
    }),
  });
  const text = await result.text();

  assert.equal(result.status, 200);
  assert.match(text, /"type":"custom_tool_call"/);
  assert.match(text, /response\.custom_tool_call_input\.delta/);
});

test("rewrites CRLF-delimited Responses SSE records", async (t) => {
  const fixture = await listen({
    credentialPath: "/fixture/auth.json",
    cliPath: "/fixture/grok",
    tokenProvider: () => "token",
    requestImpl: fakeRequestSequence([{
      status: 200,
      body: Buffer.from(
        'event: response.completed\r\ndata: {"type":"response.completed","response":{"id":"resp_crlf","status":"completed","output":[]}}\r\n\r\n',
      ),
    }], []),
  });
  t.after(() => fixture.server.close());
  const result = await fetch(fixture.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "grok-4.5", input: "hello", stream: true }),
  });
  assert.match(await result.text(), /resp_crlf/);
});

test("turns an HTTP 200 upstream SSE error into a non-streaming error", async (t) => {
  const fixture = await listen({
    credentialPath: "/fixture/auth.json",
    cliPath: "/fixture/grok",
    tokenProvider: () => "token",
    requestImpl: fakeRequestSequence([{
      status: 200,
      body: Buffer.from(
        'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"quota unavailable"}}\n\n',
      ),
    }], []),
  });
  t.after(() => fixture.server.close());
  const result = await fetch(fixture.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "grok-4.5", input: "hello" }),
  });
  assert.equal(result.status, 502);
  assert.equal((await result.json()).error.type, "rate_limit_error");
});

test("caps streaming upstream response bytes", async (t) => {
  const fixture = await listen({
    credentialPath: "/fixture/auth.json",
    cliPath: "/fixture/grok",
    tokenProvider: () => "token",
    maximumUpstreamResponseBytes: 16,
    requestImpl: fakeRequestSequence([{
      status: 200,
      body: Buffer.from("event: response.created\ndata: {}\n\n"),
    }], []),
  });
  t.after(() => fixture.server.close());
  await assert.rejects(() => fetch(fixture.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "grok-4.5", input: "hello", stream: true }),
  }));
});

test("destroys the xAI request when the loopback caller cancels", async (t) => {
  let destroyed = 0;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const fixture = await listen({
    credentialPath: "/fixture/auth.json",
    cliPath: "/fixture/grok",
    tokenProvider: () => "token",
    requestImpl: () => {
      const request = new EventEmitter();
      request.end = () => markStarted();
      request.destroy = () => {
        destroyed += 1;
        request.emit("close");
      };
      return request;
    },
  });
  t.after(() => fixture.server.close());
  const controller = new AbortController();
  const pending = fetch(fixture.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "grok-4.5", input: "hello" }),
    signal: controller.signal,
  });
  await started;
  controller.abort();
  await assert.rejects(() => pending, /abort/i);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(destroyed, 1);
});

test("serves Anthropic messages and local token counting through the Grok transport", async (t) => {
  const calls = [];
  const fixture = await listen({
    credentialPath: "/fixture/auth.json",
    cliPath: "/fixture/grok",
    tokenProvider: () => "token",
    requestImpl: fakeRequestSequence([{
      status: 200,
      body: completedSSE({
        id: "resp_anthropic",
        object: "response",
        status: "completed",
        model: "grok-4.5",
        output: [{
          type: "function_call",
          call_id: "tool_1",
          name: "lookup",
          arguments: '{"id":"A"}',
        }],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      }),
    }], calls),
  });
  t.after(() => fixture.server.close());
  const base = new URL(fixture.url);

  const result = await fetch(new URL("/v1/messages", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-4.5",
      max_tokens: 64,
      messages: [{ role: "user", content: "Find A" }],
      tools: [{
        name: "lookup",
        input_schema: { type: "object", properties: { id: { type: "string" } } },
      }],
    }),
  });
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.equal(body.type, "message");
  assert.equal(body.stop_reason, "tool_use");
  assert.deepEqual(body.content[0], {
    type: "tool_use",
    id: "tool_1",
    name: "lookup",
    input: { id: "A" },
  });
  const upstreamBody = JSON.parse(calls[0].payload);
  assert.equal(upstreamBody.max_output_tokens, 64);
  assert.equal(upstreamBody.tools[0].type, "function");

  const count = await fetch(new URL("/v1/messages/count_tokens", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-4.5",
      messages: [{ role: "user", content: "Hello" }],
    }),
  });
  const countBody = await count.json();
  assert.equal(count.status, 200);
  assert.equal(Number.isInteger(countBody.input_tokens), true);
  assert.equal(calls.length, 1);
});
