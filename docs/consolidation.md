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
macOS app output, caches, logs, and `node_modules` were not copied.

## Deferred

- unified macOS application and service packaging;
- provider fallback;
- additional providers or a plugin API;
- remote listener support;
- live provider conformance runs beyond explicitly approved quota use.
