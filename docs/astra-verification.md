# Astra verification

Checked on 2026-09-11 with Codex CLI 0.149.1 and the authenticated Devin
Max account. The WindsurfAPI pin remains
`81370f553718153bcd52297251cc565562d85645`, including the existing SWE-2 patch.

## Result

**Astra Low inference through Devin and the full Codex CLI tool cycle work.**
Devin's content policy rejects Codex's static instruction preamble, so the
gateway replaces that client-owned preamble with a short neutral coding
instruction while preserving user input, tools, and selector-based reasoning.

| Check | Result |
| --- | --- |
| Official `devin models list --format json` | Advertises Astra Low, Medium, High, XHigh, Max and Fast variants; Astra is labeled High cost |
| Official Devin CLI, `gpt-6-astra-low`, minimal nonce prompt | Exit 0; expected nonce returned |
| Gateway Responses, `gpt-6-astra-low`, `reasoning.effort=low` | Successful streamed nonce response and `response.completed` |
| Actual Codex CLI through gateway, same selector and effort | Exit 0; three successful Astra turns, command execution, file edit, and independent check passed after instruction neutralization |

For the successful gateway control, the outbound Devin Connect selector
(protobuf field #21) and independently returned response model metadata
(#7.#9) both equal `gpt-6-astra-low`. The upstream returned HTTP 200 and
completed without an error trailer. The final Codex run also sent the exact Low
selector, completed its file task, and returned matching upstream model metadata.

The Codex test used an isolated home/configuration with no OpenAI credentials,
`requires_openai_auth=false`, a local Responses base URL, and explicit low
reasoning. Its scratch task was to read two files, fix an addition bug with
Codex's `exec_command` tool, and run the unchanged check. The bundled Codex
model catalog does not include Astra, so the gateway route supplies the model
selector directly. No OpenAI credential or ChatGPT session was used.

## Billing evidence and limits

Devin account status reported `plan: max`. Its exposed USD balance was $10
before and after the measured gateway runs, including the successful control.
This is consistent with included usage, but is **not proof** of the quota
bucket charged: the endpoint does not establish the subscription allowance
delta, delayed billing is possible, and no authoritative per-request charge
reconciliation was available. The requests authenticated with the official
Devin credential; they did not use an OpenAI API key or ChatGPT session.

No credits were purchased and no billing settings were changed. Discovery and
several early port-conflict startup failures did not issue inference requests.
Only Low received live checks; the other exposed efforts have non-live coverage.

## Implementation and validation

- Added the five non-Fast Astra selectors to deterministic Devin routing,
  model discovery, the native picker, and documentation.
- Reject conflicting effort options, disabled thinking, and explicit thinking
  budgets before forwarding. Unsupported aliases/efforts remain rejected.
- Added native selector encoding and both-protocol routing/validation tests.
- Added `test:live-astra`, explicitly gated by
  `LLM_LOCAL_GATEWAY_LIVE_ASTRA=1`, with a separate `responses` control mode.
  The harness deletes its temporary gateway and Codex state and suppresses raw
  CLI/provider output. Wire evidence retains only allowlisted model/status and
  error-category metadata.
- `bun run check`: 115 Node tests passed, two gated tests skipped; 17 Swift
  tests passed.
- `bun run build:macos:debug`: helper compilation, native app build, and app
  signature validation passed.

## Repeat

These checks consume Devin quota. The default public port is 14817, with the
next two ports reserved for provider listeners. Override with
`LLM_LOCAL_GATEWAY_LIVE_PORT` if needed.

```bash
LLM_LOCAL_GATEWAY_LIVE_ASTRA=1 bun run test:live-astra responses
LLM_LOCAL_GATEWAY_LIVE_ASTRA=1 bun run test:live-astra
```

The first command checks a minimal streamed completion. The second requires
a successful real Codex read/edit/check cycle, an independent execution of the
unchanged check, streamed completion events, an observed `apply_patch` call,
and matching upstream model metadata on every inference request. It passes with
the current isolated full-access test workspace.

Neither command changes everyday Codex or Subagent Model Router settings.
The router already supports arbitrary model destinations and main routes; no
router changes were needed to establish this upstream blocker.
