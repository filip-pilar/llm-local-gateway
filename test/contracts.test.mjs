import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  providerModels,
  supportedModels,
} from "../src/core/providers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const packageDocument = JSON.parse(read("package.json"));
const lockSource = read("bun.lock");
const swiftController = read(
  "macos/LLMLocalGatewayApp/Sources/LLMLocalGatewayApp/BridgeController.swift",
);
const swiftPackage = read("macos/LLMLocalGatewayApp/Package.swift");
const infoPlist = read("macos/LLMLocalGatewayApp/Info.plist");
const macOSBuild = read("bin/build-macos-app.mjs");
const readme = read("README.md");

function plistString(key) {
  return new RegExp(
    `<key>${key}</key>\\s*<string>([^<]+)</string>`,
  ).exec(infoPlist)?.[1];
}

test("runtime, native app, and documentation publish the same models", () => {
  const swiftBlock =
    /supportedModels = \[([\s\S]*?)\n    \]/.exec(swiftController)?.[1] ?? "";
  const swiftModels = [...swiftBlock.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(swiftModels, supportedModels);

  for (const model of supportedModels) {
    assert.match(readme, new RegExp(`\\| \`${model.replaceAll(".", "\\.")}\` \\|`));
  }
  assert.deepEqual(Object.keys(providerModels).sort(), ["devin", "grok"]);
});

test("package, lockfile, and app versions stay synchronized", () => {
  const dependency = packageDocument.dependencies["windsurf-api"]
    .replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    lockSource,
    new RegExp(`"windsurf-api": "${dependency}"`),
  );
  assert.equal(
    plistString("CFBundleShortVersionString"),
    packageDocument.version,
  );
});

test("native package, app bundle, and build target macOS 26", () => {
  assert.match(swiftPackage, /platforms: \[\.macOS\(\.v26\)\]/);
  assert.equal(plistString("LSMinimumSystemVersion"), "26.0");
  assert.match(macOSBuild, /apple-macosx26\.0/);
  assert.match(readme, /macOS 26 and Swift 6\.2/);
});

test("native and documented production ports match the runtime default", () => {
  assert.match(swiftController, /#else\s+return Int\(value \?\? ""\) \?\? 4317/);
  assert.match(swiftController, /#if DEBUG\s+return Int\(value \?\? ""\) \?\? 4717/);
  assert.match(readme, /\| `LLM_LOCAL_GATEWAY_PORT` \| `4317` \|/);
  assert.match(readme, /defaults to isolated port 4717/);
});
