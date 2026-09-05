# core-ai-gateway

Translates an Agent CLI's wire onto provider backends. Downstream is the client (harness), upstream is the provider, and `src/canonical/` is their neutral vocabulary. Fleet orchestration, personas, and host lifecycle stay outside this package.

## Task references

When changing layer placement, model registration, request shaping, or provider adapters, read the relevant section of [architecture-reference.md](architecture-reference.md). It holds catalog classification rules and adapter-specific measurement rationale. Use `ai-gateway-loop-optimization` for real-traffic performance, retry, or tool-loop diagnosis.

## Ownership and dependencies

- Only `src/router/` composes both directions. Inject host settings, credentials, fetch, and diagnostics explicitly; the router owns no environment lookups or host identity.
- Provider semantics belong in `src/upstream/<provider>/`, client grammar in `src/downstream/harness/<client>/`, and wire protocols in `src/downstream/wire/<wire>/`. Wire code must not import harness code. Select the harness by a declared URL path segment, never by guessing from headers, credentials, or bodies.
- Separate provider `request-policy.ts` declarations from router-owned shaping steps. The only upstream-to-router dependency is an `import type` of the policy contract. Add clients through harness profiles, not router branches.
- Sharing a wire does not justify sharing provider request/response/tool/header/capability semantics. Share only canonical vocabulary, direction-neutral transport, and `anthropic-messages/protocol.ts` / `passthrough.ts` for providers relaying that same Anthropic wire. Transport imports neither direction.
- The only downstream-to-upstream exception is the legacy `OpenAIResponsesAdapter` in the default `AnthropicMessagesGateway` constructor. `src/index.ts` remains a public re-export facade.

## Catalog and credentials

- `models.json`, `benchmarks.json`, and `src/models.ts` are the central catalog sources. Keep current generations only. `capabilityClass` is a vendor claim, not a measurement; join benchmarks only by explicit `benchmarkKey` and prefer measured evidence. Adding a source beyond CursorBench requires user authorization.
- `src/settings/` and `src/auth/` are provider-neutral: neither imports providers nor discovers host data roots. Only `src/auth/` constructs credential stores; providers and quota collectors receive auth dependencies explicitly.
- The `auth.json` filename and stored provider IDs are signed-in-state compatibility contracts; do not change them. Vendor CLI-owned subscription credential files are read-only.

## Loss-prevention boundaries

- Responses strict-schema rewriting, completed-argument null stripping, and argument-delta dropping are one mechanism per provider. Partial JSON cannot be null-stripped; restoring argument streaming in these strict-mode implementations reintroduces un-stripped arguments. Determine compatibility through an observed JSON Schema keyword allowlist.
- Never suppress declared default-valued arguments: intentional input is indistinguishable from pollution. Cursor has no equivalent optional-argument guarantee. OpenCode Chat Completions guarantees undeclared-key pruning on completed arguments, not outbound schema rewriting.
- Cursor native redirect targets and advertised-catalog exclusions are separate predicates. Preserve both Run HTTP-status gating and failure on a transport that ends without a decoded frame. Do not independently tighten or loosen the live bridge's park gate, late tail, answered echo, or raced-call handling.
- Do not re-exclude Cursor models from the live client-tool bridge without measurement. The reference and adapter classifiers own provider-specific exceptions and rationale.
- `FLEET_GATEWAY_WIRE_LOG` records request bodies, tool arguments, and response events as unlimited-append JSONL. An explicit in-process override wins over the environment; only overrides with `maxBytes` rotate. Do not treat these logs as ordinary output or external publication material.
