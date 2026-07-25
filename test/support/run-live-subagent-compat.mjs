import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startBridge } from "../../src/service/bridge.mjs";

if (process.env.LLM_GATEWAY_LIVE_COMPAT !== "1") {
  throw new Error("Set LLM_GATEWAY_LIVE_COMPAT=1 to run bounded live compatibility probes");
}

const bridgeBase = process.env.LLM_GATEWAY_LIVE_BASE ?? "http://127.0.0.1:4317";
const bridgeUrl = new URL(bridgeBase);
assert.equal(bridgeUrl.hostname, "127.0.0.1", "live bridge must use loopback");
const bridgePort = Number(bridgeUrl.port || "80");
assert.ok(Number.isInteger(bridgePort) && bridgePort > 0, "live bridge requires an explicit loopback port");
const model = process.env.LLM_GATEWAY_LIVE_MODEL ?? "grok-4.5";
assert.equal(model, "grok-4.5", "only the verified Grok 4.5 model is allowed");
const repeats = Number(process.env.LLM_GATEWAY_LIVE_REPEATS ?? 3);
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 5, "repeat count must be between 1 and 5");
const selectedHarnesses = new Set((process.env.LLM_GATEWAY_LIVE_HARNESSES ?? "codex,claude").split(",").map((value) => value.trim()));
assert.ok([...selectedHarnesses].every((value) => ["codex", "claude"].includes(value)), "harness selection must contain only codex and/or claude");
const requireCodexExec = process.env.LLM_GATEWAY_LIVE_CODEX_EXEC === "1";

const routerRoot = resolve(process.cwd(), process.env.HARNESS_MODEL_ROUTER_ROOT ?? "../harness-model-router");
try {
  await access(resolve(routerRoot, "dist/config.js"));
} catch {
  throw new Error(`A built harness-model-router checkout is required. Set HARNESS_MODEL_ROUTER_ROOT to its path (looked in ${routerRoot}).`);
}
const { defaultConfig, saveConfig } = await import(resolve(routerRoot, "dist/config.js"));
const { createGateway } = await import(resolve(routerRoot, "dist/gateway.js"));
const { installIntegration } = await import(resolve(routerRoot, "dist/lifecycle.js"));
const root = await mkdtemp(resolve(tmpdir(), "llm-gateway-child-only-"));
const bridgeRecords = [];
const servers = [];
let bridge;

try {
  bridge = await startBridge({
    env: {
      ...process.env,
      LLM_GATEWAY_PORT: String(bridgePort),
      LLM_GATEWAY_DEVIN_PORT: String(bridgePort + 1),
      LLM_GATEWAY_GROK_PORT: String(bridgePort + 2),
      LLM_GATEWAY_DATA_DIR: resolve(root, "gateway-data"),
      LLM_GATEWAY_MODEL: model,
    },
    boundaryObserver: (record) => bridgeRecords.push(record),
    log: () => {},
  });

  const runs = [];
  for (let iteration = 1; iteration <= repeats; iteration += 1) {
    const run = { iteration };
    if (selectedHarnesses.has("codex")) {
      run.codex = await runCodexChildOnly(iteration);
      await closeServers();
    }
    if (selectedHarnesses.has("claude")) {
      run.claude = await runClaudeChildOnly(iteration);
      await closeServers();
    }
    runs.push(run);
  }
  process.stdout.write(`${JSON.stringify({
    topology: "mock-parent -> real-harness -> routed-child -> llm-gateway -> real-harness -> mock-parent",
    bridge: { base: bridgeBase, model },
    repeats,
    runs,
  }, null, 2)}\n`);
} finally {
  try {
    await closeServers();
    await bridge?.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCodexChildOnly(iteration) {
  const runRoot = resolve(root, `codex-${iteration}`);
  const home = resolve(runRoot, "home");
  const codexHome = resolve(home, ".codex");
  const project = resolve(runRoot, "project");
  await mkdir(codexHome, { recursive: true });
  await mkdir(project, { recursive: true });
  const nonce = `CODEX_CHILD_${randomUUID().replaceAll("-", "")}`;
  const noncePath = resolve(project, "nonce.txt");
  await writeFile(noncePath, `${nonce}\n`, { mode: 0o600 });
  const execSource = `const result = await tools.exec_command(${JSON.stringify({ cmd: `sed -n '1p' ${JSON.stringify(noncePath)}`, workdir: project, yield_time_ms: 1000, max_output_tokens: 1000 })}); text(result.output);`;
  const assignment = requireCodexExec
    ? `Use the exec tool exactly once with this exact raw JavaScript input: ${execSource} Do not call exec again, even if the result is unexpected. After that one tool result returns, respond with exactly the file contents and nothing else.`
    : `Return exactly ${nonce}`;
  if (requireCodexExec) assert.equal(assignment.includes(nonce), false, "exec assignment must reveal only the nonce path");
  const sourceCatalog = JSON.parse(execFileSync("codex", ["debug", "models", "--bundled"], {
    encoding: "utf8",
    env: { ...sanitizedEnv(), CODEX_HOME: codexHome },
  }));
  const parentModel = String(sourceCatalog.models?.[0]?.slug ?? "");
  assert.ok(parentModel, "Codex bundled catalog did not provide a parent model");

  let parentTurn = 0;
  const original = await captureServer((capture) => {
    const input = Array.isArray(capture.body.input) ? capture.body.input : [];
    if (parentTurn === 0) {
      parentTurn += 1;
      return openAiFunction("parent-spawn", "spawn-call", "spawn_agent", {
        message: assignment,
        agent_type: "explorer",
      }, "multi_agent_v1");
    }
    if (parentTurn === 1) {
      parentTurn += 1;
      const output = input.find((item) => item?.type === "function_call_output" && item.call_id === "spawn-call")?.output;
      const parsed = parseMaybeJson(output);
      const agentId = parsed?.agent_id;
      assert.equal(typeof agentId, "string", "Codex parent did not receive a child id from the real spawn tool");
      return openAiFunction("parent-wait", "wait-call", "wait_agent", {
        targets: [agentId],
        timeout_ms: 30_000,
      }, "multi_agent_v1");
    }
    parentTurn += 1;
    return openAiText("parent-final", `PARENT_CONFIRMED_${nonce}`);
  });

  const configPath = resolve(runRoot, "router/config.json");
  const config = defaultConfig(runRoot);
  config.harnesses.codex.enabled = true;
  config.harnesses.codex.originalUpstream.baseUrl = original.url;
  config.harnesses.codex.parentModels = [parentModel];
  config.harnesses.codex.sourceCatalogPath = resolve(runRoot, "source-catalog.json");
  config.routes.codex.explorer = {
    enabled: true,
    alias: "router-explorer",
    model,
    upstream: { baseUrl: `${bridgeBase}/openai/v1`, protocol: "openai-responses" },
    requiredMultiAgentVersion: "v1",
  };
  await writeFile(config.harnesses.codex.sourceCatalogPath, `${JSON.stringify(sourceCatalog)}\n`, { mode: 0o600 });
  await saveConfig(configPath, config);
  const routerLog = [];
  const gateway = await createGateway({ configPath, logger: (record) => routerLog.push(record) });
  await listen(gateway.server, config.gateway.port);
  servers.push(gateway.server);

  await writeFile(resolve(codexHome, "config.toml"), [
    `model = ${JSON.stringify(parentModel)}`,
    'model_provider = "original"',
    "",
    "[model_providers.original]",
    'name = "Deterministic parent mock"',
    `base_url = ${JSON.stringify(`${original.url}/v1`)}`,
    'env_key = "CODEX_PARENT_MOCK_KEY"',
    'wire_api = "responses"',
    "",
    "[features]",
    "multi_agent = true",
    "multi_agent_v2 = false",
    "remote_plugin = false",
    "plugins = false",
    "apps = false",
    "",
  ].join("\n"), { mode: 0o600 });
  const installed = await installIntegration(configPath, {
    home,
    project,
    cliPath: resolve(routerRoot, "dist/cli.js"),
    nodePath: process.execPath,
  });
  assert.deepEqual(installed.conflicts, []);

  const recordStart = bridgeRecords.length;
  const result = await run("codex", [
    "exec",
    "--dangerously-bypass-hook-trust",
    "--skip-git-repo-check",
    "--ephemeral",
    "--json",
    `Delegate one exploration task whose complete assignment is: ${assignment}. Wait for it, then finish.`,
  ], {
    cwd: project,
    env: { ...sanitizedEnv(), CODEX_HOME: codexHome, CODEX_PARENT_MOCK_KEY: "dummy-local-key" },
    timeoutMs: 75_000,
  });
  const records = bridgeRecords.slice(recordStart).filter((record) => record.protocol === "openai");
  const publicRequests = matching(records, "public_endpoint", "request");
  const internalRequests = matching(records, "internal_transport", "request");
  const publicResponses = matching(records, "public_endpoint", "response");
  const expectedChildTurns = requireCodexExec ? 2 : 1;
  assert.equal(publicRequests.length, expectedChildTurns, `Codex child expected ${expectedChildTurns} public inference turns`);
  assert.equal(internalRequests.length, expectedChildTurns, `Codex child expected ${expectedChildTurns} internal inference turns`);
  assert.equal(publicResponses.length, expectedChildTurns, `Codex child expected ${expectedChildTurns} public responses`);
  const publicRequest = publicRequests[0];
  const internalRequest = internalRequests[0];
  const publicResponse = publicResponses.at(-1);
  const streamingEvents = [...new Set(publicResponses.flatMap((response) => response.stream_event_types))];
  assert.equal(publicRequest.body.model, model);
  assert.equal(internalRequest.body.model, model);
  assert.ok(publicRequest.body.input.text_hashes.includes(hash(assignment)), "Codex child assignment was not readable on the real wire");
  assert.ok(publicRequest.body.additional_tools.names.length > 0, "Codex child did not declare additional_tools at bridge ingress");
  assert.deepEqual(internalRequest.body.tools.names, publicRequest.body.additional_tools.names);
  assert.deepEqual(internalRequest.body.tools.schema_hashes, publicRequest.body.additional_tools.schema_hashes);
  assert.equal(internalRequest.body.additional_tools.count, 0);
  assert.equal(internalRequest.body.tools.names.includes("spawn_agent"), false);
  assert.equal(internalRequest.body.tools.names.includes("wait_agent"), false);
  const codingTools = internalRequest.body.tools.names.filter((name) => /shell|exec|read|grep|apply_patch/i.test(String(name)));
  let execProof = null;
  if (requireCodexExec) {
    const emittedCalls = publicResponses.flatMap((response) => response.tool_calls);
    assert.equal(emittedCalls.length, 1, "Grok must emit exactly one child tool call");
    assert.equal(emittedCalls[0].type, "custom_tool_call");
    assert.equal(emittedCalls[0].name, "exec");
    assert.equal(emittedCalls[0].invokes_exec_command, true, "Grok exec payload did not invoke tools.exec_command");
    assert.equal(publicRequests[1].body.input.function_calls.filter((call) => call.type === "custom_tool_call" && call.name === "exec").length, 1);
    assert.equal(publicRequests[1].body.input.function_call_outputs, 1, "Codex did not return the local exec result to the child");
    assert.ok(publicRequests[1].body.input.function_call_output_token_hashes.includes(hash(nonce)), "local exec output did not carry the file nonce into the second child turn");
    if (publicResponses[1]) {
      assert.equal(publicResponses[1].tool_calls.length, 0, "second Grok turn unexpectedly emitted another tool call");
      assert.ok(
        publicResponses[1].stream_event_types.includes("response.completed"),
        `second Grok inference turn did not complete: ${JSON.stringify({
          events: publicResponses[1].stream_event_types,
          status: publicResponses[1].status,
          error_type: publicResponses[1].error_type,
          codex_completed: result.stdout.includes(`PARENT_CONFIRMED_${nonce}`),
          codex_stderr: result.stderr.slice(-2_000),
          request_tool_names: publicRequests[1].body.tools.names,
          request_additional_tool_names: publicRequests[1].body.additional_tools.names,
          request_input_item_types: publicRequests[1].body.input.item_types,
        })}`,
      );
    }
    const childIds = publicRequests.map((request) => request.headers["thread-id"]?.sha256);
    assert.ok(childIds.every(Boolean), "Codex child thread identity header was missing");
    assert.equal(new Set(childIds).size, 1, "tool result returned on a different Codex child thread");
    assert.ok(publicRequests.every((request) => request.headers["x-openai-subagent"]?.present === true), "Codex child identity header was not preserved");
    execProof = {
      grok_exec_calls: 1,
      emitted_custom_tool_call: true,
      exec_payload_invoked_exec_command: true,
      local_tool_results_returned: 1,
      same_child_thread: true,
      second_inference_completed: true,
    };
  }
  const parentOutputs = original.captures.flatMap((capture) => findFunctionOutputs(capture.body.input));
  assert.ok(parentOutputs.some((output) => containsExactString(parseMaybeJson(output), nonce)), "Codex parent did not receive the exact child nonce");
  assert.ok(result.stdout.includes(`PARENT_CONFIRMED_${nonce}`));
  assert.ok(original.captures.length >= 3);
  assert.ok(original.captures.every((capture) => capture.body.model === parentModel));
  assert.ok(original.captures.every((capture) => capture.url.startsWith("/v1/responses")));
  assert.ok(routerLog.some((record) => record.routed === true && record.agentType === "explorer" && record.model === model));
  assert.equal(records.some((record) => record.body?.model === "router-explorer"), false);
  assert.ok(publicResponse.stream_event_types.includes("response.completed"));
  assert.ok(internalRequests.every((request) => !request.body.tools.names.includes("spawn_agent") && !request.body.tools.names.includes("wait_agent")));
  const routedRequests = routerLog.filter((record) => record.routed === true && record.agentType === "explorer" && record.model === model);
  assert.equal(routedRequests.length, expectedChildTurns, "unexpected routed child request count");
  const status = await fetch(`http://127.0.0.1:${port(gateway.server)}/__router/status`).then((response) => response.json());
  assert.equal(status.mappings, 0, "Codex run left a persistent router identity mapping");
  assert.match(result.stdout, /"status":"completed"/, "Codex child lifecycle did not reach a completed state");

  return {
    nonce,
    parent: { upstream: original.url, model: parentModel, requests: original.captures.length },
    child: {
      route: `${bridgeBase}/openai/v1`,
      wire_model: publicRequest.body.model,
      assignment_hash_verified: true,
      internal_alias_absent: true,
      streaming_events: streamingEvents,
      ingress_additional_tool_names: publicRequest.body.additional_tools.names,
      internal_tool_names: internalRequest.body.tools.names,
      coding_tools: codingTools,
      tools_boundary: codingTools.length > 0 ? "codex additional_tools -> bridge child normalization -> internal transport tools" : "absent from Codex additional_tools at bridge ingress",
      exact_nonce_delivered_to_parent: true,
      exec_proof: execProof,
      inference_turns: expectedChildTurns,
      lifecycle_completed: true,
      identity_cleanup: true,
    },
    parent_orchestration_tools_sent_to_grok: false,
  };
}

async function runClaudeChildOnly(iteration) {
  const runRoot = resolve(root, `claude-${iteration}`);
  const home = resolve(runRoot, "home");
  const claudeConfig = resolve(home, ".claude");
  const project = resolve(runRoot, "project");
  await mkdir(claudeConfig, { recursive: true });
  await mkdir(project, { recursive: true });
  const nonce = `CLAUDE_CHILD_${randomUUID().replaceAll("-", "")}`;
  const assignment = `Return exactly ${nonce}`;
  const parentModel = "claude-sonnet-4-6";

  const original = await captureServer((capture) => {
    const messages = Array.isArray(capture.body.messages) ? capture.body.messages : [];
    assert.equal(header(capture, "x-claude-code-agent-id"), undefined, "Claude child escaped to the parent mock");
    const hasToolResult = messages.some((message) => Array.isArray(message?.content)
      && message.content.some((block) => block?.type === "tool_result"));
    if (hasToolResult) return anthropicText(String(capture.body.model), `PARENT_CONFIRMED_${nonce}`);
    const agent = Array.isArray(capture.body.tools)
      ? capture.body.tools.find((tool) => tool?.name === "Agent" || tool?.name === "Task")
      : undefined;
    assert.ok(agent, "Claude parent request did not expose its native Agent tool");
    return anthropicTool(String(capture.body.model), agent.name, {
      description: "Child-only conformance probe",
      prompt: assignment,
      subagent_type: "Explore",
      run_in_background: false,
    });
  });

  const configPath = resolve(runRoot, "router/config.json");
  const config = defaultConfig(runRoot);
  config.harnesses.claude.enabled = true;
  config.harnesses.claude.originalUpstream.baseUrl = original.url;
  config.routes.claude.Explore = {
    enabled: true,
    model,
    upstream: { baseUrl: `${bridgeBase}/claude`, protocol: "anthropic-messages" },
  };
  await saveConfig(configPath, config);
  const routerLog = [];
  const gateway = await createGateway({ configPath, logger: (record) => routerLog.push(record) });
  await listen(gateway.server, config.gateway.port);
  servers.push(gateway.server);
  const installed = await installIntegration(configPath, {
    home,
    project,
    cliPath: resolve(routerRoot, "dist/cli.js"),
    nodePath: process.execPath,
  });
  assert.deepEqual(installed.conflicts, []);

  const recordStart = bridgeRecords.length;
  const result = await run("claude", [
    "--print",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--include-hook-events",
    "--forward-subagent-text",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources", "user",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--dangerously-skip-permissions",
    "--model", parentModel,
    `Invoke Agent exactly once with subagent_type Explore and assignment: ${assignment}. Then finish.`,
  ], {
    cwd: project,
    env: {
      ...sanitizedEnv(),
      HOME: home,
      CLAUDE_CONFIG_DIR: claudeConfig,
      ANTHROPIC_API_KEY: "dummy-local-key",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTOUPDATER: "1",
    },
    timeoutMs: 75_000,
  });
  const records = bridgeRecords.slice(recordStart).filter((record) => record.protocol === "claude");
  const publicRequests = matching(records, "public_endpoint", "request");
  const internalRequests = matching(records, "internal_transport", "request");
  const publicResponses = matching(records, "public_endpoint", "response");
  assert.ok(publicRequests.length >= 1, "Claude child made no public inference requests");
  assert.equal(internalRequests.length, publicRequests.length, "Claude public and internal request counts differ");
  assert.ok(
    publicResponses.length >= 1 && publicResponses.length <= publicRequests.length,
    `Claude child recorded ${publicResponses.length} completed public responses for ${publicRequests.length} inference turns`,
  );
  const publicRequest = publicRequests[0];
  const publicResponse = publicResponses.at(-1);
  assert.ok(publicRequests.every((request) => request.body.model === model));
  assert.ok(internalRequests.every((request) => request.body.model === model));
  assert.ok(
    publicRequests.every((request, index) => request.body.sha256 !== internalRequests[index].body.sha256),
    "Claude child compatibility clause was not transformed on every turn",
  );
  assert.ok(publicRequests.some((request) => request.body.messages.text_hashes.includes(hash(assignment))), "Claude child assignment was not readable on the real wire");
  assert.ok(publicRequests.every((request) => request.headers["x-claude-code-session-id"].present === true));
  assert.ok(publicRequests.every((request) => request.headers["x-claude-code-agent-id"].present === true));
  assert.ok(publicRequests.every((request) => request.body.tools.names.includes("Agent") === false));
  const codingTools = [...new Set(publicRequests.flatMap((request) => request.body.tools.names)
    .filter((name) => /Read|Glob|Grep|Bash/i.test(String(name))))];
  assert.ok(original.captures.length >= 2);
  assert.ok(original.captures.every((capture) => capture.body.model === parentModel));
  assert.ok(result.stdout.includes(`PARENT_CONFIRMED_${nonce}`));
  assert.ok(result.stdout.includes("SubagentStart"));
  assert.ok(result.stdout.includes("SubagentStop"));
  assert.ok(routerLog.some((record) => record.routed === true && record.agentType === "Explore" && record.model === model));
  assert.ok(publicResponses.every((response) => response.stream_event_types.includes("message_stop")));
  assert.ok(publicResponses.every((response) => response.error_type === null));
  const toolResults = original.captures.flatMap((capture) => findAnthropicToolResults(capture.body.messages));
  assert.ok(
    toolResults.some((output) => containsExactString(output, nonce)),
    `Claude parent did not receive the exact child nonce: ${JSON.stringify(toolResults)}`,
  );

  const status = await fetch(`http://127.0.0.1:${port(gateway.server)}/__router/status`).then((response) => response.json());
  assert.equal(status.mappings, 0, "Claude SubagentStop did not clean up router identity");
  return {
    nonce,
    parent: { upstream: original.url, model: parentModel, requests: original.captures.length },
    child: {
      route: `${bridgeBase}/claude`,
      wire_model: publicRequest.body.model,
      verified_identity_headers: true,
      assignment_hash_verified: true,
      compatibility_transform_child_only: true,
      streaming_events: publicResponse.stream_event_types,
      tool_names: publicRequest.body.tools.names,
      coding_tools: codingTools,
      tools_boundary: codingTools.length > 0 ? "bridge_public_request" : "absent_before_bridge_public_request",
      exact_nonce_delivered_to_parent: true,
      inference_turns: publicRequests.length,
      subagent_stop: true,
      identity_cleanup: true,
    },
    parent_agent_tool_sent_to_grok: false,
  };
}

function matching(records, boundary, direction) {
  return records.filter((record) => record.boundary === boundary && record.direction === direction);
}

function findFunctionOutputs(input) {
  return Array.isArray(input)
    ? input.filter((item) => item?.type === "function_call_output").map((item) => item.output)
    : [];
}

function findAnthropicToolResults(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) => Array.isArray(message?.content)
    ? message.content.filter((block) => block?.type === "tool_result").map((block) => block.content)
    : []);
}

function containsExactString(value, expected) {
  if (value === expected) return true;
  if (typeof value === "string") {
    const parsed = parseMaybeJson(value);
    return parsed !== value && containsExactString(parsed, expected);
  }
  if (Array.isArray(value)) return value.some((item) => containsExactString(item, expected));
  if (value && typeof value === "object") return Object.values(value).some((item) => containsExactString(item, expected));
  return false;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

async function captureServer(responder) {
  const captures = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const capture = {
          url: request.url ?? "",
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        };
        captures.push(capture);
        const result = responder(capture);
        response.writeHead(result.status ?? 200, result.headers);
        for (const chunk of result.chunks ?? [result.body ?? ""]) response.write(chunk);
        response.end();
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error?.message ?? error) }));
      }
    });
  });
  await listen(server);
  servers.push(server);
  return { server, captures, url: `http://127.0.0.1:${port(server)}` };
}

function openAiFunction(responseId, callId, name, argumentsValue, namespace) {
  return openAiSse([
    { type: "response.created", response: { id: responseId } },
    { type: "response.output_item.done", item: { type: "function_call", call_id: callId, namespace, name, arguments: JSON.stringify(argumentsValue) } },
    completed(responseId),
  ]);
}

function openAiText(responseId, text) {
  return openAiSse([
    { type: "response.output_item.done", item: { type: "message", role: "assistant", id: `${responseId}-message`, content: [{ type: "output_text", text }] } },
    completed(responseId),
  ]);
}

function openAiSse(events) {
  return {
    headers: { "content-type": "text/event-stream" },
    chunks: events.map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`),
  };
}

function completed(id) {
  return { type: "response.completed", response: { id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } };
}

function anthropicTool(modelName, name, input) {
  const id = `msg_${randomUUID().replaceAll("-", "")}`;
  const toolId = `toolu_${randomUUID().replaceAll("-", "")}`;
  return anthropicSse([
    event("message_start", { type: "message_start", message: message(id, modelName) }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name, input: {} } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 8 } }),
    event("message_stop", { type: "message_stop" }),
  ]);
}

function anthropicText(modelName, text) {
  const id = `msg_${randomUUID().replaceAll("-", "")}`;
  const split = Math.max(1, Math.floor(text.length / 2));
  return anthropicSse([
    event("message_start", { type: "message_start", message: message(id, modelName) }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, split) } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(split) } }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } }),
    event("message_stop", { type: "message_stop" }),
  ]);
}

function anthropicSse(chunks) {
  return { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, chunks };
}

function event(name, value) { return `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`; }
function message(id, modelName) {
  return { id, type: "message", role: "assistant", model: modelName, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
}
function header(capture, name) {
  const value = capture.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }

function sanitizedEnv() {
  const env = { ...process.env };
  for (const name of [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY",
    "CODEX_HOME", "CLAUDE_CONFIG_DIR", "API_KEY", "CODEIUM_API_KEY", "CODEIUM_API_URL",
    "DATA_DIR", "DEFAULT_MODEL",
    "WINDSURFAPI_NO_OPEN", "WINDSURFAPI_SKIP_DOTENV",
  ]) delete env[name];
  return env;
}

async function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0) resolvePromise(result);
      else reject(new Error(`${command} exited with ${code ?? signal}: ${result.stderr}\n${result.stdout}`));
    });
    child.stdin.end();
  });
}

function listen(server, selectedPort = 0) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(selectedPort, "127.0.0.1", resolvePromise);
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

async function closeServers() {
  while (servers.length) await close(servers.pop());
}

function port(server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address missing");
  return address.port;
}
