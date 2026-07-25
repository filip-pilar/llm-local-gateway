import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

const routerRoot = resolve(process.cwd(), process.env.HARNESS_MODEL_ROUTER_ROOT ?? "../harness-model-router");
try {
  await access(resolve(routerRoot, "dist/config.js"));
} catch {
  throw new Error(`A built harness-model-router checkout is required. Set HARNESS_MODEL_ROUTER_ROOT to its path (looked in ${routerRoot}).`);
}
const { defaultConfig, saveConfig } = await import(resolve(routerRoot, "dist/config.js"));
const { createGateway } = await import(resolve(routerRoot, "dist/gateway.js"));
const { installIntegration } = await import(resolve(routerRoot, "dist/lifecycle.js"));

const codexPath = process.env.LLM_GATEWAY_CODEX_BIN ?? "codex";
const root = await mkdtemp(resolve(tmpdir(), "llm-gateway-codex-comparison-"));
const servers = [];
const version = execFileSync(codexPath, ["--version"], { encoding: "utf8" }).trim();
const minorVersion = Number(/\b0\.(\d+)\./.exec(version)?.[1] ?? 999);

try {
  const cases = [
    { name: "unrouted-built-in-explorer", routed: false, agentType: "explorer", factor: "baseline: built-in explorer, inherited provider, source model" },
    { name: "routed-built-in-explorer", routed: true, agentType: "explorer", factor: "route child alias through harness-model-router" },
    { name: "unrouted-built-in-default", routed: false, agentType: "default", factor: "role only: default instead of explorer" },
    { name: "unrouted-custom-inherited", routed: false, agentType: "probe", factor: "identity only: custom agent instead of built-in explorer", customAgent: {} },
    { name: "unrouted-custom-explicit-provider", routed: false, agentType: "probe", factor: "provider only: explicit original provider instead of inherited provider", customAgent: { modelProvider: "original" } },
    { name: "unrouted-custom-source-model", routed: false, agentType: "probe", factor: "model only: explicit source model", customAgent: { model: "parent" } },
    { name: "routed-custom-alias", routed: true, agentType: "probe", factor: "model only: router-installed alias instead of explicit source model", customAgent: { model: "parent" } },
  ];
  const comparisons = [];
  for (const comparison of cases) {
    comparisons.push(await runScenario(comparison));
    await closeServers();
  }
  const unrouted = comparisons[0];
  const routed = comparisons[1];
  const output = {
    codex: { path: codexPath, version },
    invariant: {
      parent_provider: "original custom Responses provider",
      parent_model: unrouted.parent.model,
      child_role: "explorer",
      assignment: "fresh nonce file read",
    },
    comparisons,
    attribution: compareToolBoundary(unrouted, routed),
  };
  const rendered = process.env.LLM_GATEWAY_CODEX_SUMMARY === "1"
    ? {
        codex: output.codex,
        comparisons: comparisons.map((entry) => ({
          name: entry.name,
          factor: entry.factor,
          parent_model: entry.parent.model,
          parent_upstream: entry.parent.upstream,
          child_identity: entry.child.identity,
          child_provider: entry.child.provider,
          child_model: entry.child.effective_model,
          child_tools: entry.child.tools.names,
          child_request_count: entry.child.request_count,
          streaming: entry.child.request_payloads.every((request) => request.stream),
          streaming_events: entry.child.streaming_events_returned,
          tool_execution: entry.child.tool_execution,
          lifecycle_completed: entry.child.lifecycle_completed,
          router_routed: entry.router?.logs.some((record) => record.routed === true) ?? false,
          alias_absent_at_child_upstream: entry.router?.alias_absent_at_child_upstream ?? null,
        })),
        attribution: output.attribution,
      }
    : output;
  process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
} finally {
  try {
    await closeServers();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runScenario({ name, routed, agentType, factor, customAgent }) {
  const runRoot = resolve(root, name);
  const home = resolve(runRoot, "home");
  const codexHome = resolve(home, ".codex");
  const project = resolve(runRoot, "project");
  await mkdir(codexHome, { recursive: true });
  await mkdir(project, { recursive: true });
  const nonce = `CODEX_TOOL_${randomUUID().replaceAll("-", "")}`;
  const assignment = `Use one available safe coding tool to read ${resolve(project, "nonce.txt")}, then return exactly ${nonce}`;
  await writeFile(resolve(project, "nonce.txt"), `${nonce}\n`, { mode: 0o600 });

  const bundled = JSON.parse(execFileSync(codexPath, ["debug", "models", "--bundled"], {
    encoding: "utf8",
    env: { ...sanitizedEnv(), CODEX_HOME: codexHome },
  }));
  const template = bundled.models?.[0];
  assert.ok(template, "Codex bundled catalog is empty");
  const parentModel = String(template.slug);
  if (customAgent) {
    await mkdir(resolve(codexHome, "agents"), { recursive: true });
    const lines = [
      `name = ${JSON.stringify(agentType)}`,
      'description = "Deterministic child routing probe"',
      'developer_instructions = "Complete only the assigned nonce-file task."',
    ];
    if (customAgent.model) lines.push(`model = ${JSON.stringify(customAgent.model === "parent" ? parentModel : customAgent.model)}`);
    if (customAgent.modelProvider) lines.push(`model_provider = ${JSON.stringify(customAgent.modelProvider)}`);
    await writeFile(resolve(codexHome, "agents", `${agentType}.toml`), `${lines.join("\n")}\n`, { mode: 0o600 });
  }
  const sourceCatalog = {
    ...bundled,
    models: bundled.models.map((entry) => entry.slug === parentModel
      ? { ...entry, multi_agent_version: "v1" }
      : entry),
  };
  const sourceCatalogPath = resolve(runRoot, "source-catalog.json");
  await writeFile(sourceCatalogPath, `${JSON.stringify(sourceCatalog)}\n`, { mode: 0o600 });

  let childMock;
  const childState = { requests: [], responseEvents: [], toolCall: null, toolOutputNonceObserved: false };
  if (routed) childMock = await captureServer((capture) => respondToChild(capture, childState, nonce, project));

  let parentTurn = 0;
  const parentState = { requests: [], responseEvents: [], spawnOutput: null, waitOutput: null };
  const original = await captureServer((capture) => {
    parentState.requests.push(capture);
    if (parentTurn > 0 && isChildCapture(capture, assignment)) {
      return respondToChild(capture, childState, nonce, project);
    }
    if (parentTurn === 0) {
      parentTurn += 1;
      return recordResponse(parentState, responseFunction("parent-spawn", "spawn-call", "spawn_agent", {
        message: assignment,
        agent_type: agentType,
      }, minorVersion >= 133 ? "multi_agent_v1" : undefined));
    }
    if (parentTurn === 1) {
      parentTurn += 1;
      const output = findFunctionOutput(capture.body.input, "spawn-call");
      parentState.spawnOutput = output;
      const agentId = parseMaybeJson(output)?.agent_id;
      assert.equal(typeof agentId, "string", `${name}: parent did not receive a child id`);
      return recordResponse(parentState, responseFunction("parent-wait", "wait-call", "wait_agent", {
        targets: [agentId],
        timeout_ms: 30_000,
      }, minorVersion >= 133 ? "multi_agent_v1" : undefined));
    }
    parentTurn += 1;
    parentState.waitOutput = findFunctionOutput(capture.body.input, "wait-call");
    return recordResponse(parentState, responseText("parent-final", `PARENT_CONFIRMED_${nonce}`));
  });

  let router;
  const routerLog = [];
  const configPath = resolve(runRoot, "router/config.json");
  if (routed) {
    const config = defaultConfig(runRoot);
    config.harnesses.codex.enabled = true;
    config.harnesses.codex.originalUpstream.baseUrl = original.url;
    config.harnesses.codex.parentModels = [parentModel];
    config.harnesses.codex.sourceCatalogPath = sourceCatalogPath;
    config.routes.codex[agentType] = {
      enabled: true,
      alias: `router-${agentType}`,
      model: `capture-${parentModel}`,
      upstream: { baseUrl: childMock.url, protocol: "openai-responses" },
      requiredMultiAgentVersion: "v1",
    };
    await saveConfig(configPath, config);
    router = await createGateway({ configPath, logger: (record) => routerLog.push(record) });
    await listen(router.server, config.gateway.port);
    servers.push(router.server);
  }

  await writeFile(resolve(codexHome, "config.toml"), configToml({
    model: parentModel,
    baseUrl: original.url,
    sourceCatalogPath,
  }), { mode: 0o600 });
  if (routed) {
    const installed = await installIntegration(configPath, {
      home,
      project,
      cliPath: resolve(routerRoot, "dist/cli.js"),
      nodePath: process.execPath,
    });
    assert.deepEqual(installed.conflicts, []);
  }

  const result = await run(codexPath, [
    "exec",
    ...(routed ? ["--dangerously-bypass-hook-trust"] : []),
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "--ephemeral",
    "--json",
    `Delegate exactly one ${agentType} task with this complete assignment: ${assignment}. Wait for it, then finish.`,
  ], {
    cwd: project,
    env: { ...sanitizedEnv(), CODEX_HOME: codexHome, CODEX_PARENT_MOCK_KEY: "dummy-local-key" },
    timeoutMs: 60_000,
  });

  assert.ok(result.stdout.includes(`PARENT_CONFIRMED_${nonce}`), `${name}: parent did not finish\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\nparent turns: ${parentTurn}\nparent requests: ${parentState.requests.length}\nchild requests: ${childState.requests.length}\nfirst request: ${JSON.stringify({ tools: summarizeTools((parentState.requests[0] ?? childState.requests[0])?.body?.tools), instructions: String((parentState.requests[0] ?? childState.requests[0])?.body?.instructions ?? "").slice(0, 500), input: (parentState.requests[0] ?? childState.requests[0])?.body?.input }, null, 2)}`);
  assert.ok(childState.requests.length >= 1, `${name}: no child request was captured\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\nspawn output: ${JSON.stringify(parentState.spawnOutput)}\nwait output: ${JSON.stringify(parentState.waitOutput)}\noriginal requests: ${JSON.stringify(parentState.requests.map((capture) => ({ model: capture.body?.model, subagent: capture.headers?.["x-openai-subagent"], input_types: Array.isArray(capture.body?.input) ? capture.body.input.map((item) => item?.type) : [] })), null, 2)}\nrouter logs: ${JSON.stringify(routerLog, null, 2)}`);
  assert.ok(parentState.waitOutput && JSON.stringify(parentState.waitOutput).includes(nonce), `${name}: child nonce did not return through wait_agent`);
  const firstChild = childState.requests[0];
  const routeSucceeded = routed && routerLog.some((record) => record.routed === true && record.agentType === agentType);
  const childTools = summarizeTools(requestTools(firstChild.body));
  const parentRequestsOnly = parentState.requests.filter((capture) => !isChildCapture(capture, assignment));
  assert.ok(parentRequestsOnly.every((capture) => capture.body.model === parentModel), `${name}: parent model drifted`);
  if (routed) {
    if (process.env.LLM_GATEWAY_ALLOW_ROUTE_FAILURE !== "1") {
      assert.equal(firstChild.body.model, `capture-${parentModel}`);
      assert.equal(routeSucceeded, true);
      assert.equal(JSON.stringify(firstChild.body).includes(`router-${agentType}`), false);
    }
  } else {
    assert.equal(firstChild.body.model, parentModel);
  }

  return {
    name,
    nonce,
    factor,
    parent: {
      provider: "original",
      upstream: original.url,
      model: parentModel,
      request_count: parentRequestsOnly.length,
      request_payloads: parentRequestsOnly.map(summarizeRequest),
      streaming_events_returned: [...new Set(parentState.responseEvents)],
      spawn: true,
      wait: true,
    },
    child: {
      identity: agentType,
      provider: routeSucceeded
        ? "harness-model-router -> capture Responses mock"
        : customAgent?.modelProvider
          ? `explicit ${customAgent.modelProvider} provider`
          : "inherited original provider",
      upstream: routeSucceeded ? childMock.url : original.url,
      effective_model: firstChild.body.model,
      request_count: childState.requests.length,
      request_payloads: childState.requests.map(summarizeRequest),
      tools: childTools,
      streaming_events_returned: [...new Set(childState.responseEvents)],
      tool_execution: childState.toolCall
        ? { attempted: true, ...childState.toolCall, nonce_observed_in_result: childState.toolOutputNonceObserved }
        : { attempted: false, reason: "no supported safe coding tool advertised by child" },
      exact_nonce_delivered_to_parent: true,
      lifecycle_completed: true,
    },
    router: routed ? { logs: routerLog, route_succeeded: routeSucceeded, alias_absent_at_child_upstream: routeSucceeded ? !JSON.stringify(firstChild.body).includes(`router-${agentType}`) : null } : null,
  };
}

function respondToChild(capture, state, nonce, project) {
  state.requests.push(capture);
  const priorOutput = findAnyToolOutput(capture.body.input);
  if (priorOutput !== undefined) {
    state.toolOutputNonceObserved = JSON.stringify(priorOutput).includes(nonce);
    assert.equal(state.toolOutputNonceObserved, true, "safe coding tool output did not contain the fresh nonce");
    return recordResponse(state, responseText("child-final", nonce));
  }
  const tool = chooseSafeTool(requestTools(capture.body));
  if (!tool) return recordResponse(state, responseText("child-no-tool", nonce));
  const invocation = safeInvocation(tool, resolve(project, "nonce.txt"));
  state.toolCall = { name: tool.name, namespace: tool.namespace, response_item_type: invocation.itemType };
  return recordResponse(state, responseTool("child-tool", "child-tool-call", tool, invocation));
}

function chooseSafeTool(tools) {
  const flattened = flattenTools(tools);
  return flattened.find((tool) => ["exec", "exec_command", "shell", "shell_command"].includes(tool.name))
    ?? flattened.find((tool) => /read/i.test(tool.name));
}

function safeInvocation(tool, filePath) {
  if (tool.type === "custom") {
    const command = `sed -n '1p' ${JSON.stringify(filePath)}`;
    const input = `const result = await tools.exec_command(${JSON.stringify({ cmd: command, workdir: dirname(filePath), yield_time_ms: 1000, max_output_tokens: 1000 })}); text(result.output);`;
    return { itemType: "custom_tool_call", input };
  }
  const schema = tool.schema ?? {};
  const properties = schema.properties ?? {};
  if (/read/i.test(tool.name)) {
    const key = properties.file_path ? "file_path" : properties.path ? "path" : "file_path";
    return { itemType: "function_call", arguments: JSON.stringify({ [key]: filePath }) };
  }
  const command = `sed -n '1p' ${JSON.stringify(filePath)}`;
  const args = properties.cmd
    ? { cmd: command, workdir: dirname(filePath), yield_time_ms: 1000, max_output_tokens: 1000 }
    : properties.command
      ? { command, workdir: dirname(filePath) }
      : { command };
  return { itemType: "function_call", arguments: JSON.stringify(args) };
}

function responseTool(responseId, callId, tool, invocation) {
  const item = {
    type: invocation.itemType,
    id: `${callId}-item`,
    call_id: callId,
    name: tool.name,
    ...(invocation.itemType === "custom_tool_call" ? { input: invocation.input } : { arguments: invocation.arguments }),
    status: "completed",
    ...(tool.namespace ? { namespace: tool.namespace } : {}),
  };
  return responseSse([
    { type: "response.created", response: responseShell(responseId, "in_progress") },
    { type: "response.in_progress", response: responseShell(responseId, "in_progress") },
    { type: "response.output_item.added", output_index: 0, item: { ...item, ...(invocation.itemType === "custom_tool_call" ? { input: "" } : { arguments: "" }), status: "in_progress" } },
    { type: invocation.itemType === "custom_tool_call" ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: invocation.input ?? invocation.arguments },
    { type: invocation.itemType === "custom_tool_call" ? "response.custom_tool_call_input.done" : "response.function_call_arguments.done", item_id: item.id, output_index: 0, ...(invocation.itemType === "custom_tool_call" ? { input: invocation.input } : { arguments: invocation.arguments }) },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: responseShell(responseId, "completed", [item]) },
  ]);
}

function responseFunction(responseId, callId, name, argumentsValue, namespace) {
  const item = { type: "function_call", id: `${callId}-item`, call_id: callId, namespace, name, arguments: JSON.stringify(argumentsValue), status: "completed" };
  return responseSse([
    { type: "response.created", response: responseShell(responseId, "in_progress") },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: responseShell(responseId, "completed", [item]) },
  ]);
}

function responseText(responseId, text) {
  const item = { type: "message", role: "assistant", id: `${responseId}-message`, status: "completed", content: [{ type: "output_text", annotations: [], text }] };
  return responseSse([
    { type: "response.created", response: responseShell(responseId, "in_progress") },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", annotations: [], text: "" } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text },
    { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: responseShell(responseId, "completed", [item]) },
  ]);
}

function responseShell(id, status, output = []) {
  return {
    id,
    object: "response",
    created_at: 0,
    status,
    model: "mock-model",
    output,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    usage: { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 },
  };
}

function responseSse(events) {
  return {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    chunks: events.map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`),
    eventTypes: events.map((value) => value.type),
  };
}

function recordResponse(state, response) {
  state.responseEvents.push(...response.eventTypes);
  return response;
}

function configToml({ model, baseUrl, sourceCatalogPath }) {
  return [
    `model = ${JSON.stringify(model)}`,
    'model_provider = "original"',
    `model_catalog_json = ${JSON.stringify(sourceCatalogPath)}`,
    'model_reasoning_effort = "low"',
    "",
    "[model_providers.original]",
    'name = "Deterministic Responses mock"',
    `base_url = ${JSON.stringify(`${baseUrl}/v1`)}`,
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
  ].join("\n");
}

function isChildRequest(body, assignment) {
  const input = Array.isArray(body?.input) ? body.input : [];
  return containsString(input, assignment)
    && !flattenTools(requestTools(body)).some((tool) => tool.name === "spawn_agent")
    && !input.some((item) => item?.type === "function_call" && ["spawn_agent", "wait_agent"].includes(item.name));
}

function isChildCapture(capture, assignment) {
  return typeof capture?.headers?.["x-openai-subagent"] === "string"
    || isChildRequest(capture?.body, assignment);
}

function findFunctionOutput(input, callId) {
  return Array.isArray(input)
    ? input.find((item) => item?.type === "function_call_output" && item.call_id === callId)?.output
    : undefined;
}

function findAnyToolOutput(input) {
  if (!Array.isArray(input)) return undefined;
  const item = input.find((candidate) => candidate?.type === "function_call_output" || candidate?.type === "custom_tool_call_output" || candidate?.type === "local_shell_call_output");
  return item?.output;
}

function containsString(value, expected) {
  if (value === expected) return true;
  if (typeof value === "string") return value.includes(expected);
  if (Array.isArray(value)) return value.some((item) => containsString(item, expected));
  if (value && typeof value === "object") return Object.values(value).some((item) => containsString(item, expected));
  return false;
}

function flattenTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (tool?.type !== "namespace") return [{
      name: tool?.name ?? tool?.function?.name ?? tool?.type ?? "unknown",
      type: tool?.type ?? null,
      namespace: tool?.namespace ?? null,
      schema: tool?.parameters ?? tool?.function?.parameters ?? tool?.input_schema ?? null,
    }];
    const children = tool.tools ?? tool.children ?? tool.functions ?? tool.items ?? [];
    return Array.isArray(children) ? children.map((child) => ({
      name: child?.name ?? child?.function?.name ?? child?.type ?? "unknown",
      type: child?.type ?? null,
      namespace: tool.name ?? tool.namespace ?? null,
      schema: child?.parameters ?? child?.function?.parameters ?? child?.input_schema ?? null,
    })) : [];
  });
}

function requestTools(body) {
  const additional = Array.isArray(body?.input)
    ? body.input
      .filter((item) => item?.type === "additional_tools")
      .flatMap((item) => Array.isArray(item.tools) ? item.tools : [])
    : [];
  return [...(Array.isArray(body?.tools) ? body.tools : []), ...additional];
}

function summarizeTools(tools) {
  const flat = flattenTools(tools);
  return {
    count: flat.length,
    names: flat.map((tool) => tool.name),
    types: flat.map((tool) => tool.type),
    namespaces: flat.map((tool) => tool.namespace),
    schema_hashes: flat.map((tool) => hash(stableJson(tool.schema))),
  };
}

function summarizeRequest(capture) {
  const body = capture.body;
  return {
    endpoint: capture.url,
    model: body.model ?? null,
    keys: Object.keys(body).sort(),
    bytes: Buffer.byteLength(capture.raw),
    sha256: hash(capture.raw),
    input_sha256: hash(stableJson(body.input ?? null)),
    input_item_types: Array.isArray(body.input) ? body.input.map((item) => item?.type ?? typeof item) : [typeof body.input],
    tools: summarizeTools(requestTools(body)),
    stream: body.stream === true,
    identity_hash: hash(stableJson(body.instructions ?? null)),
    headers: Object.keys(capture.headers).filter((name) => !["authorization", "x-api-key"].includes(name)).sort(),
  };
}

function compareToolBoundary(unrouted, routed) {
  if (routed.router && !routed.router.route_succeeded) return "the child remained on the original provider before reaching the routed capture upstream";
  const left = unrouted.child.tools;
  const right = routed.child.tools;
  if (left.count > 0 && right.count === 0) return "coding tools disappear between the unrouted child and the routed child request";
  if (left.count === 0 && right.count === 0) return "coding tools are absent in the real harness child request before harness-model-router routing";
  if (left.count > 0 && right.count > 0) return "coding tools survive harness-model-router routing";
  return "routed child exposes tools not present in the unrouted control";
}

async function captureServer(responder) {
  const captures = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const capture = { url: request.url ?? "", headers: request.headers, raw, body: JSON.parse(raw) };
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

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function stableJson(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function hash(value) { return createHash("sha256").update(String(value)).digest("hex"); }

function sanitizedEnv() {
  const env = { ...process.env };
  for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_HOME", "CODEX_PARENT_MOCK_KEY"]) delete env[name];
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
      else reject(new Error(`${basename(command)} exited with ${code ?? signal}: ${result.stderr}\n${result.stdout}`));
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
