# Grok authentication and entitlement

Status on 2026-07-24: **complete**.

## Conclusion

The official Grok CLI remains the sole owner of OAuth login, refresh tokens,
session refresh, logout, and updates. Subscription-backed inference uses the
official CLI's xAI OAuth session against the Grok CLI Responses proxy:

```text
auth.x.ai                              OAuth/OIDC issuer
cli-chat-proxy.grok.com/v1/responses  subscription inference
api.x.ai                              ordinary API-key service, not used
```

Directly presenting this session to `api.x.ai` was rejected as the
architecture because xAI documents that service around API keys. The Grok CLI
headless and ACP interfaces were also rejected as the bridge transport because
they own an agent loop and cannot preserve arbitrary caller-owned tools or raw
Responses streaming.

The Grok provider reads only the current access-token field from the protected
official CLI session. It never reads or stores the refresh token. On an
upstream `401`, it asks the CLI to perform credential-opaque model discovery,
rereads the access token, and retries once.

## xAI OAuth is not X OAuth

xAI OAuth authenticates the linked xAI account and authorizes Grok inference.
X developer OAuth authorizes an X developer application to use X API scopes.
An X Premium+ identity can supply entitlement after it is linked to xAI, but an
X API OAuth token is not an xAI inference token. The Grok provider never accepts X
developer OAuth credentials.

## Entitlement evidence

The official `@xai-official/grok` CLI was installed and identified as version
`0.2.111`. Browser login completed through `grok login`.

Credential-opaque discovery:

```bash
grok --no-auto-update models
bun run spike:grok-auth -- --json
```

returned only `grok-4.5` for the linked account. One bounded headless request
then succeeded with:

- model `grok-4.5`;
- one turn;
- no memory, subagents, plan mode, web access, or built-in tools;
- API-key environment variables removed; and
- a fixed structured proof checked only in memory.

The temporary session and directory were removed. No credential content,
authorization code, cookie, access token, or refresh token was printed or
retained.

After the transport cutover, bounded live bridge checks also passed for:

- one non-streaming OpenAI Responses request;
- one non-streaming Anthropic Messages request;
- one forced synthetic Responses function call over SSE; and
- one forced synthetic Anthropic tool call with `input_json_delta`.

Only fixed synthetic prompts and schemas were sent. All proof response bodies
were suppressed. After explicit approval for quota-consuming verification, the
real Codex and Claude child-agent harnesses also passed against `grok-4.5`,
including streaming, a local Codex `exec` round trip, child identity continuity,
lifecycle completion, and routing-map cleanup.

## Implemented seam

- fixed upstream `cli-chat-proxy.grok.com:443/v1/responses`;
- official CLI access-token reader using `O_NOFOLLOW`, regular-file checks, and
  mode `0600`;
- CLI-owned refresh on `401`, followed by one retry;
- credential-opaque CLI/model diagnostics;
- mocked Responses streaming, non-stream aggregation, tools, refresh, and
  Anthropic translation tests;
- loopback-only public and internal listeners with cancellation and size limits.

## Evidence reviewed

Authoritative sources:

- <https://docs.x.ai/build/enterprise>
- <https://docs.x.ai/build/cli/reference>
- <https://docs.x.ai/build/cli/headless-scripting>
- <https://docs.x.ai/developers/rest-api-reference/inference/models>
- <https://docs.x.ai/developers/models/grok-4.5>
- <https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token>

Current OpenClaw, CLIProxyAPI, Hermes, and Grok Build CLI source were used as
implementation evidence. They confirm the proxy request shape and common
Responses translations, but they are not treated as authority to take
ownership of the official CLI refresh token.
