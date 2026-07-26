# Repository instructions

## Scope

These instructions apply to the entire repository.

`llm-local-gateway` is a Node.js ESM loopback gateway with a native SwiftUI
macOS supervisor. Read `README.md` and `docs/architecture.md` before changing
runtime behavior. Read `docs/grok-authentication.md` before changing Grok
authentication or transport behavior.

## Toolchain

- Node.js 20 or newer runs the gateway and JavaScript tests.
- Bun 1.3.5 installs the pinned Git dependency and builds standalone helpers.
- Swift 6.2 builds the macOS 26 app; the package uses Swift language mode 5.
- Use `bun install --frozen-lockfile` for a clean dependency install.
- Do not edit `node_modules`, `.build`, `dist`, or `test/.captures`.

## Source map

- `src/core`: models, paths, credentials, and private state.
- `src/http`: public OpenAI/Anthropic boundary and child compatibility.
- `src/transport`: provider-specific transports and protocol adaptation.
- `src/service`: lifecycle, diagnostics, and smoke verification.
- `src/interfaces`: CLI parsing.
- `bin`: executable, validation, and packaging entry points.
- `macos/LLMLocalGatewayApp`: native menu-bar app and tests.
- `test/support`: replay and explicitly gated live harnesses.

## Required invariants

Preserve these unless the task explicitly changes the architecture:

- Every public and internal listener binds only to `127.0.0.1`.
- Model ownership is deterministic. Do not add automatic provider fallback.
- Provider startup, failure, readiness, and private state remain independent.
- Authentication remains owned by the official provider CLIs.
- Never print, persist, return, or include credentials or request bodies in
  diagnostics.
- Reject symbolic-link credentials and private-state files; retain restrictive
  file and directory permissions.
- Strip client `Authorization` and `x-api-key` headers before internal
  forwarding.
- Preserve request-size and depth limits, streaming, cancellation, and stable
  provider-specific errors.
- Never move provider-private reasoning state across provider boundaries.
- Preserve Codex and Claude child compatibility and the documented legacy
  aliases unless intentionally removing compatibility.

## Validation

Prefer the narrowest relevant test during development:

- `node --test test/endpoint.test.mjs`
- `node --test test/grok-transport.test.mjs`
- `node --test test/config.test.mjs`
- `node --test test/contracts.test.mjs`
- `bun run test:native`

Before completing a runtime change, run:

- `bun run check`
- `bun run build:helper` for packaging or dependency changes
- `bun run build:macos:debug` for native packaging changes

`bun run check` syntax-checks all JavaScript modules, runs the complete non-live
Node suite, and runs Swift tests on macOS. The non-live Node tests open loopback
sockets. In a restricted sandbox, `listen EPERM` indicates missing socket
permission, not necessarily a regression.

Swift build caches are keyed by the absolute checkout path. This prevents
module-cache failures after moving or renaming a checkout.

## Live and external operations

Do not run real-inference commands without explicit user approval. These
consume provider quota:

- `smoke`
- `test:live-providers`
- `test:live-subagents`
- the macOS app's bounded live verification

Keep live-test environment gates intact. Never expose CLI output that might
contain authentication or provider response material.

`status --live` and the Grok authentication spike perform discovery but not
inference; still avoid them unless external provider state is relevant.

## Change discipline

- Add or update focused tests with behavior changes.
- Keep public behavior documented in `README.md`.
- Update `docs/architecture.md` when boundaries, routing, lifecycle, trust, or
  compatibility change.
- Treat `docs/grok-authentication.md` as an evidence record, not general notes.
- Keep model IDs, default ports, app version, and macOS deployment target
  synchronized across JavaScript, Swift, plist, tests, and documentation.
- The `windsurf-api` dependency is pinned to a Git commit. Dependency updates
  must also validate `bin/build-helper.mjs`, whose staging transform depends on
  the upstream catalog loader's exact shape.
- Preserve unrelated user changes and avoid broad generated-file cleanup.
