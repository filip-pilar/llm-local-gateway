import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createOpenAIEndpoint } from "../src/http/openai-endpoint.mjs";
import { isolatedClaudeEnvironment, swe2LaunchOptions } from "../src/interfaces/claude-swe2.mjs";
import { refreshDevinCatalog } from "../src/transport/devin.mjs";
import { resolveConnectSelector, setLiveCatalogSelectors } from "windsurf-api/src/devin-connect-models.js";
import { buildGetChatMessageRequest, pairSwe2ToolHistory } from "windsurf-api/src/devin-connect.js";
import { parseFields } from "windsurf-api/src/proto.js";

test("the pinned transport pairs complete parallel SWE-2 tool histories on the native wire", () => {
  const calls = ["a", "b"].map((id) => ({ id, type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: `/${id}` }) } }));
  const results = calls.map((call) => ({ role: "tool", tool_call_id: call.id, content: `result ${call.id}` }));
  for (const assistants of [
    [{ role: "assistant", content: "Inspecting files.", tool_calls: calls }],
    calls.map((call) => ({ role: "assistant", content: null, tool_calls: [call] })),
  ]) {
    const messages = [{ role: "user", content: "Read both" }, ...assistants, ...results, { role: "user", content: "Continue" }];
    const before = structuredClone(messages);
    const wire = (model) => parseFields(buildGetChatMessageRequest({
      token: "fixture", model, messages, nativeToolCall: true,
    })).filter((f) => f.field === 3).map((f) => parseFields(f.value));
    const toolOrder = (model) => wire(model).flatMap((fields) => {
      const call = fields.find((f) => f.field === 6);
      const result = fields.find((f) => f.field === 7);
      return call ? [`call:${parseFields(call.value).find((f) => f.field === 1).value}`]
        : result ? [`result:${result.value}`] : [];
    });
    for (const model of ["swe-2-medium", "swe-2-high", "swe-2-max"]) {
      assert.deepEqual(toolOrder(model), ["call:a", "result:a", "call:b", "result:b"]);
    }
    assert.deepEqual(toolOrder("swe-1-7-lightning"), ["call:a", "call:b", "result:a", "result:b"]);
    const paired = pairSwe2ToolHistory(messages);
    assert.equal(paired[0], messages[0]);
    assert.equal(paired.at(-1), messages.at(-1));
    assert.deepEqual(paired.filter((m) => m.role === "tool"), results);
    assert.deepEqual(messages, before);
  }
  const batch = { role: "assistant", content: null, tool_calls: calls };
  for (const messages of [
    [batch, results[0]],
    [batch, results[0], results[0]],
    [batch, ...results, { role: "tool", tool_call_id: "orphan", content: "extra" }],
    [{ ...batch, tool_calls: [calls[0], calls[0]] }, ...results],
  ]) {
    assert.deepEqual(pairSwe2ToolHistory(messages), messages);
  }
  assert.deepEqual(pairSwe2ToolHistory([batch, ...results.toReversed()]).filter((m) => m.role === "tool"), results);
});

test("an awaited Devin catalog refresh resolves SWE-2 independently of Cascade discovery", async () => {
  let completeFetch;
  const pending = new Promise((resolve) => { completeFetch = resolve; });
  let published = false;
  const refresh = refreshDevinCatalog({
    token: "fixture",
    fetchCatalog: ({ token, signal }) => {
      assert.equal(token, "fixture");
      assert.ok(signal instanceof AbortSignal);
      return pending;
    },
    setLiveCatalogSelectors: (rows) => { published = true; setLiveCatalogSelectors(rows); },
  });
  assert.equal(published, false);
  const selectors = ["swe-2-medium", "swe-2-high", "swe-2-max"];
  completeFetch(selectors.map((selector) => ({ selector, alias: "swe-2" })));
  assert.equal(await refresh, true);
  for (const selector of selectors) {
    assert.deepEqual(resolveConnectSelector(selector), { selector, mapped: true });
  }
  assert.equal(await refreshDevinCatalog({
    token: "fixture",
    fetchCatalog: async () => { throw new Error("private upstream detail"); },
    setLiveCatalogSelectors: () => assert.fail("failed discovery must not overwrite the catalog"),
  }), false);
  assert.deepEqual(resolveConnectSelector("swe-1-6-slow"), { selector: "swe-1-6-slow", mapped: true });
});

test("SWE-2 requests preserve exact selectors and reject unsupported reasoning before forwarding", async () => {
  const received = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks)));
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const endpoint = createOpenAIEndpoint({
    defaultModel: "swe-2-medium",
    providerRoutes: { devin: { upstreamPort: upstream.address().port } },
  });
  await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const post = (path, body) => fetch(`http://127.0.0.1:${endpoint.address().port}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    for (const path of ["/claude/v1/messages", "/openai/v1/responses", "/claude/v1/messages/count_tokens"]) {
      for (const effort of ["medium", "high", "max"]) {
        const body = { model: `swe-2-${effort}`, messages: [], input: "fixture", max_tokens: 16,
          output_config: { effort }, reasoning: { effort }, thinking: { type: "adaptive" } };
        const response = await post(path, body);
        assert.equal(response.status, 200);
        await response.text();
        assert.deepEqual(received.at(-1), body);
      }
      const before = received.length;
      for (const options of [
        { model: "swe-2-low" }, { model: "swe-2" },
        { reasoning_effort: "low" }, { reasoning: { effort: "xhigh" } },
        { output_config: { effort: "high" } }, { output_config: { effort: "max" } },
        { output_config: { effort: 123 } }, { output_config: { effort: null } },
        { thinking: { type: "enabled", budget_tokens: 1024 } }, { thinking: { type: "disabled" } },
      ]) {
        const response = await post(path, { messages: [], input: "fixture", ...options });
        assert.equal(response.status, 400);
        const error = await response.json();
        assert.ok(error.error.message);
      }
      assert.equal(received.length, before);
    }
  } finally {
    await new Promise((resolve) => endpoint.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("the isolated Claude launcher never inherits provider secrets or everyday routing", () => {
  const options = swe2LaunchOptions(["high", "--print", "fixture"], { LLM_LOCAL_GATEWAY_PORT: "4817" });
  assert.equal(options.model, "swe-2-high");
  const env = isolatedClaudeEnvironment({
    PATH: "/bin", HOME: "/fixture/home", CODEIUM_API_KEY: "secret",
    ANTHROPIC_AUTH_TOKEN: "secret", CLAUDE_CODE_OAUTH_TOKEN: "secret",
    AWS_ACCESS_KEY_ID: "secret", CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CONFIG_DIR: "/everyday", ANTHROPIC_BASE_URL: "https://upstream.example",
  }, "/scratch/claude", options);
  assert.equal(JSON.stringify(env).includes("secret"), false);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4817/claude");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/scratch/claude");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "swe-2-high");
  for (const args of [["low"], ["medium", "--model=other"], ["max", "--fallback-model", "other"]]) {
    assert.throws(() => swe2LaunchOptions(args, {}));
  }
});
