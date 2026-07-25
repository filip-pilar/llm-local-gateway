# Consolidation notes

This project was seeded from `grok-bridge` and retains its public validation,
streaming, cancellation, security, Grok transport, Anthropic adapter,
diagnostics, compatibility harnesses, and tests.

The following provider-specific parts were restored from `devin-bridge`:

- official Devin TOML credential parsing and secure reads;
- Windsurf account-state reconciliation;
- pinned `windsurf-api` transport startup;
- Devin Responses and Anthropic transport conformance tests;
- both Devin model IDs and provider diagnostics.

The shared public endpoint now injects a configured default model, maps each
known model to exactly one provider, and forwards to two separate internal
loopback transports. Provider startup and readiness are intentionally
independent.

The source repositories remain unchanged. Their Git directories, build output,
caches, logs, and `node_modules` were not copied. The unified native app was
derived from both source apps and then renamed and adapted for the combined
provider lifecycle.

## Added after the CLI baseline

- unified macOS menu-bar app and signed local packaging;
- bounded live OpenAI and Claude text/streaming/tool-call conformance;
- real Codex and Claude child-agent routing checks for both providers.

## Deliberately omitted

- provider fallback;
- additional providers or a plugin API;
- remote listener support;
