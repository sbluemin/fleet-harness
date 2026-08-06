# core-ai-gateway

Translates Anthropic Messages traffic onto non-Anthropic provider backends.

## Layer index

| Layer | Responsibility |
|---|---|
| `src/canonical/index.ts` | Provider-neutral request/event vocabulary every adapter speaks |
| `src/anthropic/` | Client-facing Anthropic protocol seam: `protocol.ts`/`passthrough.ts` are cross-provider shared client-facing protocol normalization, `native.ts` is Anthropic-owned endpoint/header/auth forwarding policy, `gateway.ts`/`claude-context.ts` are the client-facing gateway/Claude compatibility seam (not a provider-shared allowlist) |
| `src/transport/` | Provider-unaware transport mechanics: SSE framing, token estimate, wire log, keepalive, credential file I/O |
| `src/<provider>/` | One folder per provider (`codex/`, `cursor/`, `kimi/`, `opencode-go/`). OpenCode behavior is additionally split by wire under `src/opencode-go/{anthropic,responses,chat-completions}/` |
| `src/models.ts`, `models.json` | Model catalog, context windows, effort ladders |
| `src/settings/` | Which catalog models a user exposed and where that choice is stored: stored shape, catalog-checked validation, selection resolution, and the `<dataDir>/ai-gateway.json` durable store |

## Routing doctrine

- `models.json` + `src/models.ts` are the single central catalog SSoT; never split them or move ownership.
- `capabilityClass` records the provider's own lineup positioning (`flagship`/`standard`/`light`) — the roster's only quality signal, stating what the provider claims, never a Fleet quality measurement. Classify a new model in this order: a `providerModelId`-linked service-tier sibling inherits its base's class; otherwise the provider's naming grammar decides — top tier tokens (`max`, `pro`) and the current generation of an unsuffixed mainline are `flagship`, mid tokens (`plus`) and superseded generations of a former flagship are `standard`, light tokens (`flash`, mini-class names like `luna`, and an unlinked `-fast`) are `light`. Resolve ambiguity downward (overclassing seats a light model in judgment work; underclassing merely costs one candidate) and leave routing aliases (`auto`) unclassed — validation enforces both.
- Provider behavior belongs to `src/<provider>/`, and OpenCode's wire-specific behavior additionally to its wire subfolder.
- Same wire protocol is not a reason to share provider request/response/tool/header/capability semantics — duplicate provider semantics deliberately.
- Only canonical protocol vocabulary (`src/canonical/`), provider-unaware transport mechanics (`src/transport/`), and exactly two Anthropic normalization modules — `src/anthropic/protocol.ts` and `src/anthropic/passthrough.ts` — may be shared across providers. `src/transport/` must not import any provider folder, and `src/anthropic/native.ts` is Anthropic-owned provider semantics other providers must not import.
- Provider request/response/tool/header/capability exceptions cannot live in `canonical/`, `transport/`, or the root facade.
- `src/settings/` is a catalog reader, never a provider: it may consume `src/models.ts` and the Claude compatibility seam, but must not import a provider folder or carry provider request/response semantics. Hosts wire it with an explicit data root and an optional legacy directory; the package resolves no host path of its own.
- `src/index.ts` is a compatibility facade only: it re-exports the public surface from the new locations and must not add provider branching or behavior.
- The one sanctioned seam→provider coupling is `AnthropicMessagesGateway`'s backwards-compatible default constructor (`src/anthropic/gateway.ts` → `codex/responses/adapter.ts`, the legacy `OpenAIResponsesAdapter`). It is pinned by the provider-boundaries test; any other anthropic-seam import of a provider folder is a violation.

## Constraints

- Keep Fleet orchestration and persona semantics out of this package; it knows providers, not Carriers.
- Each provider Responses implementation that applies strict mode rewrites every compatible tool schema into strict mode and strips the resulting nulls back out on the way in. **These two are one mechanism per implementation.** Change either alone and arguments silently gain or lose meaning: a surviving null reads as a real value to the client, and an un-rewritten schema loses the omission guarantee. The rewrite, the null stripping, and the argument-delta dropping below stay local to each such implementation — never centralize or import this semantic logic across providers.
- Strict compatibility is decided by an allowlist of JSON Schema keywords, never a denylist. The costs are asymmetric — judging a tool incompatible costs that one tool its guarantee, while wrongly admitting one returns a 400 that fails the entire request, every other tool included. Widen the allowlist only against an observed acceptance.
- Each provider Responses implementation that applies strict mode drops `response.function_call_arguments.delta` deliberately. Nulls cannot be stripped from a partial JSON fragment, so forwarding fragments would let the client reassemble un-stripped arguments. Restoring argument streaming reintroduces the defect.
- Strict mode makes omission expressible; it does not stop a model from filling an argument. Models still send the default quoted in a property's own description, and stating the omission rule in that description was measured to change nothing. Do not re-attempt schema-side persuasion — treat leftover default-valued arguments as accepted, since suppressing them cannot be distinguished from a caller who meant the default.
- The Cursor path has no equivalent guarantee. Its optional-argument pollution is known and unaddressed; do not assume parity between adapters.
- `FLEET_GATEWAY_WIRE_LOG` names the default file target for the inbound tool catalog, the canonical and provider wire bodies, and every response event as unlimited-append JSONL. An explicit in-process override takes precedence over the environment target; only override targets with `maxBytes` rotate at that limit and retain one `.1` backup. This log is the only way to see the argument JSON a model actually produced — provider behaviour differences are not otherwise observable from either side of this package.
