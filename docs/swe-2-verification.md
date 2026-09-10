# SWE-2 verification

Verified on 2026-09-10 with Node 25.6.1, Bun 1.3.5, Claude Code 2.1.251,
Devin CLI 3000.10.21, and an authenticated Devin Max account.

## Upstream evidence

Cognition's [announcement](https://cognition.com/blog/swe-2) describes medium,
high, and max reasoning levels. The official CLI's `devin models list --format
json` and Devin's `GetCliModelConfigs` response independently exposed:

| Selector | Context limit | Output limit | Official CLI cost tier |
| --- | --- | --- | --- |
| `swe-2-medium` | 262000 | 128000 | Free |
| `swe-2-high` | 262000 | 128000 | Free |
| `swe-2-max` | 262000 | 128000 | Free |

The account-status response reported `plan: max`. The earlier Free-account
login exposed no SWE-2 selectors, including with the current official CLI.
Authentication remains owned by `devin auth login`.

Live inference was verified separately from discovery. For each of the three
variants, the gateway's Anthropic Messages endpoint returned a successful SSE
completion. The outbound Devin Connect request's selector field (#21) and the
upstream response's model metadata (#7.#9) both matched the selected variant.
The response ended without an error trailer. These observations come from the
HTTPS transport to Devin, not the model label echoed by the local gateway or
model self-identification. Only selector/completion metadata was retained;
credentials, request bodies, tool contents, and thinking were not logged.

The CLI's Free cost tier is evidence of the account's advertised promotion,
not proof of billing for proxied inference. No authoritative charge reconciliation
was performed. No credits were purchased or subscription settings changed.

## Changes

The gateway exposes the three exact selectors in both protocols and the macOS
picker. Existing models and the `swe-1-6-slow` default remain unchanged.
Matching effort fields and adaptive thinking are accepted. Conflicting or
unsupported effort levels, disabled thinking, and explicit thinking budgets
receive HTTP 400 before upstream forwarding.

The WindsurfAPI Git pin remains
`81370f553718153bcd52297251cc565562d85645` (3.5.0), with a versioned Bun patch
in `patches/windsurf-api-swe2-tool-history.patch`. Install it using
`bun install --frozen-lockfile`; do not edit installed dependency files.

Two concrete transport issues were found and fixed:

- The dependency refreshed the Devin catalog in the background only after
  Cascade discovery succeeded. The gateway now awaits independent Devin
  discovery before listening. Discovery failure leaves the existing bundled
  selectors usable and unknown selectors fail closed.
- Parallel tool history was encoded as call A, call B, result A, result B.
  SWE-2 rejected the follow-up with an `invalid_argument` trailer. A bounded
  A/B probe demonstrated that call A, result A, call B, result B succeeds.
  The patch pairs complete, unambiguous SWE-2 native-tool batches without
  changing calls, results, or existing models' wire behavior. Incomplete or
  ambiguous batches remain unchanged. The patch applies below both protocol
  adapters, including Claude requests with separate assistant tool messages.

The gateway also explicitly disables the dependency's automatic rate-limit
variant fallback so a request cannot silently select a different effort.
The standalone helper and native app include the patched dependency; the
existing catalog embedding transform remains valid.

## Validation results

- `bun run check`: 113 Node tests passed, 2 live tests skipped; 17 Swift tests
  passed. Includes exact routing, rejected options, parallel native history,
  malformed/incomplete batches, existing-model preservation, and launcher
  environment isolation.
- `bun run build:helper`: passed with the patched dependency.
- `bun run build:macos:debug`: passed; the generated app passed signature checks.
- Router `npm run check`: 47 tests passed, 3 gated tests skipped; lint,
  type checking, and build passed.
- Real Claude Code through `bin/claude-swe2.mjs medium`: two Read calls,
  Edit, and Bash; fixed an addition bug and ran the unchanged check script
  successfully. Exit 0, successful final result, 37 streamed deltas, four
  successful upstream requests identified as `swe-2-medium`.
- Router live integration: actual Claude Code SubagentStart/Stop hooks routed
  the selected `Explore` child to real SWE-2 Medium. The test verified its
  streamed nonce response, routing decision, parent pass-through, and mapping
  cleanup. Devin's response metadata independently identified SWE-2 Medium.
  The parent used deterministic fixture responses; it did not consume an
  Anthropic subscription. The separate direct CLI exercise above used real
  SWE-2 for the full read/edit/check cycle.

Claude may print an `unrecognized_model` diagnostic for the custom model name;
it did not prevent successful inference or tool use. High and Max received
bounded Messages streaming checks; the full CLI tool cycle used Medium.

## Repeat the checks

These commands consume provider quota. The verifier creates temporary gateway
state and a scratch project, uses isolated Claude configuration, and reports
only allowlisted status/model metadata. It does not modify everyday Claude or
router settings. Port 4817 and its two following ports must be free; the router
check also requires its fixed port 9476 to be free.

```bash
LLM_LOCAL_GATEWAY_LIVE_SWE2=1 \
LLM_LOCAL_GATEWAY_SWE2_ROUTER_DIR=/absolute/path/to/subagent-model-router \
bun run test:live-swe2
```

Build the router first with `npm run build`. Omit its directory to run just the
gateway and Claude checks. To avoid repeating successful stages, pass
`messages`, `claude`, or `router` after the script name, for example:

```bash
LLM_LOCAL_GATEWAY_LIVE_SWE2=1 \
LLM_LOCAL_GATEWAY_SWE2_ROUTER_DIR=/absolute/path/to/subagent-model-router \
bun run test:live-swe2 router
```

For normal use, follow the [Claude Code launcher instructions](../README.md#claude-code-with-swe-2).
Selected-subagent routing uses the router's normal destination/route setup;
its README documents the optional real-child integration check and effort
compatibility. The isolated direct launcher intentionally omits normal router
hooks.
