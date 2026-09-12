import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createOpenAIEndpoint } from "../src/http/openai-endpoint.mjs";
import { neutralizeAstraInstructions } from "../src/http/openai-endpoint.mjs";
import { resolveConnectSelector, setLiveCatalogSelectors } from "windsurf-api/src/devin-connect-models.js";

test("Astra selectors discovered from Devin reach the native wire without alias fallback", async () => {
  const { buildGetChatMessageRequest } = await import("windsurf-api/src/devin-connect.js");
  const { parseFields } = await import("windsurf-api/src/proto.js");
  const selectors = ["low", "medium", "high", "xhigh", "max"].map((effort) => `gpt-6-astra-${effort}`);
  setLiveCatalogSelectors(selectors.map((selector) => ({ selector, alias: "gpt-6-astra" })));
  for (const selector of selectors) {
    assert.deepEqual(resolveConnectSelector(selector), { selector, mapped: true });
    const wire = buildGetChatMessageRequest({ token: "fixture", model: selector, messages: [{ role: "user", content: "fixture" }] });
    assert.equal(parseFields(wire).find((field) => field.field === 21).value.toString(), selector);
  }
});

test("Astra instruction compatibility keeps user content while replacing the blocked client preamble", () => {
  const body = { model: "gpt-6-astra-low", instructions: "Codex operating instructions", input: "user task", tools: [{ type: "function" }] };
  const rewritten = neutralizeAstraInstructions(body);
  assert.equal(rewritten.input, body.input);
  assert.deepEqual(rewritten.tools, body.tools);
  assert.notEqual(rewritten.instructions, body.instructions);
  assert.equal(neutralizeAstraInstructions({ model: "swe-2-medium", instructions: body.instructions }).instructions, body.instructions);
});

test("Astra routes to Devin in both protocols and rejects conflicting or unsupported reasoning before forwarding", async () => {
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
    defaultModel: "gpt-6-astra-low",
    providerRoutes: { devin: { upstreamPort: upstream.address().port } },
  });
  await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  try {
    for (const path of ["/openai/v1/responses", "/claude/v1/messages", "/claude/v1/messages/count_tokens"]) {
      const post = async (body) => {
        const response = await fetch(`http://127.0.0.1:${endpoint.address().port}${path}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        await response.text();
        return response.status;
      };
      for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
        for (const options of [{}, { reasoning: { effort }, reasoning_effort: effort, output_config: { effort }, thinking: { type: "adaptive" } }]) {
          const body = { model: `gpt-6-astra-${effort}`, input: "fixture", messages: [], ...options };
          assert.equal(await post(body), 200);
          assert.deepEqual(received.at(-1), body);
        }
      }
      const before = received.length;
      for (const options of [
        { model: "gpt-6-astra" }, { model: "gpt-6-astra-ultra" }, { model: "gpt-6-astra-low-priority" },
        { reasoning: { effort: "high" } }, { reasoning_effort: "none" }, { output_config: { effort: "ultra" } },
        { reasoning: { effort: null } }, { thinking: { type: "disabled" } },
        { thinking: { type: "enabled", budget_tokens: 1024 } }, { thinking: { type: "adaptive", budget_tokens: 1024 } },
      ]) assert.equal(await post({ input: "fixture", messages: [], ...options }), 400);
      assert.equal(received.length, before);
    }
  } finally {
    await new Promise((resolve) => endpoint.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});
