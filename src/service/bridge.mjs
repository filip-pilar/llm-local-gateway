import { createServer } from "node:net";
import { readDevinSessionToken } from "../core/devin-credentials.mjs";
import { gatewayEnvironmentValue } from "../core/environment.mjs";
import {
  readGrokAccessToken,
  readGrokCLIVersion,
} from "../core/grok-credentials.mjs";
import { resolveBridgePaths } from "../core/paths.mjs";
import { ensurePrivateDirectory, removeLegacyGatewayKey } from "../core/private-state.mjs";
import { providerModels, supportedModels } from "../core/providers.mjs";
import { startOpenAIEndpoint } from "../http/openai-endpoint.mjs";
import { startDevinTransport } from "../transport/devin.mjs";
import { startGrokTransport } from "../transport/grok.mjs";

const publicName = "llm-local-gateway";

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return port;
}

async function assertPortAvailable(port, label) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error) => {
      reject(
        error?.code === "EADDRINUSE"
          ? new Error(`${label} port 127.0.0.1:${port} is already in use`)
          : error,
      );
    });
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  if (typeof server.closeIdleConnections === "function") {
    server.closeIdleConnections();
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startProvider(name, start, writeLog) {
  try {
    const server = await start();
    writeLog(`${name} transport ready`);
    return { server, error: null };
  } catch (error) {
    writeLog(`${name} transport unavailable: ${error?.message ?? String(error)}`);
    return { server: null, error };
  }
}

export async function startBridge({ env = process.env, log, boundaryObserver } = {}) {
  const writeLog = log || ((message) => console.log(`[${publicName}] ${message}`));
  const port = parsePort(
    gatewayEnvironmentValue(env, "PORT") ?? 4317,
    "LLM_LOCAL_GATEWAY_PORT",
  );
  const devinPort = parsePort(
    gatewayEnvironmentValue(env, "DEVIN_PORT") ?? port + 1,
    "LLM_LOCAL_GATEWAY_DEVIN_PORT",
  );
  const grokPort = parsePort(
    gatewayEnvironmentValue(env, "GROK_PORT") ?? port + 2,
    "LLM_LOCAL_GATEWAY_GROK_PORT",
  );
  if (new Set([port, devinPort, grokPort]).size !== 3) {
    throw new Error("The public, Devin, and Grok ports must be different");
  }
  const defaultModel =
    gatewayEnvironmentValue(env, "MODEL") ?? providerModels.devin[0];
  if (!supportedModels.includes(defaultModel)) {
    throw new Error(`LLM_LOCAL_GATEWAY_MODEL is not supported: ${defaultModel}`);
  }

  await assertPortAvailable(port, "Public gateway");

  const paths = resolveBridgePaths(env);
  ensurePrivateDirectory(paths.bridgeDataDir);
  if (removeLegacyGatewayKey(paths.legacyGatewayKeyPath)) {
    writeLog("removed obsolete endpoint API key");
  }

  process.title = publicName;
  const providers = {
    devin: await startProvider("Devin", async () => {
      await assertPortAvailable(devinPort, "Internal Devin transport");
      const token = readDevinSessionToken(paths.devinCredentialsPath);
      return startDevinTransport({
        port: devinPort,
        token,
        dataDir: paths.devinUpstreamDataDir,
        defaultModel: providerModels.devin[0],
        log: writeLog,
      });
    }, writeLog),
    grok: await startProvider("Grok", async () => {
      await assertPortAvailable(grokPort, "Internal Grok transport");
      ensurePrivateDirectory(paths.grokHome);
      readGrokAccessToken(paths.grokCredentialsPath);
      const cliVersion = readGrokCLIVersion({
        cliPath: paths.grokCLIPath,
        env,
      });
      return startGrokTransport({
        port: grokPort,
        credentialPath: paths.grokCredentialsPath,
        cliPath: paths.grokCLIPath,
        cliVersion,
        log: writeLog,
      });
    }, writeLog),
  };

  let publicServer;
  try {
    publicServer = await startOpenAIEndpoint({
      host: "127.0.0.1",
      port,
      defaultModel,
      providerRoutes: {
        devin: {
          upstreamPort: devinPort,
          isReady: () => providers.devin.server?.listening === true,
        },
        grok: {
          upstreamPort: grokPort,
          isReady: () => providers.grok.server?.listening === true,
        },
      },
      boundaryObserver,
      log: writeLog,
    });
  } catch (error) {
    await Promise.all(
      Object.values(providers).map(({ server }) => closeServer(server)),
    );
    throw error;
  }

  let stopping;
  const stop = () => {
    stopping ||= Promise.all([
      closeServer(publicServer),
      ...Object.values(providers).map(({ server }) => closeServer(server)),
    ]).then(() => undefined);
    return stopping;
  };

  const readyProviders = Object.entries(providers)
    .filter(([, state]) => state.server?.listening)
    .map(([name]) => name);
  writeLog(
    `ready: OpenAI http://127.0.0.1:${port}/openai/v1; Claude http://127.0.0.1:${port}/claude; default model ${defaultModel}; providers ${readyProviders.join(", ") || "none"}`,
  );
  return {
    port,
    devinPort,
    grokPort,
    defaultModel,
    providers,
    stop,
  };
}

export async function runBridgeProcess({ parentLifeline = false } = {}) {
  const bridge = await startBridge();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await bridge.stop();
  };
  process.prependListener("SIGINT", shutdown);
  process.prependListener("SIGTERM", shutdown);
  if (parentLifeline) {
    process.stdin.resume();
    process.stdin.once("end", () => shutdown().finally(() => process.exit(0)));
    process.stdin.once("error", () => shutdown().finally(() => process.exit(0)));
  }
  return bridge;
}
