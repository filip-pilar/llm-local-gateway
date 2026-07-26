import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defaultGatewayDataDirectory,
  gatewayEnvironmentValue,
} from "../src/core/environment.mjs";

test("canonical gateway environment variables take precedence over legacy aliases", () => {
  assert.equal(
    gatewayEnvironmentValue({
      LLM_LOCAL_GATEWAY_PORT: "4317",
      LLM_GATEWAY_PORT: "9999",
    }, "PORT"),
    "4317",
  );
  assert.equal(
    gatewayEnvironmentValue({ LLM_GATEWAY_PORT: "9999" }, "PORT"),
    "9999",
  );
});

test("the default data directory reuses legacy state only when needed", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-local-gateway-data-"));
  const current = join(home, ".local", "share", "llm-local-gateway");
  const legacy = join(home, ".local", "share", "llm-gateway");

  assert.equal(defaultGatewayDataDirectory(home), current);
  mkdirSync(legacy, { recursive: true });
  assert.equal(defaultGatewayDataDirectory(home), legacy);
  mkdirSync(current, { recursive: true });
  assert.equal(defaultGatewayDataDirectory(home), current);
});
