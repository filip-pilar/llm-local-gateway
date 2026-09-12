import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("check ignores ambient live/capture inputs and still runs Node and native checks", () => {
  const root = mkdtempSync(join(tmpdir(), "gateway-check-"));
  try {
    for (const directory of ["bin", "src", "test"]) mkdirSync(join(root, directory));
    copyFileSync(new URL("../bin/check.mjs", import.meta.url), join(root, "bin/check.mjs"));
    const assertions = `
      import assert from "node:assert/strict";
      assert.equal(process.env.LLM_LOCAL_GATEWAY_LIVE_REPLAY, undefined);
      assert.equal(process.env.LLM_LOCAL_GATEWAY_LIVE_CONFORMANCE, undefined);
      assert.equal(process.env.LLM_LOCAL_GATEWAY_REPLAY_CAPTURE, undefined);
      assert.equal(process.env.GATEWAY_CHECK_SENTINEL, "preserved");
    `;
    writeFileSync(join(root, "test/fixture.test.mjs"), assertions);
    writeFileSync(join(root, "bin/test-native.mjs"), `${assertions}\nconsole.log("native-fixture-ran");`);
    const environment = {
      ...process.env,
      LLM_LOCAL_GATEWAY_LIVE_REPLAY: "1",
      LLM_LOCAL_GATEWAY_LIVE_CONFORMANCE: "1",
      LLM_LOCAL_GATEWAY_REPLAY_CAPTURE: join(root, "must-not-read.json"),
      GATEWAY_CHECK_SENTINEL: "preserved",
    };
    // Launch an independent test runner, not a recursive node:test child.
    delete environment.NODE_TEST_CONTEXT;
    const run = () => spawnSync(process.execPath, [join(root, "bin/check.mjs")], {
      env: environment, encoding: "utf8", timeout: 15_000,
    });
    const success = run();
    assert.equal(success.status, 0, success.stderr || success.stdout);
    assert.match(success.stdout, /native-fixture-ran/);
    // Sanitizing the environment must not mask failures or skip the Node suite.
    writeFileSync(join(root, "test/fixture.test.mjs"), 'throw new Error("fixture-failure");');
    const failure = run();
    assert.equal(failure.status, 1, failure.stderr || failure.stdout);
    assert.match(failure.stdout, /fixture-failure/);
    assert.doesNotMatch(failure.stdout, /native-fixture-ran/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
