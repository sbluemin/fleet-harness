# pi-fleet-extension Doctrine

`packages/pi-fleet-extension` is the Pi capability package for Fleet. It owns Pi runtime wiring, host shell surfaces, and domain-specific adapters while consuming `@sbluemin/fleet-core` public exports, `@sbluemin/fleet-core/admiralty*` (Grand Fleet domain), and `@sbluemin/fleet-wiki`.

## Core Philosophy

This package is a **thin, opinionated adapter** between fleet-core's domain surfaces and the Pi runtime. Three principles direct every module here:

1. **Adapter, not domain** — fleet-core owns Fleet behavior; this package owns the wiring. When a feature contains both pure logic and Pi-specific glue, the pure half migrates to fleet-core and only the glue stays here.
2. **One Pi-AI gateway** — `src/provider.ts` is the **sole** module that imports `@mariozechner/pi-ai`. Every other adapter in the package consumes that gateway through exported bridge functions. The same file consolidates the `streamAcp` adapter, Pi `ModelRegistry`/`AgentSession` monkeypatches, and the provider guard toggle helper (called from `fleet:system:settings`) via labelled `#region` sections — they live together because each represents a different facet of the single Pi-provider gateway.
3. **Public surface only** — fleet-core is consumed exclusively through the `@sbluemin/fleet-core` root barrel and documented subpaths. Reaching into `@sbluemin/fleet-core/src/**` is a build break, not a style preference.

## Current Architecture Status: Flat Domain Architecture

- The **physical layout mirrors fleet-core facades**:
  - `src/` houses thin adapters that bridge `fleet-core` facades to Pi capabilities.
  - Large domains with UI or complex registration live in subdirectories (`grand-fleet/`, `wiki/`).
  - Lean services live as single files in `src/` (e.g., `fleet.ts`, `jobs.ts`).
- **Do not reintroduce "Capability Buckets"** (commands/, keybinds/, tools/, etc.) at the root level of `src/`.

## Domain Mirror Layout (1:1 Service Mapping)

| pi-fleet-extension (Adapter) | fleet-core (Public Service) | Description |
| :--- | :--- | :--- |
| `src/provider.ts` | `admiral.agent` surfaces (`session`, `events`, `tools`, `executor`, `lifecycle`, `connections`, `models`, `bridge`) | Single consolidated Pi gateway (#region structure: pi-ai gateway / streamAcp adapter / thinking-level patch / provider-guard registry patch / provider-guard toggle helper / provider runtime registration). Agent Panel UI lives under `panel/`. ColBlock, stream reducers, and view-model builders are host-local in `panel/`. |
| `src/grand-fleet/` | `admiralty` | Admiralty/Fleet roles, IPC, and GF session state |
| `src/wiki/` | `@sbluemin/fleet-wiki` | Fleet Wiki tool/command registration and overlays |
| `src/hud/`, `src/panel/`, `src/pty/`, `src/welcome.ts` | (Host Surfaces) | HUD, Welcome UI, shared TUI overlays, and shortcuts |
| `src/fleet.ts` | `admiral` + `metaphor` + `infra` | Core Fleet state, protocols, operation naming, event adapters |
| `src/metaphor.ts` | `metaphor` | Worldview and directive refinement wiring |
| `src/jobs.ts` | `admiral.carrierJobs` + `infra.job` | Fleet carrier job lifecycle and status tracking |
| `src/settings.ts` | `infra.settings` | Fleet-to-Pi settings sync and persistence |
| `src/logs.ts` | `infra.log` | Fleet log store and terminal output streaming |
| `src/tools.ts` | `admiral.agent.tools` | Pi-side tool registration consuming core tool specs and invoke surface |

## Must Own

- `ExtensionAPI`, `ExtensionContext`, `pi.on(...)`, `pi.registerTool(...)`, `pi.registerCommand(...)`, `pi.registerShortcut(...)`, `pi.registerProvider(...)`, and `pi.sendMessage(...)`
- Pi widget/editor/footer/overlay rendering and TUI component mounting
- Pi-specific lifecycle coordination (`src/boot.ts`, `src/fleet.ts`). `bootstrapFleetState(pi)` is the single entry point for both cold boot and warm `session_start`; it composes `restoreFleetPreRegistrationState()`, carrier registration, and deferred reconciliation. `scheduleFleetReconciliation()` (formerly `scheduleFleetBootReconciliation`) defers model reconciliation, squadron pruning, and Task Force sync into the next tick with a re-entrancy guard. `restoreFleetPreRegistrationState()` always applies stored sortie/squadron state, including empty lists, to reset stale in-memory Sets.
- The sole `@mariozechner/pi-ai` gateway at `src/provider.ts`
- `handleCarrierJobStreamEvent` as the canonical Pi adapter for forwarding `systemReminder` payloads to the host LLM via `pi.sendMessage`; `carrier-completion.ts` is removed.

## Must Not Own

- Fleet domain business logic that belongs in `fleet-core` or `fleet-wiki`
- Monolithic "Capability Buckets" that group unrelated domains by Pi API type
- Additional `@mariozechner/pi-ai` imports outside `src/provider.ts`
- Direct file imports from `@sbluemin/fleet-core/src/**` (use public exports only)

## Import Boundaries

- Consume `@sbluemin/fleet-core` only through the root barrel or the four documented subpaths: `admiral`, `admiralty`, `metaphor`, `infra`.
- Consume Grand Fleet domain APIs through `@sbluemin/fleet-core/admiralty` or the root `admiralty` facade.
- Large domain adapters (`grand-fleet/`) may export specialized hooks or components for host UI modules to consume.
- Tool definitions must come from `fleet-core` registries; Pi adapters only handle host registration and rendering.

## Dependency Direction

- `pi-fleet-extension -> fleet-core`
- `pi-fleet-extension -> fleet-wiki`

## Migration Guardrails

- Do not reintroduce Pi dependencies into `fleet-core`.
- Do not create new code under removed capability bucket homes like `src/commands/`, `src/tools/`, or legacy `src/agent/provider-internal/`.
- Do not split `src/provider.ts` back into `provider-stream.ts`, `provider-runtime.ts`, `provider-guard.ts`, `provider-guard-command.ts`, or `thinking-level-patch.ts`. The single-file + `#region` structure is the architecture, not a refactor target.
- Do not reintroduce a `runner.ts` / `exposeAgentApi`-style executor adapter. The carrier-tier executor is owned by `admiral.executor` in fleet-core; host code calls it through the root barrel.
- All Pi registration code must reside within the specific domain adapter folder or file it serves.
- The `src/hud/` module owns the aggregate host UI but delegates domain-specific rendering to its respective adapter.

## Forbidden Patterns

- `globalThis.<key>` for shared host state. Use module-level singletons; the legacy `__pi_unified_agent_*` keys have been removed.
- Holding fleet-core builders (e.g., `setCliRuntimeContext`-style setters). Prompt assembly is fleet-core's responsibility — the host sends raw `userRequest` + optional `history` through `admiral.session.sendMessage`.
- Per-turn `admiral.events.register` calls. Stream-event handlers register **once at boot** via `initStreamEventHandler()`; per-turn routing happens through the host-local `Map<sessionId, push>`.
- Re-implementing fleet tool specs. Hosts query `admiral.tools.list()` for metadata and call `admiral.tools.invoke()` for execution; only host-only tools (`request_directive`, fleet-wiki, admiralty, grand-fleet) are registered through `pi.registerTool` directly.

## Compatibility Rules

- Preserve slash command names while replacing compatibility state with module-level singleton state and explicit set/get APIs; follow the `hud/border-bridge.ts` precedent.
- Preserve custom message delivery semantics for carrier completion pushes.
- Compatibility bridges are integrated into their respective domain adapters; no separate `bindings/` directory is permitted.
