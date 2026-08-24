# llm-local-gateway

`llm-local-gateway` exposes authenticated Devin and Grok CLI subscriptions
through one loopback-only daemon:

- OpenAI-compatible base URL: `http://127.0.0.1:4317/openai/v1`
- Anthropic-compatible base URL: `http://127.0.0.1:4317/claude`

It consolidates the working transport and compatibility code from
`devin-bridge` and `grok-bridge`. Provider authentication, transport state,
refresh behavior, errors, lifecycle, and readiness remain separate.

## Models and routing

Routing is fixed by model ID. There is no fallback.

| Model | Provider |
| --- | --- |
| `swe-1-6-slow` | Devin |
| `swe-1-7-lightning` | Devin |
| `grok-4.5` | Grok |

Requests with a missing or empty `model` use `LLM_LOCAL_GATEWAY_MODEL`, which
defaults to `swe-1-6-slow`. Both model-list endpoints always publish all three
models.

## Requirements

- Node.js 20 or newer
- Bun 1.3.5 to install the pinned `windsurf-api` dependency or build a helper
- Official Devin CLI authenticated with `devin auth login`
- Official Grok CLI authenticated with `grok login`
- macOS 26 and Swift 6.2 to build the native menu-bar app

The gateway does not own either login. Grok refresh remains CLI-owned; Devin
continues to use the official credential and its existing Windsurf transport.

## Install and run

```bash
bun install --frozen-lockfile
bun run llm-local-gateway -- serve
```

Useful commands:

```bash
bun run llm-local-gateway -- status
bun run llm-local-gateway -- status --live
bun run llm-local-gateway -- help
```

`status --live` checks only the loopback daemon and model discovery. The
`smoke` command makes a real inference request and consumes provider quota:

```bash
bun run llm-local-gateway -- smoke --model swe-1-6-slow
bun run llm-local-gateway -- smoke --model grok-4.5 --protocol claude
```

## Routes

OpenAI-compatible:

- `GET /openai/v1/models`
- `POST /openai/v1/responses`
- aliases: `GET /v1/models`, `POST /v1/responses`

Anthropic-compatible:

- `GET /claude/v1/models`
- `POST /claude/v1/messages`
- `POST /claude/v1/messages/count_tokens`

Gateway readiness:

- `GET /__llm_local_gateway/readiness`
- legacy alias: `GET /__llm_gateway/readiness`

Readiness returns separate `providers.devin.ready` and
`providers.grok.ready` values. The endpoint returns HTTP 200 when at least one
provider is ready and HTTP 503 when neither is ready. A provider startup failure
does not stop the other provider or the public daemon.

## Configuration

| Variable | Default |
| --- | --- |
| `LLM_LOCAL_GATEWAY_PORT` | `4317` |
| `LLM_LOCAL_GATEWAY_DEVIN_PORT` | public port + 1 |
| `LLM_LOCAL_GATEWAY_GROK_PORT` | public port + 2 |
| `LLM_LOCAL_GATEWAY_MODEL` | `swe-1-6-slow` |
| `LLM_LOCAL_GATEWAY_DATA_DIR` | `~/.local/share/llm-local-gateway` |
| `DEVIN_CREDENTIALS_FILE` | `~/.local/share/devin/credentials.toml` |
| `GROK_HOME` | `~/.grok` |
| `GROK_CLI` | `~/.grok/bin/grok` |

Equivalent CLI options are available for the public and provider ports, data
directory, default model, Devin credentials, and Grok home.

For compatibility, the runtime still accepts legacy `LLM_GATEWAY_*`
environment variables when the corresponding `LLM_LOCAL_GATEWAY_*` variable
is unset. If `~/.local/share/llm-gateway` already exists and the new data
directory does not, the existing directory is reused automatically.

## Security and behavior

- Public and internal listeners bind only to `127.0.0.1`.
- The public boundary accepts only loopback `Host` values, rejects browser
  origins and cross-site requests, and requires `application/json` for
  inference POSTs.
- Client `Authorization` and `x-api-key` headers are stripped before internal
  forwarding. The public proxy replaces them with its ephemeral capability for
  the internal provider listeners.
- Provider CORS headers are never exposed through the public endpoint.
- Grok adapter subprocess environments are sanitized, streamed UTF-8 is decoded
  incrementally, and Grok shares one asynchronous CLI refresh across requests.
- The embedded Devin transport disables raw body, prompt, trace, wire, and
  policy-sample persistence.
- Credential and private-state reads reject symbolic links and repair or reject
  unsafe permissions as appropriate.
- Request validation, 10 MiB limits, streaming, cancellation, redacted boundary
  diagnostics, and Codex/Claude child compatibility are shared across both
  providers.
- Provider-private reasoning state is not moved across provider boundaries.
- No automatic provider fallback or third-party plugin system is included.

## Tests

```bash
bun run check
```

`check` syntax-checks every JavaScript module, runs the complete non-live Node
suite, and runs the Swift suite on macOS. Swift caches are keyed by the checkout
path, so moving or renaming the repository does not reuse incompatible
precompiled modules. Narrower commands are also available:

```bash
bun run test
bun run test:contracts
bun run test:native
bun run test:coverage
```

The default suite is non-live: it uses loopback fixtures and mocked upstreams,
does not perform inference, and does not consume Devin or Grok quota. Live
provider tests are separately gated by explicit `LLM_LOCAL_GATEWAY_*`
environment variables:

```bash
LLM_LOCAL_GATEWAY_LIVE_CONFORMANCE=1 \
  LLM_LOCAL_GATEWAY_LIVE_MODELS=swe-1-6-slow,grok-4.5 \
  bun run test:live-providers
```

These commands consume provider quota. `swe-1-7-lightning` also requires that
the authenticated Devin account is entitled to the Lightning model.

## macOS app

The unified menu-bar app supervises the same loopback helper and keeps Devin
and Grok sign-in, status, readiness, and logout independent. It exposes both
endpoint URLs, supports all three default models, can launch at login, and has
an explicit bounded live-verification action.

Build signed local app bundles:

```bash
bun run build:macos
bun run build:macos:debug
```

The release bundle is written to `dist/LLM Local Gateway.app`. The debug bundle
opens a normal window for UI testing and defaults to isolated port 4717. Both
bundles contain the compiled gateway helper and Devin authentication PTY
driver; neither contains credentials.

Build only the standalone helper:

```bash
bun run build:helper
```

See [architecture](docs/architecture.md) and
[consolidation notes](docs/consolidation.md).

## License

[MIT](LICENSE) © 2026 Filip Pilar.
