import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveBridgePaths(env = process.env) {
  const home = resolve(env.HOME || homedir());
  const bridgeDataDir = resolve(
    env.LLM_GATEWAY_DATA_DIR ||
      join(home, ".local", "share", "llm-gateway"),
  );
  const grokHome = resolve(env.GROK_HOME || join(home, ".grok"));
  const devinCredentialsPath = resolve(
    env.DEVIN_CREDENTIALS_FILE ||
      join(home, ".local", "share", "devin", "credentials.toml"),
  );
  return {
    bridgeDataDir,
    grokHome,
    grokCredentialsPath: join(grokHome, "auth.json"),
    grokCLIPath: resolve(env.GROK_CLI || join(grokHome, "bin", "grok")),
    devinCredentialsPath,
    devinUpstreamDataDir: join(bridgeDataDir, "devin", "windsurfapi"),
    legacyGatewayKeyPath: join(bridgeDataDir, "gateway.key"),
  };
}

export const {
  bridgeDataDir,
  grokHome,
  grokCredentialsPath,
  grokCLIPath,
  devinCredentialsPath,
  devinUpstreamDataDir,
  legacyGatewayKeyPath,
} = resolveBridgePaths();
