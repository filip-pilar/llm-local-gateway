#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { swiftCachePaths } from "./swift-cache-paths.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "macos", "LLMLocalGatewayApp");
const debug = process.argv.includes("--debug");
const configuration = debug ? "debug" : "release";
const app = join(
  root,
  "dist",
  debug ? "LLM Local Gateway Debug.app" : "LLM Local Gateway.app",
);
const contents = join(app, "Contents");
const macos = join(contents, "MacOS");
const resources = join(contents, "Resources");
const { moduleCache, scratch } = swiftCachePaths(
  root,
  `macos-swift-${configuration}`,
);
const helper = join(root, ".build", "macos", "llm-local-gateway-helper");
const authDriver = join(root, ".build", "macos", "devin-auth-pty");
const architecture = process.arch === "arm64" ? "arm64" : "x86_64";

function run(command, args, options = {}) {
  mkdirSync(moduleCache, { recursive: true });
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: moduleCache,
      SWIFTPM_MODULECACHE_OVERRIDE: moduleCache,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture) process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
  return result.stdout?.trim();
}

if (!app.startsWith(`${root}/dist/`) || !scratch.startsWith(`${root}/.build/`)) {
  throw new Error("Refusing unsafe macOS build paths");
}
rmSync(app, { recursive: true, force: true });
mkdirSync(macos, { recursive: true });
mkdirSync(resources, { recursive: true });
mkdirSync(dirname(helper), { recursive: true });

run("node", [join(root, "bin", "build-helper.mjs"), "--output", helper]);
run("xcrun", [
  "clang",
  "-arch", architecture,
  join(packageRoot, "AuthPTY", "devin-auth-pty.c"),
  "-o", authDriver,
]);
const swiftArguments = [
  "build",
  "--disable-sandbox",
  "-c", configuration,
  "--package-path", packageRoot,
  "--scratch-path", scratch,
  "--triple", `${architecture}-apple-macosx26.0`,
];
run("swift", swiftArguments);
const binPath = run("swift", [...swiftArguments, "--show-bin-path"], {
  capture: true,
});

copyFileSync(
  join(binPath, "LLMLocalGatewayApp"),
  join(macos, "LLMLocalGatewayApp"),
);
copyFileSync(helper, join(resources, "llm-local-gateway-helper"));
copyFileSync(authDriver, join(resources, "devin-auth-pty"));
copyFileSync(join(packageRoot, "Info.plist"), join(contents, "Info.plist"));
chmodSync(join(macos, "LLMLocalGatewayApp"), 0o755);
chmodSync(join(resources, "llm-local-gateway-helper"), 0o755);
chmodSync(join(resources, "devin-auth-pty"), 0o755);

run("plutil", ["-lint", join(contents, "Info.plist")]);
for (const executable of [
  join(resources, "llm-local-gateway-helper"),
  join(resources, "devin-auth-pty"),
  join(macos, "LLMLocalGatewayApp"),
]) {
  run("codesign", ["--force", "--sign", "-", executable]);
}
run("codesign", ["--force", "--deep", "--sign", "-", app]);
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
process.stdout.write(`${app}\n`);
