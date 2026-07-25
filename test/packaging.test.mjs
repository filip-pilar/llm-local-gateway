import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("standalone helper build includes both provider transports", { timeout: 30_000 }, () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const output = join(mkdtempSync(join(tmpdir(), "llm-gateway-helper-build-")), "helper");
  const build = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../bin/build-helper.mjs", import.meta.url)),
      "--output",
      output,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(build.status, 0, build.stderr);
  const help = spawnSync(output, ["--help"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: llm-gateway/);
});
