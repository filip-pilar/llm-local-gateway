#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    output: { type: "string", short: "o" },
    target: { type: "string" },
  },
  strict: true,
});
const output = resolve(values.output || join(root, "dist", "llm-gateway-helper"));
const target = values.target || "bun-darwin-arm64";
const buildRoot = join(root, ".build", "helper");

if (buildRoot === root || !buildRoot.startsWith(`${root}/.build/`)) {
  throw new Error(`Refusing unsafe staging path: ${buildRoot}`);
}
rmSync(buildRoot, { recursive: true, force: true });
mkdirSync(join(buildRoot, "bin"), { recursive: true });
cpSync(join(root, "src"), join(buildRoot, "src"), { recursive: true });
cpSync(join(root, "bin", "llm-gateway.mjs"), join(buildRoot, "bin", "llm-gateway.mjs"));

mkdirSync(dirname(output), { recursive: true });
const result = spawnSync(
  "bun",
  [
    "build",
    join(buildRoot, "bin", "llm-gateway.mjs"),
    "--compile",
    `--target=${target}`,
    `--outfile=${output}`,
  ],
  { cwd: buildRoot, encoding: "utf8", stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
chmodSync(output, 0o755);
process.stdout.write(`${output}\n`);
