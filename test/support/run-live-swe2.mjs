import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "../../src/service/bridge.mjs";
import { observeDevinWire } from "./devin-wire-evidence.mjs";

if (process.env.LLM_LOCAL_GATEWAY_LIVE_SWE2 !== "1") {
  throw new Error("Set LLM_LOCAL_GATEWAY_LIVE_SWE2=1 to authorize bounded quota-consuming SWE-2 checks");
}
const mode = process.argv[2] ?? "all";
assert.ok(["all", "messages", "claude", "router"].includes(mode), "Unknown verification mode");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const routerDir = process.env.LLM_LOCAL_GATEWAY_SWE2_ROUTER_DIR;
if (mode === "router") assert.ok(routerDir, "Set LLM_LOCAL_GATEWAY_SWE2_ROUTER_DIR");
const port = Number(process.env.LLM_LOCAL_GATEWAY_LIVE_PORT ?? 4817);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65533, "Invalid live port");
const scratch = await mkdtemp(join(tmpdir(), "swe2-verification-"));
const results = [];
let bridge;
let wire;
let stage = "startup";
try {
  bridge = await startBridge({
    env: {
      ...process.env,
      LLM_LOCAL_GATEWAY_PORT: String(port),
      LLM_LOCAL_GATEWAY_DEVIN_PORT: String(port + 1),
      LLM_LOCAL_GATEWAY_GROK_PORT: String(port + 2),
      LLM_LOCAL_GATEWAY_DATA_DIR: join(scratch, "gateway"),
      GROK_HOME: join(scratch, "unused-grok"),
    },
    log: () => {},
  });
  assert.ok(bridge.providers.devin.server?.listening, "Devin transport unavailable");
  wire = await observeDevinWire();
  if (["all", "messages"].includes(mode)) {
    for (const effort of ["medium", "high", "max"]) {
      stage = `messages:${effort}`;
      const before = wire.requests.length;
      const model = `swe-2-${effort}`;
      const nonce = `SWE2_${randomUUID().replaceAll("-", "")}`;
      const response = await fetch(`http://127.0.0.1:${port}/claude/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 128, stream: true, messages: [{ role: "user", content: `Reply with exactly ${nonce}` }] }),
        signal: AbortSignal.timeout(60_000),
      });
      assert.equal(response.status, 200, "Messages request failed");
      const events = sseEvents(await response.text());
      assert.equal(events.filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text).join("").trim(), nonce);
      assert.ok(events.some((e) => e.type === "message_stop"));
      assert.ok(!events.some((e) => e.type === "error"));
      const upstream = verifyWire(before, model);
      results.push({ stage, ok: true, upstream });
    }
  }
  if (["all", "claude"].includes(mode)) {
    stage = "claude-tool-cycle";
    const before = wire.requests.length;
    const work = join(scratch, "work");
    await mkdir(work);
    await writeFile(join(work, "sum.mjs"), "export function add(a, b) { return a - b; }\n");
    const nonce = randomUUID();
    const checkSource = `import assert from 'node:assert/strict'; import {writeFileSync} from 'node:fs'; import {add} from './sum.mjs'; assert.equal(add(2,3),5); assert.equal(add(-1,4),3); writeFileSync('checked.ok',${JSON.stringify(nonce)});\n`;
    await writeFile(join(work, "check.mjs"), checkSource);
    const run = await runProcess(process.execPath, [
      join(repo, "bin/claude-swe2.mjs"), "medium", "--print",
      "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--no-session-persistence",
      "--tools", "Read,Edit,Bash", "--allowedTools", "Read,Edit,Bash", "--dangerously-skip-permissions", "--max-turns", "8",
      "Read sum.mjs and check.mjs with Read. Fix the addition bug in sum.mjs with Edit. Run node check.mjs with Bash. Finish after the check passes. Do not change check.mjs or create checked.ok yourself.",
    ], work, { LLM_LOCAL_GATEWAY_PORT: String(port) }, 120_000);
    const rows = jsonLines(run.stdout);
    const result = rows.findLast((r) => r.type === "result");
    const calls = rows.filter((r) => r.type === "assistant").flatMap((r) => r.message?.content ?? []).filter((c) => c.type === "tool_use");
    assert.equal(run.code, 0, "Claude exited unsuccessfully");
    assert.equal(result?.is_error, false, "Claude did not finish successfully");
    assert.ok(["Read", "Edit", "Bash"].every((name) => calls.some((call) => call.name === name)));
    assert.equal(await readFile(join(work, "check.mjs"), "utf8"), checkSource);
    assert.equal(await readFile(join(work, "checked.ok"), "utf8"), nonce);
    const streamDeltas = rows.filter((r) => r.type === "stream_event" && r.event?.type === "content_block_delta").length;
    assert.ok(streamDeltas > 0, "No streamed Claude deltas");
    results.push({ stage, ok: true, toolCalls: calls.map((call) => call.name), streamDeltas, upstream: verifyWire(before, "swe-2-medium") });
  }
  if (["all", "router"].includes(mode) && routerDir) {
    stage = "selected-subagent";
    const before = wire.requests.length;
    const run = await runProcess("npm", ["run", "test:live-claude"], resolve(routerDir), {
      SMR_LIVE_CLAUDE_UPSTREAM_URL: `http://127.0.0.1:${port}/claude`,
      SMR_LIVE_CLAUDE_MODEL: "swe-2-medium",
    }, 110_000);
    assert.equal(run.code, 0, "Router live Claude integration test failed");
    results.push({ stage, ok: true, parent: "fixture", child: "real SWE-2", upstream: verifyWire(before, "swe-2-medium") });
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} catch {
  // Raw CLI stderr and provider responses may contain prompts or private state.
  // Emit only stage status and the allowlisted wire metadata on failure.
  console.log(JSON.stringify({ ok: false, failedStage: stage, results, upstream: wire?.requests ?? [] }, null, 2));
  process.exitCode = 1;
} finally {
  wire?.restore();
  await bridge?.stop();
  await rm(scratch, { recursive: true, force: true });
}

function verifyWire(before, expected) {
  const records = wire.requests.slice(before);
  assert.ok(records.length > 0, "No upstream inference observed");
  assert.ok(records.every((r) => r.selector === expected && r.upstreamModel === expected && r.status === 200 && r.ended && !r.error), "Upstream selector or completion mismatch");
  return records;
}

function sseEvents(text) {
  return jsonLines(text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n"));
}
function jsonLines(text) {
  return text.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

async function runProcess(command, args, cwd, extraEnv, timeoutMs) {
  const env = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM"]
    .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env: { ...env, ...extraEnv }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.resume();
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolveRun({ code, stdout }); });
  });
}
