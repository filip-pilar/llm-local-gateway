import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createOpenAIEndpoint } from "../src/http/openai-endpoint.mjs";
import {
  claudeMinimizationCandidates,
  readReplayCapture,
  responseErrorType,
} from "./support/replay-capture.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("builds focused Claude system, tool, header, and field ablations without changing the exact candidate", () => {
  const capture = {
    protocol: "claude",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-claude-code-agent-id": "agent" },
    body: {
      model: "grok-4.5",
      system: [{ type: "text", text: "identity" }, { type: "text", text: "policy" }],
      tools: [{ name: "Read" }, { name: "Agent" }],
      tool_choice: { type: "auto" },
      metadata: { user_id: "session" },
      messages: [{ role: "user", content: "task" }],
    },
  };
  const candidates = claudeMinimizationCandidates(capture);
  const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
  assert.deepEqual(byName.get("exact"), { name: "exact", headers: capture.headers, body: capture.body });
  assert.deepEqual(byName.get("without-system-block:0").body.system, [capture.body.system[1]]);
  assert.deepEqual(byName.get("only-system-block:1").body.system, [capture.body.system[1]]);
  assert.deepEqual(byName.get("without-tool:1").body.tools, [capture.body.tools[0]]);
  assert.equal(byName.get("without-header:x-claude-code-agent-id").headers["x-claude-code-agent-id"], undefined);
  assert.equal(byName.get("without-field:metadata").body.metadata, undefined);
  assert.deepEqual(capture.body.tools, [{ name: "Read" }, { name: "Agent" }]);
});

test("normalizes Anthropic and OpenAI error types for replay expectations", () => {
  assert.equal(responseErrorType(401, { type: "error", error: { type: "authentication_error" } }), "authentication_error");
  assert.equal(responseErrorType(400, { error: { type: "invalid_request_error" } }), "invalid_request_error");
  assert.equal(responseErrorType(200, { error: { type: "ignored" } }), null);
});

test("replays an external harness capture byte-for-byte through the public endpoint", {
  skip: !process.env.LLM_GATEWAY_REPLAY_CAPTURE,
}, async () => {
  const capture = await readReplayCapture(process.env.LLM_GATEWAY_REPLAY_CAPTURE);
  const received = [];
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ path: request.url, headers: request.headers, body: Buffer.concat(chunks) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(capture.protocol === "claude"
        ? JSON.stringify({ type: "message", role: "assistant", content: [] })
        : JSON.stringify({ id: "resp_replay", object: "response", output: [] }));
    });
  });
  const upstreamPort = await listen(upstream);
  const records = [];
  const endpoint = createOpenAIEndpoint({ upstreamPort, boundaryObserver: (record) => records.push(record) });
  const port = await listen(endpoint);
  const payload = Buffer.from(JSON.stringify(capture.body));
  const path = capture.protocol === "claude" ? "/claude/v1/messages?beta=true" : "/openai/v1/responses";
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: capture.headers,
      body: payload,
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.deepEqual(received[0].body, payload);
    const requests = records.filter((record) => record.direction === "request");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.sha256, requests[1].body.sha256);
  } finally {
    await close(endpoint);
    await close(upstream);
  }
});

test("runs bounded live Claude replay ablations only when explicitly enabled", {
  skip: process.env.LLM_GATEWAY_LIVE_REPLAY !== "1" || !process.env.LLM_GATEWAY_REPLAY_CAPTURE,
  timeout: 120_000,
}, async () => {
  const capture = await readReplayCapture(process.env.LLM_GATEWAY_REPLAY_CAPTURE);
  const baseUrl = process.env.LLM_GATEWAY_REPLAY_BASE_URL;
  if (!baseUrl) throw new Error("LLM_GATEWAY_REPLAY_BASE_URL is required for live replay");
  const candidates = claudeMinimizationCandidates(capture);
  const maximum = Math.min(candidates.length, Number(process.env.LLM_GATEWAY_REPLAY_LIMIT ?? 40));
  for (const candidate of candidates.slice(0, maximum)) {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages?beta=true`, {
      method: "POST",
      headers: candidate.headers,
      body: JSON.stringify(candidate.body),
    });
    const responseBody = await response.json().catch(() => null);
    const expected = capture.expectations[candidate.name];
    if (!expected) continue;
    assert.equal(response.status, expected.status, candidate.name);
    assert.equal(responseErrorType(response.status, responseBody), expected.error_type ?? null, candidate.name);
  }
});
