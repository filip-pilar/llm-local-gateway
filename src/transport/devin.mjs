import { reconcileUpstreamAccounts } from "../core/devin-upstream-state.mjs";

async function waitForInternalServer(getActiveServer, port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const server = getActiveServer();
    const address = server?.listening ? server.address() : null;
    if (
      address &&
      typeof address === "object" &&
      address.address === "127.0.0.1" &&
      address.port === port
    ) {
      return server;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Internal Devin transport did not start on port ${port}`);
}

export async function startDevinTransport({
  port,
  token,
  dataDir,
  defaultModel,
  host = "127.0.0.1",
  log = () => {},
}) {
  if (host !== "127.0.0.1") {
    throw new Error("Internal Devin transport must bind to 127.0.0.1");
  }
  const accountState = reconcileUpstreamAccounts(dataDir, token);
  if (accountState.removed > 0) {
    log(`removed ${accountState.removed} stale upstream account record(s)`);
  }

  Object.assign(process.env, {
    API_KEY: "",
    CODEIUM_API_KEY: token,
    CODEIUM_API_URL: "https://server.codeium.com",
    DATA_DIR: dataDir,
    DEFAULT_MODEL: defaultModel,
    DEVIN_CONNECT: "1",
    HOST: host,
    PORT: String(port),
    WINDSURFAPI_ALLOW_UNAUTHENTICATED: "1",
    WINDSURFAPI_NO_OPEN: "1",
    WINDSURFAPI_SKIP_DOTENV: "1",
  });

  log(`starting internal transport on ${host}:${port}`);
  const { getActiveServer } = await import(
    "windsurf-api/src/server-registry.js"
  );
  await import("windsurf-api/src/index.js");
  return waitForInternalServer(getActiveServer, port);
}
