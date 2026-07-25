import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  anthropicToResponses,
  countAnthropicTokens,
  createAnthropicSSETransform,
  responsesToAnthropic,
} from "../src/transport/anthropic-responses.mjs";

test("translates Anthropic system, tools, messages, and tool results to Responses", () => {
  const body = anthropicToResponses({
    model: "grok-4.5",
    max_tokens: 256,
    system: [{ type: "text", text: "Be precise", cache_control: { type: "ephemeral" } }],
    tools: [{
      name: "lookup",
      description: "Look up a value",
      input_schema: { type: "object", properties: { id: { type: "string" } } },
    }],
    tool_choice: { type: "tool", name: "lookup" },
    messages: [
      { role: "user", content: "Find A" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool_1", name: "lookup", input: { id: "A" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_1", content: "value" }],
      },
    ],
  });

  assert.equal(body.instructions, "Be precise");
  assert.equal(body.max_output_tokens, 256);
  assert.equal(body.tools[0].type, "function");
  assert.deepEqual(body.tool_choice, { type: "function", name: "lookup" });
  assert.equal(body.input[1].type, "function_call");
  assert.equal(body.input[2].type, "function_call_output");
});

test("translates a completed Responses result to Anthropic text and tool_use", () => {
  const result = responsesToAnthropic({
    id: "resp_1",
    model: "grok-4.5",
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "Checking." }],
      },
      {
        type: "function_call",
        call_id: "tool_1",
        name: "lookup",
        arguments: '{"id":"A"}',
      },
    ],
    usage: { input_tokens: 10, output_tokens: 4 },
  });

  assert.equal(result.type, "message");
  assert.deepEqual(result.content[0], { type: "text", text: "Checking." });
  assert.deepEqual(result.content[1], {
    type: "tool_use",
    id: "tool_1",
    name: "lookup",
    input: { id: "A" },
  });
  assert.equal(result.stop_reason, "tool_use");
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 4 });
});

test("reconstructs canonical Anthropic SSE text and tool-use events", async () => {
  const input = [
    'data: {"type":"response.created","response":{"id":"resp_1","model":"grok-4.5","usage":{"input_tokens":3}}}',
    'data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}',
    'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hi"}',
    'data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Hi"}',
    'data: {"type":"response.output_item.added","item":{"id":"item_1","type":"function_call","call_id":"tool_1","name":"lookup","arguments":""}}',
    'data: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":"{\\"id\\":\\"A\\"}"}',
    'data: {"type":"response.output_item.done","item":{"id":"item_1","type":"function_call","call_id":"tool_1","name":"lookup","arguments":"{\\"id\\":\\"A\\"}"}}',
    'data: {"type":"response.completed","response":{"id":"resp_1","model":"grok-4.5","status":"completed","output":[{"type":"function_call","call_id":"tool_1","name":"lookup","arguments":"{\\"id\\":\\"A\\"}"}],"usage":{"input_tokens":3,"output_tokens":2}}}',
    "",
  ].join("\n");
  const output = [];
  await new Promise((resolve, reject) => {
    Readable.from([input])
      .pipe(createAnthropicSSETransform())
      .on("data", (chunk) => output.push(chunk))
      .once("end", resolve)
      .once("error", reject);
  });
  const text = Buffer.concat(output).toString("utf8");

  assert.match(text, /event: message_start/);
  assert.match(text, /"type":"text_delta","text":"Hi"/);
  assert.match(text, /"type":"tool_use","id":"tool_1","name":"lookup"/);
  assert.match(text, /"type":"input_json_delta","partial_json":"{\\"id\\":\\"A\\"}"/);
  assert.match(text, /event: message_stop/);
});

test("provides a bounded positive local token estimate", () => {
  const count = countAnthropicTokens({
    system: "Be precise",
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
  });
  assert.equal(Number.isInteger(count), true);
  assert.equal(count > 0, true);
});
