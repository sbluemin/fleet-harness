# Fleet

> **A Multi-LLM Orchestration Kit**
>
> A custom extension fleet based on [pi-coding-agent](https://github.com/badlogic/pi-mono).
> The core purpose is to operate 8 carriers — Claude Code, Codex CLI, and Gemini CLI — through a single unified interface.

## Structure

| Path | Description |
|------|-------------|
| `docs/pi-development-reference.md` | **Main Developer Guide** — Comprehensive reference for PI SDK, extensions, TUI, themes, and RPC |
| `docs/admiral-workflow-reference.md` | **Operational Doctrine** — High-level architecture, naval hierarchy, and delegation workflows |
| `packages/` | First-party workspace packages: `unified-agent`, `fleet-core`, `fleet-wiki`, `pi-fleet-extension` |
| `packages/fleet-core/` | Pi-agnostic Fleet product core — Fleet domain logic, prompts, runtime contracts, MCP/tool/job internals, **Admiral orchestration runtime**, and public APIs |
| `packages/fleet-core/src/admiral/` | Admiral-owned Fleet orchestration/runtime modules: `_shared/` (carrier-job-events SSOT stream events, cli-tool-types, MCP server singleton), **`agent/`** (the canonical agent domain — `session/lifecycle/connections/models/events/serviceStatus/tools/bridge/executor` + `internal/{state,session-runtime,session-engine,event-normalizer,mcp-router,executor-engine,post-connect}`), `carrier/`, `carrier-jobs/`, `squadron/`, `taskforce/`, `store/` (provider-catalog and `fleet-store.ts` unified persistence), and `protocols/`. **Standing orders** are integrated under `protocols/standing-orders/`. |
| `packages/fleet-core/src/infra/` | Shared pure infrastructure modules. Includes `auth/`, `data-dir/`, `job/`, `log/`, `settings/`, and **tool-registry**. |
| `packages/fleet-core/src/admiralty/` | Grand Fleet domain home inside `fleet-core` (renamed from `gfleet`). Exposed via `@sbluemin/fleet-core/admiralty`. |
| `packages/fleet-core/src/public/` | Public composition surface. Keep `runtime.ts` plus four assembly-only service modules: `admiral-services`, `admiralty-services`, `metaphor-services`, and `infra-services`. |
| `packages/pi-fleet-extension/` | Pi capability package — Flat Domain Architecture mirroring fleet-core public services |
| `packages/unified-agent/` | Minimal-dependency SDK for multi-CLI integration (Gemini, Claude, Codex). Now includes `service-status/` for unified health tracking. |
| `packages/pi-fleet-extension/src/` | Root of pi-facing domains |
| `packages/pi-fleet-extension/src/boot.ts` | Entry point — assembles the Fleet runtime by composing domain modules |
| `packages/pi-fleet-extension/src/fleet.ts` | Fleet lifecycle, runtime initialization, and Pi host port implementation. `bootstrapFleetState()` is the single entry point for both boot-time and `session_start` fleet state restoration, carrier registration, and deferred reconciliation. |
| `packages/pi-fleet-extension/src/{grand-fleet,wiki}/` | Domain-internal homes. Each owns its commands, keybinds, tools, and UI. |
| `packages/pi-fleet-extension/src/{fleet,metaphor,job,settings,logs,tools}.ts` | Domain entrypoints mapping 1:1 to fleet-core services |
| `packages/pi-fleet-extension/src/{commands,keybinds,tools,tui,provider,session}/` | Removed legacy capability buckets. Do not reintroduce; all features are now organized by domain. |

> Currently, there is no `pi/` directory — symlink setup is not required.
>
> Migration note: the **logical split is already final** (`fleet-core` owns Fleet domain logic including the internalized `admiralty` domain, and `pi-fleet-extension` owns Pi host domains), and `packages/pi-fleet-extension/src/` remains the active physical home for the Flat Domain Architecture.

### Domain Mirror Layout

The `pi-fleet-extension` architecture mirrors the public services of `fleet-core` 1:1. Each core service is mapped to a corresponding domain in the extension.

| fleet-core Public Service | pi-fleet-extension Domain | Description |
|---------------------------|---------------------------|-------------|
| `admiral`                 | `src/provider.ts`, `src/fleet.ts`, `src/tools.ts`, `src/jobs.ts` | Agent orchestration, providers, carrier jobs, protocols, carrier status |
| `admiralty`               | `src/grand-fleet/`        | Multi-instance Grand Fleet orchestration |
| `metaphor`                | `src/metaphor.ts`         | Persona, worldview, operation naming, directive refinement |
| `infra`                   | `src/settings.ts`, `src/logs.ts`, `src/panel/`, host helpers | Settings, logs, job archive/lifecycle utilities, tool registry, shared constants via facades |
| `@sbluemin/fleet-wiki`    | `src/wiki/`               | Fleet knowledge base and ingest |
| (Host specific)           | `src/hud/`, `src/panel/`, `src/pty/`, `src/welcome.ts` | Host shell integration and terminal features |


## Fleet Architecture (Metaphor)

This project is an **Agent Harness** that centrally commands and orchestrates powerful CLI tools (Claude Code, Codex, Gemini, etc.), each of which possesses its own internal sub-agent system.

Beyond simple parallel API calls, the system adopts a **naval fleet metaphor** to clearly separate roles and responsibilities across the architecture.

### Core Entities

| Layer | Entity | Metaphor | Definition |
|-------|--------|----------|------------|
| 1 | **Admiral of the Navy** (ATN) | 대원수 (User) | **The user** who wields the tool. Sets ultimate strategy and final objectives for the fleet. |
| 2 | **Fleet Admiral** | 사령관 (Grand Fleet) | The **Admiralty LLM persona** (internalized domain in `fleet-core`). Responsible for multi-fleet orchestration. *Does not exist in single-fleet mode; the user communicates directly with the Admiral.* |
| 3 | **Admiral** | 제독 (Host PI) | A single **workspace PI instance**. Plans operations and dispatches Carriers within its operational zone. |
| 4 | **Captain** | 함장 (Carrier Persona) | The **persona of a Carrier agent**. While a Carrier is the system entity, the Captain is its personified commander. |

> **Note on Persona & Tone**: The naming conventions, personified personas, and linguistic tone for all tiers are centrally managed by `packages/fleet-core/src/metaphor/`. The former `packages/pi-fleet-extension/src/metaphor/` legacy directory has been removed and must not be recreated as a Pi-side domain home.

#### Carrier vs Captain Separation
- **Carrier**: The **system entity** (ID: `genesis`, `sentinel`, etc.). Represents the execution instance, process, and configuration.
- **Captain**: The **commander persona** of that Carrier. Represents the "voice" and "character" (e.g., Chief Engineer, Scout Specialist) that communicates with the Admiral.

## Architecture — Agent Workflow

PI is the **host agent** (orchestrator). Registered Carriers are **sub-agents** that execute independently via ACP protocol.

### Speakers

| Speaker | Role |
|---------|------|
| **PI** (host) | Orchestrator — routes requests, invokes tools, synthesizes cross-reports |
| **Nimitz** (sub) | CVN-09 Strategic Command & Judgment — read-only (Claude Code CLI via ACP) |
| **Kirov** (sub) | CVN-02 Operational Planning Bridge (Claude Code CLI via ACP) |
| **Genesis** (sub) | CVN-01 Chief Engineer — single-shot implementation under Admiral direction (Codex CLI via ACP) |
| **Ohio** (sub) | CVN-10 Multi-Wave Strike Execution — receives `plan_file` from Kirov; sole plan-driven executor (Codex CLI via ACP) |
| **Sentinel** (sub) | CVN-04 The Inquisitor / QA & Security Lead (Codex CLI via ACP) |
| **Vanguard** (sub) | CVN-06 Scout Specialist (Codex CLI via ACP) |
| **Tempest** (sub) | CVN-07 Forward External Intelligence Strike (Gemini CLI via ACP) |
| **Chronicle** (sub) | CVN-08 Chief Knowledge Officer — documentation, change-impact summaries, and release communication (Gemini CLI via ACP) |

### Execution Modes

| Mode | Trigger | Flow |
|------|---------|------|
| **Fleet Action** | Alt+1 (Active Protocol) | PI handles directly (no sub-agents) — Standard workflow |
| **Tool delegation** | PI's own judgment | PI → tool_call(any carrier) → sub-agent result → PI synthesizes |
| **Bridge (single)** | Alt+T | User → single sub-agent shell (PI acts as router only, no synthesis) |

### Task Force Backend Whitelist

`carrier_taskforce` accepts every CLI provider registered in `CLI_BACKENDS` (Single Source of Truth). The current whitelist contains **6 backends**:

| CLI Type | Display Name | Notes |
|----------|--------------|-------|
| `claude` | Claude Code | Anthropic-hosted Claude (default) |
| `claude-zai` | Claude Code with Z.AI GLM | Claude bridge with Z.AI base URL |
| `claude-kimi` | Claude Code with Moonshot Kimi | Claude bridge with Moonshot base URL |
| `codex` | Codex | OpenAI Codex (`codex-app-server`) |
| `gemini` | Gemini | Google Gemini CLI |
| `opencode-go` | OpenCode | OpenCode Go CLI |

- `TaskForceCliType` is an alias of `CliType`; `TASKFORCE_CLI_TYPES` is auto-derived via `Object.keys(CLI_BACKENDS) as CliType[]` in `packages/fleet-core/src/admiral/taskforce/types.ts`.
- Tool description copy (`TASKFORCE_CONFIGURE_HINT`, `[carrier:result]` backend label examples) and overlay colors (`CARRIER_COLORS`) are derived from `CLI_BACKENDS × CLI_DISPLAY_NAMES`. Adding a new entry to `CLI_BACKENDS` automatically extends Task Force without touching prompts or the overlay.
- **Persona × CLI compatibility is allowed**: any registered carrier persona may pair with any of the six CLI backends. Configure pairings via Carrier Status (Alt+O → T) per carrier.
- Providers without supported reasoning effort follow the existing Gemini pattern (`reasoningEffort.supported = false`) and surface no effort/budget controls in the configuration overlay.

## Operational Protocols & Standing Orders

The Admiral extension implements a modular prompt policy system that governs how the host agent (PI) operates. This system is composed of **Standing Orders** and **Protocols**.

### Core Concepts

| Concept | Definition | Scope |
|---------|------------|-------|
| **Standing Orders** | Cross-cutting mechanisms always injected into the system prompt. | Global — applies to all sessions and protocols. |
| **Protocols** | Mutually exclusive workflows that define the current operational mode. | Session-specific — exactly one protocol is always active. |

### Standing Orders

- **Delegation Policy**: Defines how and when PI should delegate tasks to carriers.
- **Deep Dive**: Strategy for recursive investigation and root-cause analysis.
- **Always Active**: These are injected into every agent start sequence regardless of the selected protocol.

### Protocols

- **Fleet Action Protocol (Alt+1)**: The default, high-performance workflow for standard operations.
- **Modular Expansion**: Additional protocols (e.g., specific research or refactoring modes) can be assigned to `Alt+2` through `Alt+9`.
- **Switching**: Protocols are switched via dedicated hotkeys. Only one protocol can be active at a time; deactivation is not possible (switching only).

### Prompt Structure

에이전트에게 전달되는 최종 시스템 프롬프트는 다음과 같은 계층 구조로 합성됩니다:

```text
System Prompt
  + [Boot] Initial Slate (PI_FLEET_DEV=1 시 RISEN 개발 컨텍스트, 그 외 빈 문자열)
  + [Toggle] Worldview (via metaphor:worldview)
  + [Always] Standing Orders (Delegation Policy + Deep Dive + ...)
  + [Always] Active Protocol (Fleet Action Protocol, etc.)
  + [Always] request_directive guide
```

### UI & UX Integration

- **Editor Border Color**: The editor's border color changes based on the active protocol through the `core-hud/border-bridge` module-level set/get API.
- **Editor Top Border (Center Label)**: The active protocol short label (e.g., `⚓ Fleet Action`) is rendered at the center of the editor's top border via the `core-hud/border-bridge` `setEditorRightLabel` API.
- **Editor Bottom Border (Right Label)**: The current session's operation name (managed by the `metaphor:operation` domain) is rendered at the right end of the editor's bottom border via the `core-hud/border-bridge` `setEditorBottomRightLabel` API. Distinct domain from protocol UI but shares the editor border surface.
- **Settings Popup (Alt+/)**: The "Admiral" section allows manual selection of the `activeProtocol` and toggling of the `worldview`.

### Key Bindings

| Key | Protocol / Action |
|-----|-------------------|
| **Alt+1** | Switch to Fleet Action Protocol |
| **Alt+2~9** | Switch to dynamically assigned protocols |
| **Alt+/** | Open Settings (to configure Admiral parameters) |

## Architecture Philosophy

The Fleet codebase is built on **four core principles**. Every contribution and review must align with these — they take precedence over micro-optimizations or local convenience.

### 1. Domain Boundary as Law

The split between `fleet-core` (Pi-agnostic Fleet domain) and `pi-fleet-extension` (Pi host adapter) is **not a guideline; it is enforced by build/grep gates**:

- `fleet-core` MUST NOT import any `@mariozechner/pi-*` or `@anthropic-ai/*` package. The single Pi-AI gateway lives in `pi-fleet-extension/src/provider.ts`.
- `pi-fleet-extension` consumes `fleet-core` only through the **public root barrel** or documented public subpaths. Deep imports into `src/**` are forbidden.
- Pi UI, host event hooks (`pi.on/registerTool/registerProvider/...`), and any `ExtensionContext`/`ExtensionAPI` dependency belong exclusively to the Pi side.
- When splitting a mixed module, the pure/domain half moves into `fleet-core` and only the Pi adapter half stays in `pi-fleet-extension`.

### 2. Two Execution Patterns, Strictly Separated

The Admiral agent domain exposes **two distinct execution patterns** that must never be merged:

| Pattern | Surface | Lifetime | Use Case |
|---------|---------|----------|----------|
| **Streaming** | `admiral.session.{ensure, sendMessage, deliverToolResults}` + `admiral.events` (module emit/register channel) | Long-lived ACP session, multiplexed per `sessionId` | Pi `streamAcp` host adapter; host `Map<sessionId, push>` routing |
| **Closed-loop callback** | `admiral.executor.{executeWithPool, executeOneShot}` with `CarrierExecuteOptions.onMessageChunk/onThoughtChunk/onToolCall/...` | Single carrier turn, returns `CarrierExecResult` synchronously | `carrier_<id>` (individual carrier tools) / `carrier_squadron` / `carrier_taskforce` tool execution |

**Why the separation matters**: streaming routes events through a global module channel keyed by `sessionId`, while executor callbacks are owner-specific and finite. Forcing one pattern through the other path causes either listener leaks (callback as event) or routing collisions (event as callback).

### 3. Single Source of Truth (SSoT)

Several invariants are guarded by a **single owner** — duplication or shadowing is treated as a regression:

| Concept | Owner | Rationale |
|---------|-------|-----------|
| Session persistence (`<piSessionId>.json` carrier→ACP map) | `admiral/agent/internal/session-runtime.ts` | Resume/restore semantics depend on a single in-memory cache backed by one file. |
| Track status enum | `admiral/_shared/carrier-job-events.ts:TrackStatus` | Six values cover both panel UI and executor lifecycle; legacy `AgentStatus`/`ColStatus` are removed. |
| MCP server URL + token routing | `admiral/_shared/mcp.ts` lazy singleton | One HTTP server, per-session Bearer tokens, FIFO routing isolated by token. |
| CLI provider catalog | `@sbluemin/unified-agent`'s `CLI_BACKENDS` | All `TASKFORCE_CLI_TYPES`, display names, colors, and reasoning capabilities derive from this. |
| Fleet tool catalog | `admiral.agent.tools.list()` (default specs auto-registered, host extras via `registerExtraTools`) | Host queries metadata + invokes — never re-implements specs. |

### 4. Public Surface Discipline

Decision 28 (codified through the admiral.agent migration): the **only consumer-facing entry point** is the package root barrel of `@sbluemin/fleet-core`. There is no `./admiral/agent` subpath; consumers reach `executeWithPool`, `executeOneShot`, `bindHostSession`, `cleanIdle`, `disconnect`, `disconnectAll`, `getSessionIdFor`, and `shutdownAllSessions` exclusively through that barrel. Internal helpers under `admiral/agent/internal/` are never re-exported.

### Forbidden Patterns

- `globalThis.<anything>` for shared state — use module-level singletons instead. Legacy `__pi_unified_agent_client_pool__` and `__pi_unified_agent_launch_config__` keys are removed.
- Push-style "ports" passed into tool execution (`AgentToolPorts` is removed). Tools depend on `fleet-core` services directly.
- `on*` callback parameters threaded through `fleet-core` public APIs — events flow through `admiral.events` module-level register/emit only.
- Builder functions injected by hosts (e.g., legacy `setCliRuntimeContext`). Prompt assembly (`buildInitialPrompt`, `buildRuntimeContextPrompt`) is fleet-core's responsibility; host adapters pass raw `userRequest` + optional `history`.

## Fleet Architecture (Sub-agent Workflow)

- **Sub-agents are fully independent** — PI provides only background, objectives, and constraints. Never prescribe implementation details.
- **Sub-agents are unaware of each other** — Cross-analysis is performed solely by PI after all responses are collected.
- **Communication layer**: Pi consumers invoke `executeWithPool()` / `executeOneShot()` from the `@sbluemin/fleet-core` root barrel (callback-pattern executor); the streaming `streamAcp` adapter consumes `admiral.session.*` + `admiral.events.*`. Both paths terminate at ACP stdio (all CLIs share the protocol).

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
  Overlay                            ctx.ui.custom() — floating
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
| **Streaming Widget** | Widget | `fleet` | 1-line compact indicator when Agent Panel is collapsed |
| **Overlay** | Overlay | various | Floating panel — keybind (Alt+.), settings (Alt+/), welcome |

### Rules

- Use the **canonical terms** above in all code comments, docs, and AGENTS.md files.
- When an extension contributes UI, note which **zone** and **API** it targets.

## Domain Boundary Rules

> Refer to `package AGENTS.md files` for the full cross-layer dependency rules, layer hierarchy, and verification table.

## Slash Command Naming

All slash commands registered by extensions must follow this naming convention.

### Format

```
fleet:<domain>:<feature>
```

- **All lowercase** — No uppercase letters, no underscores.
- **`:` as separator** — Use `:` between segments. Do not use `-`, `_`, or `/`.
- **Exactly 3 segments** — `fleet` prefix + domain + feature. Do not nest further.

### Domain Assignment

Each feature area maps to exactly one command domain. Use the domain below regardless of historical directory names or removed legacy homes.

| Feature Area | Domain | Rationale |
|-----------|--------|-----------|
| `fleet` agent orchestration surfaces | `agent` | Sub-agent orchestration features |
| `fleet-wiki` surfaces | `wiki` | Fleet Wiki store, patch queue, ingest |
| Admiral protocol and doctrine surfaces | `admiral` | Host-agent prompt policy, protocols, and operational doctrine |
| Detached carrier job surfaces | `jobs` | Detached carrier job rendering and verbose toggle |
| Metaphor/persona/worldview surfaces | `metaphor` | Naval Fleet persona prompts, worldview management, and shared metaphor controls |
| Carrier registration surfaces | `carrier` | Individual carrier registration and configuration |
| HUD display surfaces | `hud` | HUD / editor display features |
| Operation naming surfaces | `metaphor:operation` | Session operation naming settings |
| Directive refinement surfaces | `metaphor:directive` | Directive refinement (3-section) settings |
When adding a **new extension**, assign a domain that reflects the **feature category**, not the directory prefix (`core-`, etc.).

### Feature Naming

- Use a **verb or noun** that describes the action or target — e.g., `status`, `editor`, `models`, `settings`, `worldview`.
- Prefer short, unambiguous words. Avoid abbreviations (`settings` not `cfg`, `status` not `stat`).
- `settings` — reserved for commands that open a configuration UI for that domain.
- `run` — reserved for manual re-trigger of an automated behavior (e.g., re-summarize on demand).

### Conflict Prevention

- The `fleet:` prefix is **reserved for this project**. Never register commands without it.
- Domain names are shared across extensions — coordinate to avoid feature name collisions within a domain.

### When to Apply

- Apply this naming from the **first `registerCommand` call** in a new extension — do not rename later.
- Commands without the `fleet:` prefix must be renamed before they are merged into active extensions.

## TypeScript File Structure

All `.ts` source files must follow this top-to-bottom declaration order:

```
imports → types/interfaces → constants → functions
```

- **Imports** — external packages first, then internal modules.
- **Types / Interfaces** — `interface` and `type` declarations only; no logic.
- **Constants** — `const` declarations. Module-private constants are `const` (unexported); public ones are `export const`.
- **Functions** — exported functions first, then internal helpers at the bottom.

Do **not** interleave constants and functions, or declare types mid-file.

## Git Guidelines

- **Commit Message Format:** Strictly adhere to the [Conventional Commits](https://www.conventionalcommits.org/) specification.
  - Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **Language:** All commit messages **MUST be written in English**.

## Changelog Guidelines

- **Language:** `CHANGELOG.md` **MUST be written entirely in English** — entries, descriptions, and all prose.
- **Format:** Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions (`Added`, `Changed`, `Fixed`, `Removed`, `Breaking Changes` subsections).
- **Versioning:** Each release maps to a git tag (e.g., `## [0.1.1] - YYYY-MM-DD`). The `[Unreleased]` section stays empty until the next release is cut.
