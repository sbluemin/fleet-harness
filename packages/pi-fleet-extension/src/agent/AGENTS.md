# agent

Owns Pi-side agent capability registration and runtime glue for `pi-fleet-extension`. This domain mirrors `AgentServices` from `fleet-core`.

## Scope

- `registerAgent(ctx)` — single agent capability entry point
- `provider.ts` — the sole `@mariozechner/pi-ai` gateway
- `provider-runtime.ts` — host adapter: provider registration via `admiral.models.listProviders()`, session lifecycle binding via `admiral.lifecycle`
- `provider-stream.ts` — host adapter: ~50-line `streamAcp` consuming `admiral.session.*` and `admiral.events.*`; event-to-Pi-stream mapping with host-local `Map<sessionId, handler>`
- `provider-guard.ts` — host-local Pi ModelRegistry monkeypatch (Decision: Pi registry mutation stays host-side)
- `thinking-level-patch.ts` — host-local AgentSession prototype patch using `admiral.models.getThinkingLevels()`
- `runner.ts` — operation runner and background carrier request adapter
- `ui/` — Agent Panel, Streaming Widget, carrier status UI, ACP shell UI, and carrier completion push delivery via `ui/panel/state.ts`

## Rules

- **Gateway Policy**: Keep direct `@mariozechner/pi-ai` imports confined to `src/agent/provider.ts`; other adapters must consume that provider gateway through exported bridge functions.
- **Domain Focus**: Non-agent Pi runtime features live in their respective domain files (e.g., `fleet.ts`, `job.ts`) or the `shell/` domain.
- Move provider-agnostic runtime behavior to `fleet-core`.
- Do not let background paths depend on Pi `ExtensionContext`.
- Tool definitions used by the agent must be consumed from `fleet-core` registries via the `tool-registry.ts` adapter.
