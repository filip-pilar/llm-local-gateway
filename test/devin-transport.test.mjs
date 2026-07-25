import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { neutralizeClientIdentity } from "windsurf-api/src/handlers/identity-neutralize.js";
import { handleMessages } from "windsurf-api/src/handlers/messages.js";
import {
  handleResponses,
  responsesToChat,
} from "windsurf-api/src/handlers/responses.js";

function captureStreamingResult(result) {
  const emitter = new EventEmitter();
  const chunks = [];
  emitter.writableEnded = false;
  emitter.write = (chunk) => {
    chunks.push(Buffer.from(chunk).toString("utf8"));
    return true;
  };
  emitter.end = (chunk) => {
    if (chunk) emitter.write(chunk);
    emitter.writableEnded = true;
    emitter.emit("finish");
  };
  return result.handler(emitter).then(() => chunks.join(""));
}

function sseTypes(value) {
  return value.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith("event:")) return [];
    return [line.slice(6).trim()];
  });
}

test("internal Anthropic translation preserves system intent, tools, messages, and tool-use responses", async () => {
  let translated;
  const request = {
    model: "swe-1-6-slow",
    max_tokens: 512,
    system: [
      { type: "text", text: "You are a repository inspection assistant.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Use tools when evidence is needed." },
    ],
    tools: [{
      name: "Read",
      description: "Read a file",
      input_schema: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
      },
    }],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    messages: [
      { role: "user", content: [{ type: "text", text: "Inspect package.json" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_prior", name: "Read", input: { file_path: "package.json" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_prior", content: "{}" }] },
    ],
  };
  const result = await handleMessages(request, {
    handleChatCompletions: async (body) => {
      translated = body;
      return {
        status: 200,
        body: {
          id: "chat_1",
          choices: [{
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "toolu_next",
                type: "function",
                function: { name: "Read", arguments: "{\"file_path\":\"README.md\"}" },
              }],
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      };
    },
  });

  assert.equal(translated.messages[0].role, "system");
  assert.equal(translated.messages[0].content, request.system.map(({ text }) => text).join("\n"));
  assert.deepEqual(translated.tools, [{
    type: "function",
    function: {
      name: "Read",
      description: "Read a file",
      parameters: request.tools[0].input_schema,
    },
  }]);
  assert.equal(translated.parallel_tool_calls, false);
  assert.deepEqual(translated.messages[2].tool_calls[0], {
    id: "toolu_prior",
    type: "function",
    function: { name: "Read", arguments: "{\"file_path\":\"package.json\"}" },
  });
  assert.deepEqual(translated.messages[3], { role: "tool", tool_call_id: "toolu_prior", content: "{}" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.content[0], {
    type: "tool_use",
    id: "toolu_next",
    name: "Read",
    input: { file_path: "README.md" },
  });
  assert.equal(result.body.stop_reason, "tool_use");
});

test("internal Anthropic transport reconstructs canonical streaming tool-use events", async () => {
  const result = await handleMessages({
    model: "swe-1-6-slow",
    max_tokens: 128,
    stream: true,
    messages: [{ role: "user", content: "Read README.md" }],
    tools: [{ name: "Read", input_schema: { type: "object" } }],
  }, {
    handleChatCompletions: async () => ({
      status: 200,
      stream: true,
      async handler(response) {
        response.write('data: {"id":"chat_1","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
        response.write('data: {"id":"chat_1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_stream","type":"function","function":{"name":"Read","arguments":"{\\"file_"}}]},"finish_reason":null}]}\n\n');
        response.write('data: {"id":"chat_1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"path\\":\\"README.md\\"}"}}]},"finish_reason":null}]}\n\n');
        response.write('data: {"id":"chat_1","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n');
        response.end('data: [DONE]\n\n');
      },
    }),
  });
  const output = await captureStreamingResult(result);
  const types = sseTypes(output);
  assert.equal(types[0], "message_start");
  assert.ok(types.includes("content_block_start"));
  assert.ok(types.includes("content_block_delta"));
  assert.ok(types.includes("content_block_stop"));
  assert.ok(types.includes("message_delta"));
  assert.equal(types.at(-1), "message_stop");
  assert.match(output, /"type":"tool_use"/);
  assert.match(output, /"type":"input_json_delta"/);
  assert.match(output, /"stop_reason":"tool_use"/);
});

test("internal Responses translation preserves child instructions, coding tools, history, and namespaces", async () => {
  const request = {
    model: "swe-1-6-slow",
    instructions: "Use the workspace coding tools when evidence or edits are needed.",
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
      { type: "message", role: "user", content: [{ type: "input_text", text: "Update the file." }] },
      { type: "function_call", call_id: "call_prior", name: "workspace__apply_patch", arguments: "{\"patch\":\"prior\"}" },
      { type: "function_call_output", call_id: "call_prior", output: "done" },
    ],
  };
  const translated = responsesToChat(request);
  assert.deepEqual(translated.messages, [
    { role: "system", content: request.instructions },
    { role: "user", content: [{ type: "text", text: "Update the file." }] },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_prior",
        type: "function",
        function: { name: "workspace__apply_patch", arguments: "{\"patch\":\"prior\"}" },
      }],
    },
    { role: "tool", tool_call_id: "call_prior", content: "done" },
  ]);
  assert.equal(translated.tools[0].function.name, "workspace__apply_patch");
  assert.deepEqual(translated.tools[0].function.parameters, request.tools[0].tools[0].parameters);

  const result = await handleResponses(request, {
    handleChatCompletions: async () => ({
      status: 200,
      body: {
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_spawn",
              type: "function",
              function: { name: "workspace__apply_patch", arguments: "{\"patch\":\"*** Begin Patch\"}" },
            }],
          },
        }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      },
    }),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.output[0], {
    type: "function_call",
    id: result.body.output[0].id,
    call_id: "call_spawn",
    name: "apply_patch",
    namespace: "workspace",
    arguments: "{\"patch\":\"*** Begin Patch\"}",
    status: "completed",
  });
});

test("internal Responses transport reconstructs namespaced streaming coding-tool calls", async () => {
  const result = await handleResponses({
    model: "swe-1-6-slow",
    stream: true,
    input: "Apply the requested edit.",
    tools: [{
      type: "namespace",
      name: "workspace",
      tools: [{ type: "function", name: "apply_patch", parameters: { type: "object" } }],
    }],
  }, {
    handleChatCompletions: async () => ({
      status: 200,
      stream: true,
      async handler(response) {
        response.write('data: {"id":"chat_1","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
        response.write('data: {"id":"chat_1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_patch","type":"function","function":{"name":"workspace__apply_patch","arguments":"{\\"patch\\":"}}]},"finish_reason":null}]}\n\n');
        response.write('data: {"id":"chat_1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"edit\\"}"}}]},"finish_reason":null}]}\n\n');
        response.write('data: {"id":"chat_1","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}\n\n');
        response.end('data: [DONE]\n\n');
      },
    }),
  });
  const output = await captureStreamingResult(result);
  const types = sseTypes(output);
  assert.equal(types[0], "response.created");
  assert.ok(types.includes("response.output_item.added"));
  assert.ok(types.includes("response.function_call_arguments.delta"));
  assert.ok(types.includes("response.function_call_arguments.done"));
  assert.ok(types.includes("response.output_item.done"));
  assert.equal(types.at(-1), "response.completed");
  assert.match(output, /"type":"function_call"/);
  assert.match(output, /"name":"apply_patch"/);
  assert.match(output, /"namespace":"workspace"/);
});

test("known Claude Code rejection fingerprints are changed only inside the internal transport", async () => {
  const cases = [
    ["You are Claude Code, Anthropic's official CLI for Claude.", "You are an AI coding assistant."],
    ["You are a Claude agent, built on Anthropic's Claude Agent SDK.", "You are an AI coding assistant."],
    ["x-anthropic-billing-header: cc_version=2.1.204; cc_entrypoint=sdk-cli;\nDo the task.", "Do the task."],
  ];
  for (const [input, expected] of cases) assert.equal(neutralizeClientIdentity(input), expected);
  const neighbor = "You are a coding agent built for repository inspection.";
  assert.equal(neutralizeClientIdentity(neighbor), neighbor);

  let translated;
  await handleMessages({
    model: "swe-1-6-slow",
    max_tokens: 16,
    system: cases[1][0],
    messages: [{ role: "user", content: "hello" }],
  }, {
    handleChatCompletions: async (body) => {
      translated = body;
      return { status: 200, body: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }] } };
    },
  });
  assert.equal(translated.messages[0].content, cases[1][1]);
});
