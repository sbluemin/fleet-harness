# Packages Doctrine

`packages/` is the Fleet first-party workspace monorepo root, containing `fleet-core` (Pi-agnostic domain core), `fleet-harness` (Pi host adapter), `fleet-wiki`, and `fleet-wiki-web`.

## Architecture Philosophy

The Fleet codebase is built on **four core principles**. Every contribution and review must align with these — they take precedence over micro-optimizations or local convenience.

### 1. Domain Boundary as Law

The split between `fleet-core` (Pi-agnostic Fleet domain) and `fleet-harness` (Pi host adapter) is **not a guideline; it is enforced by build/grep gates**:

- `fleet-core` MUST NOT import any `@sbluemin/fleet-*` engine package or `@anthropic-ai/*` package. The single Fleet-AI gateway lives in `fleet-harness/src/provider.ts`, which re-exports the `@sbluemin/fleet-ai` surface for the rest of the host.
- `fleet-harness` consumes `fleet-core` only through the **public root barrel** or documented public subpaths. Deep imports into `src/**` are forbidden.
- Pi UI, host event hooks (`pi.on/registerTool/registerProvider/...`), and any `ExtensionContext`/`ExtensionAPI` dependency belong exclusively to the Pi side.
- When splitting a mixed module, the pure/domain half moves into `fleet-core` and only the Pi adapter half stays in `fleet-harness`.

### 2. Two Execution Patterns, Strictly Separated

The Admiral agent domain exposes **two distinct execution patterns** that must never be merged:

| Pattern | Surface | Lifetime | Use Case |
|---------|---------|----------|----------|
| **Streaming** | `admiral.session.{ensure, sendMessage, deliverToolResults}` + `admiral.events` (module emit/register channel) | Long-lived ACP session, multiplexed per `sessionId` | Pi `streamAcp` host adapter; host `Map<sessionId, push>` routing |
| **Closed-loop callback** | `admiral.executor.{executeWithPool, executeOneShot}` with `ExecuteOptions.onMessageChunk/onThoughtChunk/onToolCall/...` (carrier-agnostic — caller maps `poolKey`: `carrier_dispatch` resolves `poolKey` from its `carrier_id` argument, `carrier_squadron` / `carrier_taskforce` use a synthetic id) | Single carrier turn, returns `ExecResult` synchronously | `carrier_dispatch` (unified per-carrier dispatcher with `carrier_id` enum) / `carrier_squadron` / `carrier_taskforce` tool execution |

**Why the separation matters**: streaming routes events through a global module channel keyed by `sessionId`, while executor callbacks are owner-specific and finite. Forcing one pattern through the other path causes either listener leaks (callback as event) or routing collisions (event as callback).

### 3. Single Source of Truth (SSoT)

Several invariants are guarded by a **single owner** — duplication or shadowing is treated as a regression:

| Concept | Owner | Rationale |
|---------|-------|-----------|
| Session persistence (`<piSessionId>.json` carrier→ACP map) | `admiral/agent/internal/session-runtime.ts` | Resume/restore semantics depend on a single in-memory cache backed by one file. |
| Track status enum | `admiral/_shared/carrier-job-events.ts:TrackStatus` | Six values cover both panel UI and executor lifecycle; legacy `AgentStatus`/`ColStatus` are removed. |
| MCP server URL + token routing | `admiral/_shared/mcp.ts` lazy singleton | One HTTP server, per-session Bearer tokens, FIFO routing isolated by token. |
| CLI provider catalog | `@sbluemin/fleet-unified-agent`'s `CLI_BACKENDS` | All `TASKFORCE_CLI_TYPES`, display names, colors, and reasoning capabilities derive from this. |
| Fleet tool catalog | `admiral.agent.tools.list()` (default specs auto-registered, host extras via `registerExtraTools`) | Host queries metadata + invokes — never re-implements specs. |
| Executor MCP whitelist | `admiral/agent/tools.ts:EXECUTOR_MCP_TOOL_IDS` + `getExecutorMcpTools()` | Whitelist-only connect-time MCP exposure for `executeWithPool` / `executeOneShot`; initial allowlist is `["carrier_jobs"]`. Adding a tool requires editing only this constant. |

> **Unified `AgentToolSpec` Shape**: One interface combines doctrine and execution — `{ id, tag, title, description, promptSnippet, whenToUse[], whenNotToUse[], usageGuidelines[], guardrails?[], parameters, execute }`. The same spec produces both the `<fleet section="tool-guide" tool="${tag}">` doctrine block (via `renderAgentToolDoctrineTag()`) and the executable handler. Legacy `ToolPromptManifest`, `AgentToolRenderDescriptor` / `AgentToolPiDescriptor` / `AgentToolMcpDescriptor`, and the deprecated `name` / `label` / `promptGuidelines` / `render` / `pi` / `mcp` fields are removed. The former `infra/tool-registry/` directory (6 files) no longer exists; the registry/formatter functions live in `admiral/agent/tools.ts` exclusively, exported as `registerAgentTool` / `getAllAgentTools` / `renderAgentToolDoctrineTag`.

### 4. Public Surface Discipline

Decision 28 (codified through the admiral.agent migration): the **only consumer-facing entry point** is the package root barrel of `@sbluemin/fleet-core`. There is no `./admiral/agent` subpath; consumers reach `executeWithPool`, `executeOneShot`, `bindHostSession`, `cleanIdle`, `disconnect`, `disconnectAll`, `getSessionIdFor`, and `shutdownAllSessions` exclusively through that barrel. Internal helpers under `admiral/agent/internal/` are never re-exported.

### Forbidden Patterns

- `globalThis.<anything>` for shared state — use module-level singletons instead. Legacy `__pi_unified_agent_client_pool__` and `__pi_unified_agent_launch_config__` keys are removed.
- Push-style "ports" passed into tool execution (`AgentToolPorts` is removed). Tools depend on `fleet-core` services directly.
- `on*` callback parameters threaded through `fleet-core` public APIs — events flow through `admiral.events` module-level register/emit only.
- Builder functions injected by hosts (e.g., legacy `setCliRuntimeContext`). Prompt assembly (`buildInitialPrompt`, `buildRuntimeContextPrompt`) is fleet-core's responsibility; host adapters pass raw `userRequest` + optional `history`.

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
| Directive refinement surfaces | `metaphor:directive` | Directive refinement settings — surfaced inside `fleet:metaphor:settings` (no standalone command) |
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
