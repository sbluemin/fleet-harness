# pi-fleet-extension Doctrine

`packages/pi-fleet-extension` is the Pi capability package for Fleet. It owns Pi runtime wiring, host shell surfaces, and domain-specific adapters while consuming `@sbluemin/fleet-core` public exports, `@sbluemin/fleet-core/admiralty*` (Grand Fleet domain), and `@sbluemin/fleet-wiki`.

## Current Architecture Status: Flat Domain Architecture

- The **physical layout mirrors fleet-core services**:
  - `src/` houses thin adapters that bridge `fleet-core` services to Pi capabilities.
  - Large domains with UI or complex registration live in subdirectories (`agent/`, `grand-fleet/`, `fleet-wiki/`, `shell/`).
  - Lean services live as single files in `src/` (e.g., `fleet.ts`, `job.ts`).
- **Do not reintroduce "Capability Buckets"** (commands/, keybinds/, tools/, etc.) at the root level of `src/`.

## Domain Mirror Layout (1:1 Service Mapping)

| pi-fleet-extension (Adapter) | fleet-core (Public Service) | Description |
| :--- | :--- | :--- |
| `src/agent/` | `FleetServices` (Partial) | Pi AI provider, streaming, Agent Panel UI, and session management (`state.ts`, `session-runtime.ts`, `service-status-store.ts`, `thinking-level-patch.ts`). MCP and tool snapshots are now consumed via `fleet.mcp`. |
| `src/grand-fleet/` | `GrandFleetServices` / `Admiralty` | Admiralty/Fleet roles, IPC, and GF session state |
| `src/fleet-wiki/` | `@sbluemin/fleet-wiki` | Fleet Wiki tool/command registration and overlays |
| `src/shell/` | (Host Surfaces) | HUD, Welcome UI, shared TUI overlays, and shortcuts |
| `src/fleet.ts` | `FleetServices` (Core) | Core Fleet state and event adapters |
| `src/metaphor.ts` | `MetaphorServices` | Worldview and directive refinement wiring |
| `src/job.ts` | `JobServices` | Fleet carrier job lifecycle and status tracking |
| `src/settings.ts` | `SettingsServices` | Fleet-to-Pi settings sync and persistence |
| `src/log.ts` | `LogServices` | Fleet log store and terminal output streaming |
| `src/tool-registry.ts` | `FleetServices` (Tools) | Pi-side tool registration consuming `fleet.tools` from core |

## Must Own

- `ExtensionAPI`, `ExtensionContext`, `pi.on(...)`, `pi.registerTool(...)`, `pi.registerCommand(...)`, `pi.registerShortcut(...)`, `pi.registerProvider(...)`, and `pi.sendMessage(...)`
- Pi widget/editor/footer/overlay rendering and TUI component mounting
- Pi-specific lifecycle coordination (`src/boot.ts`, `src/fleet.ts`). `bootstrapFleetState(pi)` is the single entry point for both cold boot and warm `session_start`; it composes `restoreFleetPreRegistrationState()`, carrier registration, and deferred reconciliation. `scheduleFleetReconciliation()` (formerly `scheduleFleetBootReconciliation`) defers model reconciliation, squadron pruning, and Task Force sync into the next tick with a re-entrancy guard. `restoreFleetPreRegistrationState()` always applies stored sortie/squadron state, including empty lists, to reset stale in-memory Sets.
- The sole `@mariozechner/pi-ai` gateway at `src/agent/provider.ts`

## Must Not Own

- Fleet domain business logic that belongs in `fleet-core` or `fleet-wiki`
- Monolithic "Capability Buckets" that group unrelated domains by Pi API type
- Additional `@mariozechner/pi-ai` imports outside `src/agent/provider.ts`
- Direct file imports from `@sbluemin/fleet-core/src/**` (use public exports only)

## Import Boundaries

- Consume `@sbluemin/fleet-core` only through documented public root or subpath exports.
- Consume Grand Fleet domain APIs through `@sbluemin/fleet-core/admiralty` and `@sbluemin/fleet-core/admiralty/ipc`.
- Large domain adapters (`agent/`, `grand-fleet/`) may export specialized hooks or components for `shell/` to consume.
- Tool definitions must come from `fleet-core` registries; Pi adapters only handle host registration and rendering.

## Dependency Direction

- `pi-fleet-extension -> fleet-core`
- `pi-fleet-extension -> fleet-wiki`

## Migration Guardrails

- Do not reintroduce Pi dependencies into `fleet-core`.
- Do not create new code under removed capability bucket homes like `src/commands/`, `src/tools/`, or legacy `src/agent/provider-internal/`.
- All Pi registration code must reside within the specific domain adapter folder or file it serves.
- The `src/shell/` domain owns the aggregate host UI but delegates domain-specific rendering to its respective adapter.

## Compatibility Rules

- Preserve slash command names and existing `globalThis` compatibility keys.
- Preserve custom message delivery semantics for carrier completion pushes.
- Compatibility bridges are integrated into their respective domain adapters; no separate `bindings/` directory is permitted.
