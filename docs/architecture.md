# Architecture

## Public boundary

One HTTP server binds to `127.0.0.1` and exposes:

```text
/openai/v1 -> Responses and model discovery
/claude    -> Messages, token counting, and model discovery
```

The public layer owns shared validation, model injection, deterministic
routing, request-size and depth limits, browser-origin and non-loopback Host
rejection, JSON content-type enforcement, client-auth stripping, streaming,
cancellation, redacted boundary observations, and Codex/Claude child request
compatibility. It replaces any client `x-api-key` with one ephemeral capability
shared only with the internal provider listeners and strips provider
`Access-Control-*` response headers.

The model is validated before any provider transport is contacted:

```text
swe-1-6-slow      ─┐
swe-1-7-lightning ─┴─> Devin loopback transport

grok-4.5          ────> Grok loopback transport
```

Missing and empty models are replaced with the configured default before the
route is selected.

## Provider boundaries

### Devin

The Devin provider reuses the `devin-bridge` implementation:

- reads `windsurf_api_key` from the official mode-0600 TOML credential;
- reconciles private Windsurf account state under the gateway data directory;
- starts the pinned `windsurf-api` server through its embedded modules on its
  own authenticated loopback port;
- disables raw request logging, tracing, wire dumps, system-prompt dumps, and
  persisted policy samples;
- preserves the existing Responses and Anthropic translations;
- supports `swe-1-6-slow` and `swe-1-7-lightning`.

### Grok

The Grok provider reuses the `grok-bridge` implementation:

- reads the official CLI's xAI OAuth access token without taking ownership of
  the refresh token;
- verifies the official CLI version;
- sends Responses requests to the fixed Grok CLI inference proxy;
- on HTTP 401, shares one asynchronous official-CLI refresh across waiting
  requests, rereads the token, and retries each request once;
- sanitizes the CLI child environment so Devin/Windsurf credentials and state
  cannot cross the provider boundary;
- adapts Anthropic requests and streams locally;
- supports `grok-4.5`.

Neither provider can route to the other. Upstream errors retain the selected
provider identity.

## Lifecycle and readiness

The public port is reserved first. Each provider then starts independently on a
different loopback port. Authentication, port, or startup failure is caught and
stored only for that provider. The public endpoint still starts and returns a
stable provider-unavailable error for models owned by the failed provider.

`GET /__llm_local_gateway/readiness` reports:

```json
{
  "ready": true,
  "default_model": "swe-1-6-slow",
  "providers": {
    "devin": { "ready": true, "models": ["swe-1-6-slow", "swe-1-7-lightning"] },
    "grok": { "ready": false, "models": ["grok-4.5"] }
  }
}
```

The top-level value is true when at least one provider is ready. Diagnostics
report CLI authentication, credential state, live transport readiness, and
model discovery separately for both providers.

The former `/__llm_gateway/readiness` route and `x-llm-gateway` identity header
remain available as compatibility aliases. New clients use
`x-llm-local-gateway`.

Shutdown closes the public server and both provider servers. Downstream
cancellation destroys only the selected upstream request.

## Trust and state

All listeners are loopback-only. The public server accepts only loopback Host
values and rejects browser-origin or cross-site requests. Public client auth
headers are ignored and removed; internal listeners accept only the ephemeral
capability inserted by the public proxy. Private directories are mode 0700;
credentials and persisted account state are regular files with restrictive
permissions and symbolic links are rejected.

The gateway logs state transitions and opaque error categories, never
credential contents or request bodies. Existing upstream policy samples are
scrubbed at startup, and embedded provider body/trace/dump switches are forced
off. Boundary instrumentation stores hashes, counts, field shapes, event types,
and tool metadata needed for compatibility diagnosis.

## Source layout

```text
bin/llm-local-gateway.mjs           CLI entry point
src/core/providers.mjs              model ownership
src/core/*credentials.mjs           provider credential readers
src/http/openai-endpoint.mjs        public protocols and router
src/service/bridge.mjs              independent provider lifecycle
src/service/diagnostics.mjs         provider and endpoint status
src/transport/devin.mjs             Devin/Windsurf startup
src/transport/grok.mjs              Grok OAuth transport
src/transport/anthropic-*.mjs       Grok Anthropic adapter
macos/LLMLocalGatewayApp            native menu-bar controller
bin/build-macos-app.mjs             signed local app packaging
```

The native app bundles the same compiled helper, supervises app-owned helpers
with a parent lifeline, and surfaces independent authentication and readiness
for both providers. An externally started gateway is observed read-only and is
never stopped or reconfigured by the app, including while none of its providers
are ready. The app displays that gateway's observed default separately from its
saved preference for app-owned helpers. Its explicit verification action makes
bounded real OpenAI and Claude requests only for ready app-owned providers.

The first release deliberately omits generic plugins, automatic provider
fallback, and remote binding.
