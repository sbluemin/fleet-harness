# fleet-harness Doctrine

`packages/fleet-harness` is the Pi capability package for Fleet. It owns Pi runtime wiring, host shell surfaces, and domain-specific adapters while consuming `@sbluemin/fleet-core` public exports, `@sbluemin/fleet-core/admiralty*` (Grand Fleet domain), and `@sbluemin/fleet-wiki`.

## Core Philosophy

This package is a **thin, opinionated adapter** between fleet-core's domain surfaces and the Pi runtime. Three principles direct every module here:

1. **Adapter, not domain** — fleet-core owns Fleet behavior; this package owns the wiring. When a feature contains both pure logic and Pi-specific glue, the pure half migrates to fleet-core and only the glue stays here.
2. **One Fleet-AI gateway** — `src/provider.ts` is the **sole** module that re-exports the Fleet-AI surface (`@sbluemin/fleet-ai`). The Fleet engine packages (`@sbluemin/fleet-ai`, `@sbluemin/fleet-tui`, `@sbluemin/fleet-coding-agent`, `@sbluemin/fleet-unified-agent`) are consumed through `workspace:*` from `engines/packages/*`; do not replace them with published npm references. Every other adapter in the package consumes the gateway through exported bridge functions. The same file consolidates the `streamAcp` adapter, `AgentSession` thinking-level monkeypatch, and host-owned provider runtime registration via labelled `#region` sections.
3. **Public surface only** — fleet-core is consumed exclusively through the `@sbluemin/fleet-core` root barrel and documented subpaths. Reaching into `@sbluemin/fleet-core/src/**` is a build break, not a style preference.

## Current Architecture Status: Flat Domain Architecture

- The **physical layout mirrors fleet-core facades**:
  - `src/` houses thin adapters that bridge `fleet-core` facades to Pi capabilities.
  - Large domains with UI or complex registration live in subdirectories (`grand-fleet/`, `wiki/`).
  - Lean services live as single files in `src/` (e.g., `fleet.ts`, `jobs.ts`).
- **Do not reintroduce "Capability Buckets"** (commands/, keybinds/, tools/, etc.) at the root level of `src/`.

## Domain Mirror Layout (1:1 Service Mapping)

| fleet-harness (Adapter) | fleet-core (Public Service) | Description |
| :--- | :--- | :--- |
| `src/provider.ts` | `admiral.agent` surfaces (`session`, `events`, `tools`, `executor`, `lifecycle`, `connections`, `models`, `bridge`) | Single consolidated Fleet host gateway (#region structure: fleet-ai gateway / streamAcp adapter / thinking-level patch / provider runtime registration). Host-owned provider registration lives here; no legacy registry-filter workaround remains. Agent Panel UI lives under `panel/`. ColBlock, stream reducers, and view-model builders are host-local in `panel/`. |
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
- **`fs.watch` Synchronization**: `fleet-harness` owns the file watcher registration on the fleet data directory. It triggers `refreshStates()` when external changes are detected in `states.json`, while suppressing "self-echo" events by comparing the written `_generation` token.
- `scheduleFleetReconciliation()` (formerly `scheduleFleetBootReconciliation`) defers model reconciliation, squadron pruning, and Task Force sync into the next tick with a re-entrancy guard.
- The sole Fleet-AI (`@sbluemin/fleet-ai`) re-export gateway at `src/provider.ts`
- Explicit host-owned provider registration at `src/provider.ts` only. Upstream built-in provider auto-registration and the old Fleet-side registry-filter remediation are removed.
- `handleCarrierJobStreamEvent` as the canonical Pi adapter for forwarding `systemReminder` payloads to the host LLM via `pi.sendMessage`; `carrier-completion.ts` is removed.

## Must Not Own

- Fleet domain business logic that belongs in `fleet-core` or `fleet-wiki`
- Monolithic "Capability Buckets" that group unrelated domains by Pi API type
- Additional direct `@sbluemin/fleet-ai` imports outside `src/provider.ts` (consume the gateway re-exports instead)
- Direct file imports from `@sbluemin/fleet-core/src/**` (use public exports only)

## Import Boundaries

- Consume `@sbluemin/fleet-core` only through the root barrel or the four documented subpaths: `admiral`, `admiralty`, `metaphor`, `infra`.
- When accessing domain functionality, prefer the facade namespace (e.g., `admiral.protocols.xxx`) over root barrel named imports. Root barrel direct imports are reserved for runtime assembly (`createFleetCoreRuntime`) and frozen legacy symbols.
- Consume Grand Fleet domain APIs through `@sbluemin/fleet-core/admiralty` or the root `admiralty` facade.
- Large domain adapters (`grand-fleet/`) may export specialized hooks or components for host UI modules to consume.
- Tool definitions must come from `fleet-core` registries; Pi adapters only handle host registration and rendering.

## Dependency Direction

- `fleet-harness -> fleet-core`
- `fleet-harness -> fleet-wiki`
- `fleet-harness -> @sbluemin/fleet-*` (active engine workspace via `workspace:*`)
- `fleet-harness -> @sbluemin/fleet-unified-agent`

## Migration Guardrails

- Do not reintroduce Pi dependencies into `fleet-core`.
- Do not create new code under removed capability bucket homes like `src/commands/`, `src/tools/`, or legacy `src/agent/provider-internal/`.
- Do not split `src/provider.ts` back into legacy stream/runtime/guard fragments or `thinking-level-patch.ts`. The single-file + `#region` structure is the architecture, not a refactor target.
- Do not reintroduce legacy registry-filter monkeypatches, persistence keys, toggle commands, or hidden upstream fallback assumptions. Pre-registration `piCompleteSimple` failure is the intended contract until follow-up host wiring lands.
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

## PI TUI Layout & Terminology

PI renders a vertical stack of **zones**. Extensions customize these zones via official TUI APIs.

```
┌──────────────────────────────────┐
│  Header                          │  built-in
├──────────────────────────────────┤
│  Messages                        │  built-in · registerMessageRenderer()
├──────────────────────────────────┤
│  Widget:above                    │  setWidget()
├──────────────────────────────────┤
│  Editor                          │  setEditorComponent()
├──────────────────────────────────┤
│  Widget:below                    │  setWidget()
├──────────────────────────────────┤
│  Footer                          │  setFooter()
└──────────────────────────────────┘
  Overlay                            ctx.ui.custom() — floating or editor-replace
```

### Canonical Terms

| Term | Zone | Owner | Notes |
|------|------|-------|-------|
| **Header** | Header | pi | Startup info, badges |
| **Messages** | Messages | pi | Conversation, tool calls/results, custom messages |
| **Editor** | Editor | `core/hud` | User input (HUD replaces default) |
| **Footer** | Footer | `core/hud` | Bottom tokens — dir, session, cost, model (HUD replaces default) |
| **Status Bar** | Widget:above | `core/hud` | Segment-based status line above Editor |
| **Agent Panel** | Custom UI | `fleet` | Carrier streaming UI — exclusive / multi-column / compact view |
| **Streaming Widget** | Widget:below | `fleet` | belowEditor expanded carrier bridge widget (`fleet-carrier-bridge-expanded`); Alt+Shift+P toggles visibility (default off); auto-hides on Alt+P; 10-line cap |
| **Carrier Roster** | Widget:above | `fleet` | Permanent aboveEditor carrier tile strip (`fleet-carrier-job-hud`) — 1-line status display (e.g., ○ Nimitz │ ○ Sentinel) driven by panel data |
| **Overlay** | Overlay | various | keybind (Alt+.), settings (Alt+/), and carrier status (Alt+O) are editor-replace; welcome remains floating |

### Rules

- Use the **canonical terms** above in all code comments, docs, and AGENTS.md files.
- When an extension contributes UI, note which **zone** and **API** it targets.
