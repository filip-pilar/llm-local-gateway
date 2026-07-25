# Architecture

## Public boundary

One HTTP server binds to `127.0.0.1` and exposes:

```text
/openai/v1 -> Responses and model discovery
/claude    -> Messages, token counting, and model discovery
```

The public layer owns shared validation, model injection, deterministic
routing, request-size and depth limits, client-auth stripping, streaming,
cancellation, redacted boundary observations, and Codex/Claude child request
compatibility.

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
- starts the pinned `windsurf-api` server on its own loopback port;
- preserves the existing Responses and Anthropic translations;
- supports `swe-1-6-slow` and `swe-1-7-lightning`.

### Grok

The Grok provider reuses the `grok-bridge` implementation:

- reads the official CLI's xAI OAuth access token without taking ownership of
  the refresh token;
- verifies the official CLI version;
- sends Responses requests to the fixed Grok CLI inference proxy;
- on HTTP 401, asks the official CLI to refresh, rereads the token, and retries
  once;
- adapts Anthropic requests and streams locally;
- supports `grok-4.5`.

Neither provider can route to the other. Upstream errors retain the selected
provider identity.

## Lifecycle and readiness

The public port is reserved first. Each provider then starts independently on a
different loopback port. Authentication, port, or startup failure is caught and
stored only for that provider. The public endpoint still starts and returns a
stable provider-unavailable error for models owned by the failed provider.

`GET /__llm_gateway/readiness` reports:

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

Shutdown closes the public server and both provider servers. Downstream
cancellation destroys only the selected upstream request.

## Trust and state

All listeners are loopback-only. Public client auth headers are ignored and
removed. Private directories are mode 0700; credentials and persisted account
state are regular files with restrictive permissions and symbolic links are
rejected.

The gateway logs state transitions and opaque error categories, never
credential contents or request bodies. Boundary instrumentation stores hashes,
counts, field shapes, event types, and tool metadata needed for compatibility
diagnosis.

## Source layout

```text
bin/llm-gateway.mjs             CLI entry point
src/core/providers.mjs          model ownership
src/core/*credentials.mjs       provider credential readers
src/http/openai-endpoint.mjs    public protocols and router
src/service/bridge.mjs          independent provider lifecycle
src/service/diagnostics.mjs     provider and endpoint status
src/transport/devin.mjs         Devin/Windsurf startup
src/transport/grok.mjs          Grok OAuth transport
src/transport/anthropic-*.mjs   Grok Anthropic adapter
```

The first release deliberately omits generic plugins, automatic provider
fallback, remote binding, and the unified macOS app.
