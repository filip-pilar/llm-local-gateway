import { existsSync } from "node:fs";
import { join } from "node:path";

export function gatewayEnvironmentValue(env, suffix) {
  return (
    env[`LLM_LOCAL_GATEWAY_${suffix}`] ??
    env[`LLM_GATEWAY_${suffix}`]
  );
}

export function defaultGatewayDataDirectory(home) {
  const current = join(home, ".local", "share", "llm-local-gateway");
  const legacy = join(home, ".local", "share", "llm-gateway");
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}
