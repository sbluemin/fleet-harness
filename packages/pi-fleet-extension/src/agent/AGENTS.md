# agent

Owns Pi-side agent capability registration and runtime glue for `pi-fleet-extension`. This domain mirrors `AgentServices` from `fleet-core`.

## Scope

- `registerAgent(ctx)` — single agent capability entry point
- `provider.ts` — the sole `@mariozechner/pi-ai` gateway; provider registration wiring (including per-carrier `ANTHROPIC_AUTH_TOKEN` injection via `fleet.auth.getApiKey()`) lives under `provider-internal/`
- `runner.ts` — operation runner and background carrier request adapter
- `ui/` — Agent Panel, Streaming Widget, carrier status UI, ACP shell UI, and carrier completion push delivery via `ui/panel/state.ts`

## Rules

- **Gateway Policy**: Keep direct `@mariozechner/pi-ai` imports confined to `src/agent/provider.ts`; other adapters must consume that provider gateway through exported bridge functions.
- **Domain Focus**: Non-agent Pi runtime features live in their respective domain files (e.g., `fleet.ts`, `job.ts`) or the `shell/` domain.
- Move provider-agnostic runtime behavior to `fleet-core`.
- Do not let background paths depend on Pi `ExtensionContext`.
- Tool definitions used by the agent must be consumed from `fleet-core` registries via the `tool-registry.ts` adapter.
