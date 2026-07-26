import assert from "node:assert/strict";
import test from "node:test";
import { runDirectSmoke } from "../src/service/smoke.mjs";

function readiness(provider, { identity = true, ready = true } = {}) {
  return new Response(JSON.stringify({
    ready,
    providers: {
      [provider]: { ready },
    },
  }), {
    status: ready ? 200 : 503,
    headers: identity ? { "x-llm-local-gateway": "1" } : {},
  });
}

test("smoke verifies an OpenAI response without exposing authentication", async () => {
  const calls = [];
  const result = await runDirectSmoke({
    port: 4517,
    model: "swe-1-6-slow",
    timeoutMs: 2_000,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return readiness("devin");
      return new Response(JSON.stringify({
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "BRIDGE_OK" }],
        }],
      }));
    },
  });

  assert.deepEqual(result, {
    protocol: "openai",
    model: "swe-1-6-slow",
    text: "BRIDGE_OK",
  });
  assert.match(calls[0].url, /\/__llm_local_gateway\/readiness$/);
  assert.match(calls[1].url, /\/openai\/v1\/responses$/);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    model: "swe-1-6-slow",
    input: "Reply with exactly: BRIDGE_OK",
    max_output_tokens: 64,
    stream: false,
  });
  assert.equal(calls[1].options.headers.authorization, undefined);
});

test("smoke verifies an Anthropic response and protocol headers", async () => {
  const calls = [];
  const result = await runDirectSmoke({
    port: 4517,
    model: "grok-4.5",
    protocol: "claude",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return readiness("grok");
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "BRIDGE_OK" }],
      }));
    },
  });

  assert.equal(result.text, "BRIDGE_OK");
  assert.match(calls[1].url, /\/claude\/v1\/messages$/);
  assert.equal(calls[1].options.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(JSON.parse(calls[1].options.body).messages, [{
    role: "user",
    content: "Reply with exactly: BRIDGE_OK",
  }]);
});

test("smoke validates settings before contacting the gateway", async () => {
  const fetchImpl = async () => {
    throw new Error("must not fetch");
  };
  await assert.rejects(
    runDirectSmoke({ port: 0, fetchImpl }),
    /Invalid LLM_LOCAL_GATEWAY_PORT/,
  );
  await assert.rejects(
    runDirectSmoke({ timeoutMs: 0, fetchImpl }),
    /Invalid LLM_LOCAL_GATEWAY_TIMEOUT_MS/,
  );
  await assert.rejects(
    runDirectSmoke({ model: "unknown", fetchImpl }),
    /Unsupported gateway model/,
  );
  await assert.rejects(
    runDirectSmoke({ protocol: "unknown", fetchImpl }),
    /Unsupported bridge protocol/,
  );
});

test("smoke rejects unverified readiness, upstream errors, and wrong proofs", async () => {
  await assert.rejects(
    runDirectSmoke({
      fetchImpl: async () => readiness("devin", { identity: false }),
    }),
    /does not report devin ready/,
  );

  let calls = 0;
  await assert.rejects(
    runDirectSmoke({
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? readiness("devin")
          : new Response(JSON.stringify({ error: "fixture" }), { status: 429 });
      },
    }),
    /Direct request failed with HTTP 429/,
  );

  calls = 0;
  await assert.rejects(
    runDirectSmoke({
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? readiness("devin")
          : new Response(JSON.stringify({
              output: [{
                type: "message",
                content: [{ type: "output_text", text: "WRONG" }],
              }],
            }));
      },
    }),
    /Bridge returned "WRONG"/,
  );
});
