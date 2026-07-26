#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
const output = resolve(values.output || join(root, "dist", "llm-local-gateway-helper"));
const target = values.target || "bun-darwin-arm64";
const buildRoot = join(root, ".build", "helper");
const upstreamRoot = join(buildRoot, "node_modules", "windsurf-api");

if (buildRoot === root || !buildRoot.startsWith(`${root}/.build/`)) {
  throw new Error(`Refusing unsafe staging path: ${buildRoot}`);
}
rmSync(buildRoot, { recursive: true, force: true });
mkdirSync(join(buildRoot, "bin"), { recursive: true });
mkdirSync(dirname(upstreamRoot), { recursive: true });
cpSync(join(root, "src"), join(buildRoot, "src"), { recursive: true });
cpSync(
  join(root, "bin", "llm-local-gateway.mjs"),
  join(buildRoot, "bin", "llm-local-gateway.mjs"),
);
cpSync(join(root, "node_modules", "windsurf-api"), upstreamRoot, { recursive: true });

// Bun's compiled filesystem cannot satisfy the upstream module's runtime JSON
// read. Preserve Devin Bridge's build-time transform so the pinned catalog is
// embedded in the standalone helper.
const catalogModule = join(upstreamRoot, "src", "devin-connect-models.js");
let source = readFileSync(catalogModule, "utf8");
const importNeedle = "import { readFileSync } from 'node:fs';\nimport { log } from './config.js';";
const importReplacement =
  "import { log } from './config.js';\n" +
  "import catalogSnapshot from './data/devin-catalog-snapshot.json' with { type: 'json' };";
const readNeedle = `const CATALOG_SELECTORS = new Set(
  JSON.parse(
    readFileSync(new URL('./data/devin-catalog-snapshot.json', import.meta.url), 'utf8'),
  ).models.map((m) => m.selector),
);`;
const readReplacement = `const CATALOG_SELECTORS = new Set(
  catalogSnapshot.models.map((m) => m.selector),
);`;
if (!source.includes(importNeedle) || !source.includes(readNeedle)) {
  throw new Error("Pinned WindsurfAPI catalog loader changed; update the helper build transform");
}
source = source.replace(importNeedle, importReplacement).replace(readNeedle, readReplacement);
writeFileSync(catalogModule, source);

mkdirSync(dirname(output), { recursive: true });
const result = spawnSync(
  "bun",
  [
    "build",
    join(buildRoot, "bin", "llm-local-gateway.mjs"),
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
