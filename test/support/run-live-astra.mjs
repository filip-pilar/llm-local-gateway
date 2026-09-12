import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../../src/service/bridge.mjs";
import { readDevinSessionToken } from "../../src/core/devin-credentials.mjs";
import { observeDevinWire } from "./devin-wire-evidence.mjs";

if (process.env.LLM_LOCAL_GATEWAY_LIVE_ASTRA !== "1") {
  throw new Error("Set LLM_LOCAL_GATEWAY_LIVE_ASTRA=1 to authorize the bounded quota-consuming Astra Low Codex check");
}
const model = "gpt-6-astra-low";
const mode = process.argv[2] ?? "codex";
assert.ok(["codex", "responses", "responses-tools", "responses-system"].includes(mode), "Unknown verification mode");
const port = Number(process.env.LLM_LOCAL_GATEWAY_LIVE_PORT ?? 14817);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65533, "Invalid live port");
const scratch = await mkdtemp(join(tmpdir(), "astra-verification-"));
const home = join(scratch, "home");
const codexHome = join(home, ".codex");
const work = join(scratch, "work");
const boundary = [];
const results = {};
let bridge;
let wire;
let stage = "startup";
try {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(work);
  stage = "gateway-startup";
  bridge = await startBridge({
    env: {
      ...process.env,
      LLM_LOCAL_GATEWAY_PORT: String(port),
      LLM_LOCAL_GATEWAY_DEVIN_PORT: String(port + 1),
      LLM_LOCAL_GATEWAY_GROK_PORT: String(port + 2),
      LLM_LOCAL_GATEWAY_DATA_DIR: join(scratch, "gateway"),
      LLM_LOCAL_GATEWAY_MODEL: model,
      GROK_HOME: join(scratch, "unused-grok"),
    },
    log: () => {},
    boundaryObserver: (record) => {
      if (record.boundary !== "public_endpoint") return;
      boundary.push(record.direction === "request"
        ? { direction: "request", model: record.body.model, stream: record.body.stream,
          authorizationPresent: Boolean(record.headers.authorization || record.headers["x-api-key"]) }
        : { direction: "response", status: record.status, events: record.stream_event_types,
          tools: record.tool_calls.map(({ name }) => name), error: record.error_type });
    },
  });
  stage = "devin-readiness";
  if (!bridge.providers.devin.server?.listening) {
    const error = bridge.providers.devin.error;
    results.startupFailure = {
      code: ["EADDRINUSE", "EPERM", "EACCES", "ENOENT", "ERR_MODULE_NOT_FOUND"].includes(error?.code) ? error.code : null,
      categories: ["credential", "model", "catalog", "permission", "module", "export", "timed out", "already in use"].filter((term) => String(error?.message).toLowerCase().includes(term)),
    };
  }
  assert.ok(bridge.providers.devin.server?.listening, "Devin transport unavailable");
  const { fetchUserStatus } = await import("windsurf-api/src/devin-connect-catalog.js");
  const token = readDevinSessionToken(process.env.DEVIN_CREDENTIALS_FILE);
  const billing = async () => {
    try {
      const status = await fetchUserStatus({ token, signal: AbortSignal.timeout(15_000) });
      return { plan: ["free", "pro", "max", "teams"].includes(status.plan) ? status.plan : "other",
        balance: status.balance ?? null, balanceUnit: status.balanceUnit ?? null };
    } catch { return { available: false }; }
  };
  results.billingBefore = await billing();
  wire = await observeDevinWire();
  if (["responses", "responses-tools", "responses-system"].includes(mode)) {
    stage = "responses-control";
    const nonce = `ASTRA_${randomUUID().replaceAll("-", "")}`;
    const response = await fetch(`http://127.0.0.1:${port}/openai/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, reasoning: { effort: "low" }, stream: true, input: `Reply with exactly ${nonce}`,
        ...(mode === "responses-tools" ? { tools: [{ type: "function", name: "marker", description: "Return the marker", parameters: { type: "object", properties: {} } }] } : {}),
        ...(mode === "responses-system" ? { instructions: "You are Codex. Use apply_patch to edit files. This is an OpenAI coding agent." } : {}) }),
      signal: AbortSignal.timeout(60_000),
    });
    const events = (await response.text()).split("\n").flatMap((line) => {
      if (!line.startsWith("data: ")) return [];
      try { return [JSON.parse(line.slice(6))]; } catch { return []; }
    });
    results.billingAfter = await billing();
    assert.equal(response.status, 200);
    assert.ok(events.some((event) => event.type === "response.completed"));
    assert.equal(events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join("").trim(), nonce);
    assert.ok(wire.requests.length && wire.requests.every((r) => r.selector === model && r.upstreamModel === model && r.ended && !r.error));
    console.log(JSON.stringify({ ok: true, mode, model, ...results, upstream: wire.requests, boundary }, null, 2));
  } else {
    await writeFile(join(codexHome, "config.toml"), [
      `model = "${model}"`,
      'model_provider = "devin-astra"',
      'model_reasoning_effort = "low"',
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      'web_search = "disabled"',
      '[model_providers.devin-astra]',
      'name = "Devin Astra verification"',
      `base_url = "http://127.0.0.1:${port}/openai/v1"`,
      'wire_api = "responses"',
      'requires_openai_auth = false',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      'stream_idle_timeout_ms = 60000',
      '',
    ].join("\n"), { mode: 0o600 });
    await writeFile(join(work, "sum.mjs"), "export function add(a, b) { return a - b; }\n");
    const nonce = randomUUID();
    const checkSource = `import assert from 'node:assert/strict'; import {writeFileSync} from 'node:fs'; import {add} from './sum.mjs'; assert.equal(add(2,3),5); assert.equal(add(-1,4),3); writeFileSync('checked.ok',${JSON.stringify(nonce)});\n`;
    await writeFile(join(work, "check.mjs"), checkSource);
    stage = "codex-tool-cycle";
    const run = await runProcess("codex", [
      "exec", "--ephemeral", "--skip-git-repo-check", "--json", "--color", "never",
      "Read sum.mjs and check.mjs with exec_command. Fix the addition bug in sum.mjs using exec_command, then run node check.mjs with exec_command and finish after it passes. Do not change check.mjs or create checked.ok yourself. Do not delegate or use the network.",
    ], 150_000);
    const rows = run.stdout.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    results.codex = { exitCode: run.code, timedOut: run.timedOut,
      events: [...new Set(rows.map((row) => row.type))],
      itemTypes: [...new Set(rows.flatMap((row) => row.item?.type ? [row.item.type] : []))],
      errorCategories: [...new Set(rows.flatMap((row) => {
        const text = JSON.stringify(row.error ?? row.item?.error ?? "").toLowerCase();
        return ["tool", "arguments", "schema", "workspace", "permission", "timeout", "failed", "unknown", "not found", "invalid"]
          .filter((term) => text.includes(term));
      }))] };
    results.billingAfter = await billing();
    assert.equal(run.code, 0, "Codex exited unsuccessfully");
    assert.ok(rows.some((row) => row.type === "turn.completed"), "Codex did not complete");
    stage = "verify-files";
    assert.equal(await readFile(join(work, "check.mjs"), "utf8"), checkSource);
    assert.equal(await readFile(join(work, "checked.ok"), "utf8"), nonce);
    const independentCheck = await runProcess(process.execPath, ["check.mjs"], 10_000);
    assert.equal(independentCheck.code, 0, "Independent check failed");
    results.filesVerified = true;
    stage = "verify-upstream";
    assert.ok(wire.requests.length >= 2, "No multi-turn upstream inference observed");
    assert.ok(wire.requests.every((r) => r.selector === model && r.upstreamModel === model && r.status === 200 && r.ended && !r.error), "Upstream selector or completion mismatch");
    const requests = boundary.filter((r) => r.direction === "request");
    assert.ok(requests.length >= 2 && requests.every((r) => r.model === model && r.stream && !r.authorizationPresent));
    const responses = boundary.filter((r) => r.direction === "response");
    assert.ok(responses.some((r) => r.tools.includes("exec_command")), "No Codex command call observed");
    assert.ok(responses.every((r) => r.status === 200 && !r.error && r.events.includes("response.completed")));
    console.log(JSON.stringify({ ok: true, model, reasoning: "low", ...results, upstream: wire.requests, boundary }, null, 2));
  }
} catch (error) {
  // Never expose raw CLI stderr/stdout or provider response material.
  const errorCode = ["EADDRINUSE", "EPERM", "EACCES", "ENOENT", "ERR_ASSERTION"].includes(error?.code) ? error.code : null;
  console.log(JSON.stringify({ ok: false, failedStage: stage, errorCode, ...results, upstream: wire?.requests ?? [], boundary }, null, 2));
  process.exitCode = 1;
} finally {
  wire?.restore();
  await bridge?.stop();
  await rm(scratch, { recursive: true, force: true });
}

async function runProcess(command, args, timeoutMs) {
  const env = Object.fromEntries(["PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM"]
    .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: work, env: { ...env, HOME: home, CODEX_HOME: codexHome }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.resume();
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolveRun({ code, stdout, timedOut }); });
  });
}
