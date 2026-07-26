import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultGatewayDataDirectory,
  gatewayEnvironmentValue,
} from "./environment.mjs";

export function resolveBridgePaths(env = process.env) {
  const home = resolve(env.HOME || homedir());
  const bridgeDataDir = resolve(
    gatewayEnvironmentValue(env, "DATA_DIR") ||
      defaultGatewayDataDirectory(home),
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
