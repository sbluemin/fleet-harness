# agent

Owns Pi-side agent capability registration and the runtime adapter glue between `pi-fleet-extension` and `fleet-core`'s `admiral.agent` domain.

## Philosophy

This domain is the **single seam** between the Pi runtime and the agent core. It exists to do two jobs and nothing else:

1. Register Pi providers, tools, lifecycle hooks, and overlays so PI can talk to ACP CLIs.
2. Translate between Pi's `AssistantMessageEventStream` (push) and fleet-core's `admiral.session/events` (pull from a module channel) — without smuggling Pi types into fleet-core or duplicating fleet-core logic on the host.

If a piece of code does anything else (prompt composition, tool execution policy, session-store mutation, runtime context building), it does not belong here — it belongs in fleet-core.

## Scope

- `index.ts` — `registerAgent(ctx)` single agent capability entry point. Boots `initStreamEventHandler()` and `registerProviderRuntime()`.
- `provider.ts` — **the single Pi provider gateway**. All Pi-AI, Pi-coding-agent, and Pi-runtime imports related to the provider live here, structured as labelled `#region` sections:
  - `pi-ai gateway` — re-export of `@mariozechner/pi-ai` types and `createAssistantMessageEventStream`.
  - `streamAcp adapter` — `streamAcp(model, context, options)` reads `admiral.session.*` and emits `AssistantMessageEventStream` events. Uses host-local `Map<sessionId, push>` for routing; boot-time `admiral.events.register(handler)` registration.
  - `thinking-level patch` — `installAcpThinkingLevelPatch()` AgentSession prototype monkeypatch consuming `admiral.models.getThinkingLevels()`.
  - `provider-guard` — Pi `ModelRegistry` filter that hides non-fleet providers; backed by `services/settings`.
  - `provider-guard command` — `fleet:guard:toggle` slash command.
  - `provider-runtime` — `pi.registerProvider` per CLI provider, plus `session_start` → `admiral.lifecycle.bindHostSession` and `session_shutdown` → `shutdownAllSessions` wiring.
- `ui/` — Agent Panel, Streaming Widget, carrier status UI, ACP shell UI, panel `ColBlock`/reducers/view-model (host-local), and carrier completion push delivery via `ui/panel/state.ts`.
- `carrier/` — Pi-side carrier model selection UI bridging `admiral.tools.list()` metadata into the panel's CLI/model overlay.

## Rules

- **Single Pi-AI Gateway**: `@mariozechner/pi-ai` imports are confined to `provider.ts`. Other adapters consume the gateway through exported bridge functions.
- **No re-fragmentation**: do not split `provider.ts` back into the legacy multi-file layout. Region headers are the architecture.
- **No host-side fleet-core duplication**: prompt assembly (`buildInitialPrompt`/`buildRuntimeContextPrompt`), tool spec definitions, session pool/drift logic, and MCP routing belong to fleet-core. The host adapter passes `{ userRequest, history }` and consumes `AgentStreamEvent`.
- **Boot-time stream-handler registration**: `initStreamEventHandler()` registers exactly once. Per-turn calls to `admiral.events.register` are forbidden.
- **Host-local panel storage**: `ColBlock`, `CollectedStreamData`, `stream-reducers`, and `view-model` live under `ui/panel/`. These are render concerns, not domain types.
- **Domain Focus**: non-agent Pi runtime features live in their respective domain files (`fleet.ts`, `job.ts`, `metaphor.ts`) or the `shell/` domain.
- **Background paths**: must accept plain runtime data; never depend on Pi `ExtensionContext`.
- **Tool definitions**: consumed from `fleet-core` registries (`admiral.tools.list/invoke`) via the `tool-registry.ts` adapter. The fleet four tools (`carriers_sortie`, `carrier_squadron`, `carrier_taskforce`, `carrier_jobs`) are registered through Pi but execute through `admiral.tools.invoke`.

## Removed Surfaces

The following modules were eliminated during the admiral.agent migration and the legacy `_shared/agent-runtime.ts` removal — do not recreate them:

- `provider-internal/` directory (run-stream, events, register, guard, state, session-runtime, thinking-level-patch). All logic merged into `provider.ts` regions or migrated to `fleet-core/src/admiral/agent/`.
- `provider-stream.ts`, `provider-runtime.ts`, `provider-guard.ts`, `provider-guard-command.ts`, `thinking-level-patch.ts` as separate files. Consolidated into `provider.ts` regions.
- `runner.ts` and `exposeAgentApi`. Carrier-tier executor is owned by `admiral.executor` (fleet-core) and reached through the root barrel.
