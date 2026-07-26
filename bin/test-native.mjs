#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { swiftCachePaths } from "./swift-cache-paths.mjs";

if (process.platform !== "darwin") {
  process.stdout.write("Skipping native tests: macOS is required.\n");
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "macos", "LLMLocalGatewayApp");
const { moduleCache, scratch } = swiftCachePaths(
  root,
  "macos-swift-tests",
);
mkdirSync(moduleCache, { recursive: true });

const result = spawnSync(
  "swift",
  [
    "test",
    "--disable-sandbox",
    "--package-path",
    packageRoot,
    "--scratch-path",
    scratch,
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: moduleCache,
      SWIFTPM_MODULECACHE_OVERRIDE: moduleCache,
    },
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
