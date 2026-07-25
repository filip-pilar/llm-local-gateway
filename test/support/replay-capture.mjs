import { lstat, readFile } from "node:fs/promises";

const SECRET_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key"]);

export async function readReplayCapture(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Replay capture must be a regular file");
  if ((info.mode & 0o077) !== 0) throw new Error("Replay capture permissions must be 0600 or stricter");
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (!parsed || !["claude", "openai"].includes(parsed.protocol)) {
    throw new Error("Replay capture protocol must be claude or openai");
  }
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    throw new Error("Replay capture body must be a JSON object");
  }
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(parsed.headers ?? {})) {
    const name = rawName.toLowerCase();
    headers[name] = SECRET_HEADERS.has(name) ? "test-placeholder" : String(rawValue);
  }
  headers["content-type"] = "application/json";
  return { protocol: parsed.protocol, headers, body: parsed.body, expectations: parsed.expectations ?? {} };
}

function clone(value) {
  return structuredClone(value);
}

export function claudeMinimizationCandidates(capture) {
  if (capture.protocol !== "claude") throw new Error("Claude minimization requires a claude capture");
  const candidates = [{ name: "exact", headers: clone(capture.headers), body: clone(capture.body) }];
  const addBody = (name, mutate) => {
    const body = clone(capture.body);
    mutate(body);
    candidates.push({ name, headers: clone(capture.headers), body });
  };

  if (capture.body.system != null) {
    addBody("without-system", (body) => { delete body.system; });
    if (Array.isArray(capture.body.system)) {
      for (let index = 0; index < capture.body.system.length; index += 1) {
        addBody(`without-system-block:${index}`, (body) => { body.system.splice(index, 1); });
        addBody(`only-system-block:${index}`, (body) => { body.system = [body.system[index]]; });
      }
    }
  }
  if (Array.isArray(capture.body.tools)) {
    addBody("without-tools", (body) => { delete body.tools; delete body.tool_choice; });
    for (let index = 0; index < capture.body.tools.length; index += 1) {
      addBody(`without-tool:${index}`, (body) => { body.tools.splice(index, 1); });
      addBody(`only-tool:${index}`, (body) => { body.tools = [body.tools[index]]; });
    }
  }
  for (const name of Object.keys(capture.headers).sort()) {
    if (name === "content-type") continue;
    const headers = clone(capture.headers);
    delete headers[name];
    candidates.push({ name: `without-header:${name}`, headers, body: clone(capture.body) });
  }
  for (const name of ["metadata", "thinking", "tool_choice", "output_config", "stop_sequences", "temperature", "top_k", "top_p"]) {
    if (capture.body[name] == null) continue;
    addBody(`without-field:${name}`, (body) => { delete body[name]; });
  }
  return candidates;
}

export function responseErrorType(status, body) {
  if (status < 400) return null;
  return body?.error?.type ?? (body?.type === "error" ? body?.error?.type : null) ?? null;
}
