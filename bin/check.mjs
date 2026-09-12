#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// This entry point is always non-live, even in a shell used for live probes.
// External captures are opt-in inputs for the targeted replay test only.
const checkEnvironment = Object.fromEntries(Object.entries(process.env).filter(
  ([name]) => !name.startsWith("LLM_LOCAL_GATEWAY_LIVE_")
    && name !== "LLM_LOCAL_GATEWAY_REPLAY_CAPTURE",
));

function filesUnder(directory, suffix) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? filesUnder(path, suffix)
        : entry.name.endsWith(suffix) ? [path] : [];
    })
    .sort();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: checkEnvironment,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stderr || result.stdout || "");
    }
    process.exit(result.status ?? 1);
  }
}

const modules = ["bin", "src", "test"]
  .flatMap((directory) => filesUnder(join(root, directory), ".mjs"));
for (const module of modules) {
  run(process.execPath, ["--check", module], { capture: true });
}
process.stdout.write(`Syntax check passed for ${modules.length} JavaScript modules.\n`);

const tests = filesUnder(join(root, "test"), ".test.mjs");
run(process.execPath, ["--test", ...tests]);
run(process.execPath, [join(root, "bin", "test-native.mjs")]);
