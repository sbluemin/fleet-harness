# AI Gateway Runtime

Translates an Agent CLI's wire onto provider backends. Downstream is the client (harness), upstream is the provider, and `src/canonical/` is their neutral vocabulary. Provider wire code owns neither Fleet policy nor host lifecycle. `src/fleet/` owns Gateway model exposure and the delegation routing decision without importing core or CLI.

## Task references

When changing layer placement, model registration, request shaping, or provider adapters, read the relevant section of [architecture-reference.md](architecture-reference.md). It holds catalog classification rules and adapter-specific measurement rationale. Use `ai-gateway-loop-optimization` for real-traffic performance, retry, or tool-loop diagnosis.

## Ownership and dependencies

- Only `src/router/` composes both directions. Inject host settings, credentials, fetch, and diagnostics explicitly; the router owns no environment lookups or host identity.
- Provider semantics belong in `src/upstream/<provider>/`, client grammar in `src/downstream/harness/<client>/`, and wire protocols in `src/downstream/wire/<wire>/`. Wire code must not import harness code. Select the harness by a declared URL path segment, never by guessing from headers, credentials, or bodies.
- Separate provider `request-policy.ts` declarations from router-owned shaping steps. The only upstream-to-router dependency is an `import type` of the policy contract. Add clients through harness profiles, not router branches.
- Sharing a wire does not justify sharing provider request/response/tool/header/capability semantics. Share only canonical vocabulary, direction-neutral transport, and `anthropic-messages/protocol.ts` / `passthrough.ts` for providers relaying that same Anthropic wire. Transport imports neither direction.
- The only downstream-to-upstream exception is the legacy `OpenAIResponsesAdapter` in the default `AnthropicMessagesGateway` constructor. `src/index.ts` remains a public re-export facade.

## Catalog and credentials

- `models.json` and `src/models.ts` are the central catalog sources. Keep current generations only. Claude entries are Claude Code aliases whose version, wire id, and effort ladder come from the installed CLI's `supportedModels()`; never pin a Claude version in `models.json`. `capabilityClass` is a vendor claim, not a measurement, and is the only quality signal routing reads: Fleet keeps no third-party benchmark scores, because per-model upkeep and cohort bias outweighed their value.
- `src/settings/` and `src/auth/` are provider-neutral: neither imports providers nor discovers host data roots. Only `src/auth/` constructs credential stores; providers and quota collectors receive auth dependencies explicitly.
- The `auth.json` filename and stored provider IDs are signed-in-state compatibility contracts; do not rename or automatically delete existing entries when a provider is removed. Vendor CLI-owned subscription credential files are read-only.

## Loss-prevention boundaries

- Responses strict-schema rewriting, completed-argument null stripping, and argument-delta dropping are one mechanism per provider. Partial JSON cannot be null-stripped; restoring argument streaming in these strict-mode implementations reintroduces un-stripped arguments. Determine compatibility through an observed JSON Schema keyword allowlist.
- Never suppress declared default-valued arguments: intentional input is indistinguishable from pollution. Cursor has no equivalent optional-argument guarantee. OpenCode Chat Completions guarantees undeclared-key pruning on completed arguments, not a strict-mode outbound rewrite. Unreadable `pattern` values are dropped outbound so a backend that cannot compile them does not fail the request.
- Cursor native redirect targets and advertised-catalog exclusions are separate predicates. Preserve both Run HTTP-status gating and failure on a transport that ends without a decoded frame. Do not independently tighten or loosen the live bridge's park gate, late tail, answered echo, or raced-call handling.
- A redirect that parses a client tool's output back into a Cursor native result must accept what that client actually emits — CRLF line endings, non-ASCII text and paths, and a tail the caller trims — so run those variants through it before reporting the parser done.
- Do not re-exclude Cursor models from the live client-tool bridge without measurement. The reference and adapter classifiers own provider-specific exceptions and rationale.
- `FLEET_GATEWAY_WIRE_LOG` records request bodies, tool arguments, and response events as unlimited-append JSONL. An explicit in-process override wins over the environment; only overrides with `maxBytes` rotate. Do not treat these logs as ordinary output or external publication material.

- `src/fleet/routing-assignment.ts` owns which model and effort one delegated run gets, with `routing-table.ts` and `routing-allowance.ts`. The decision belongs here, not in the routing mod: the mod ships in a content-hashed shared tree that tests cannot reach. Read exposure and quota at call time, never from a session-start snapshot, and respect the host's delegation-routing opt-in. Quota comes first: the user's spend order and every other preference yield to a critical allowance unless every candidate is critical. The AI decision seats a model only; effort comes from a separate difficulty rating mapped onto that model's exposed ladder and never above xhigh — max is not chosen automatically.
