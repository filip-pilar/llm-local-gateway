import {
  reconcileUpstreamAccounts,
  scrubUpstreamPolicySamples,
} from "../core/devin-upstream-state.mjs";

const MINIMUM_INTERNAL_CAPABILITY_LENGTH = 16;
const MAXIMUM_INTERNAL_CAPABILITY_LENGTH = 512;
const internalBoundaryInstalled = Symbol("internalBoundaryInstalled");

const privacyEnvironment = {
  DEBUG_REQUEST_BODIES: "0",
  DEVIN_CONNECT_DEBUG_META: "0",
  DEVIN_CONNECT_DUMP_RAW: "0",
  DEVIN_CONNECT_WIRE_DUMP: "0",
  LOG_LEVEL: "error",
  // The pinned upstream treats a negative ring capacity as an empty ring:
  // every policy-block sample is removed before its debounced stats write.
  // Keep the focused regression when updating the pinned dependency.
  POLICY_BLOCK_RING: "-1",
  WINDSURFAPI_DUMP_SYSTEM_PROMPT: "0",
  WINDSURFAPI_PROTO_TRACE: "0",
  WINDSURFAPI_PROTO_TRACE_ERROR_STRINGS: "0",
  WINDSURFAPI_PROTO_TRACE_READ_WRAPPER_STRINGS: "0",
  WINDSURFAPI_PROTO_TRACE_STRINGS: "0",
  WINDSURFAPI_TRACE: "0",
  WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT: "0",
};

export async function refreshDevinCatalog({ token, fetchCatalog, setLiveCatalogSelectors }) {
  try {
    const catalog = await fetchCatalog({ token, signal: AbortSignal.timeout(15_000) });
    setLiveCatalogSelectors(catalog);
    return true;
  } catch {
    // Unknown selectors still fail closed at the transport's model gate.
    return false;
  }
}

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

export function protectInternalServer(server, internalCapability) {
  if (server[internalBoundaryInstalled]) return server;
  const requestListeners = server.listeners("request");
  if (requestListeners.length === 0) {
    throw new Error("Internal Devin transport has no request handler");
  }
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    if (request.headers["x-api-key"] !== internalCapability) {
      response.writeHead(401, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ error: { type: "auth_error" } }));
      return;
    }
    for (const listener of requestListeners) {
      listener.call(server, request, response);
    }
  });
  server[internalBoundaryInstalled] = true;
  return server;
}

async function loadWindsurfServer(internalCapability) {
  const [
    { initAuth, setApiKeyResolver },
    { startServer },
    { registerServer },
    { log: upstreamLog },
    { fetchCatalog },
    { setLiveCatalogSelectors },
  ] = await Promise.all([
    import("windsurf-api/src/auth.js"),
    import("windsurf-api/src/server.js"),
    import("windsurf-api/src/server-registry.js"),
    import("windsurf-api/src/config.js"),
    import("windsurf-api/src/devin-connect-catalog.js"),
    import("windsurf-api/src/devin-connect-models.js"),
  ]);
  // server.js imports the dashboard's persistent logger. Replace its shared
  // methods before startup so embedded requests cannot print or append bodies.
  for (const level of ["debug", "info", "warn", "error"]) {
    upstreamLog[level] = () => {};
  }
  setApiKeyResolver(() => internalCapability);
  await initAuth();
  // The pinned transport refreshes Connect selectors in the background, only
  // after a separate Cascade catalog succeeds. Fetch the authoritative Devin
  // catalog independently before serving, so newly released selectors work on
  // the first request. A discovery outage must not disable the older models
  // already present in the transport's bundled snapshot.
  await refreshDevinCatalog({ token: process.env.CODEIUM_API_KEY, fetchCatalog, setLiveCatalogSelectors });
  const server = startServer();
  protectInternalServer(server, internalCapability);
  registerServer(server);
  return () => server;
}

export async function startDevinTransport({
  port,
  token,
  dataDir,
  defaultModel,
  internalCapability,
  host = "127.0.0.1",
  log = () => {},
  reconcile = reconcileUpstreamAccounts,
  scrubPolicySamples = scrubUpstreamPolicySamples,
  loadUpstream = loadWindsurfServer,
}) {
  if (host !== "127.0.0.1") {
    throw new Error("Internal Devin transport must bind to 127.0.0.1");
  }
  if (
    typeof internalCapability !== "string" ||
    internalCapability.length < MINIMUM_INTERNAL_CAPABILITY_LENGTH ||
    internalCapability.length > MAXIMUM_INTERNAL_CAPABILITY_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(internalCapability)
  ) {
    throw new Error(
      `Internal Devin capability must be a ${MINIMUM_INTERNAL_CAPABILITY_LENGTH}-${MAXIMUM_INTERNAL_CAPABILITY_LENGTH} character base64url string`,
    );
  }
  const accountState = reconcile(dataDir, token);
  if (accountState.removed > 0) {
    log(`removed ${accountState.removed} stale upstream account record(s)`);
  }
  const policyState = scrubPolicySamples(dataDir);
  if (policyState.removed > 0) {
    log(`removed ${policyState.removed} persisted upstream policy sample(s)`);
  }

  Object.assign(process.env, {
    ...privacyEnvironment,
    API_KEY: internalCapability,
    CODEIUM_API_KEY: token,
    CODEIUM_API_URL: "https://server.codeium.com",
    DATA_DIR: dataDir,
    DEFAULT_MODEL: defaultModel,
    DEVIN_CONNECT: "1",
    DEVIN_CONNECT_IMAGE_TAG: "10",
    HOST: host,
    PORT: String(port),
    WINDSURFAPI_ALLOW_UNAUTHENTICATED: "0",
  WINDSURFAPI_NO_OPEN: "1",
    WINDSURFAPI_SKIP_DOTENV: "1",
  });

  log(`starting internal transport on ${host}:${port}`);
  const getActiveServer = await loadUpstream(internalCapability);
  return waitForInternalServer(getActiveServer, port);
}
