# fleet-core Doctrine

`packages/fleet-core` is the host-agnostic Fleet product core. It owns Fleet domain logic, prompt assets, fleet-core tool builders/facades, runtime composition, job services, SSOT streaming event contracts, and adapter-facing public APIs.

## Core Philosophy

`fleet-core` is **the** authoritative Fleet domain. Three principles direct every decision in this package:

1. **Host-agnostic by construction** — no Fleet host runtime, no Fleet host UI, no Fleet-AI imports. The package compiles and runs without `fleet-agent`.
2. **Executor surface only** — `admiral.agent.executor.{executeWithPool, executeOneShot}` is the retained agent entrypoint pair for closed-loop carrier turns. Runtime pool operations stay under `admiral.agent.connections`.
3. **Single Source of Truth, single owner** — session persistence (`internal/session-runtime.ts`), generic MCP server/registry (`packages/fleet-mcp-server`), TrackStatus enum (`_shared/carrier-job-events.ts`), CLI catalog (`@sbluemin/fleet-unified-agent` `CLI_BACKENDS`), builtin external MCP catalog (`admiral/external-mcp.ts`), and the fleet-core tool facade/default builders each have exactly one home. Reaching around them — copying state, re-defining types, shadowing stores — is treated as a regression.

## Current Architecture Status

- The **ownership model is already final**: Fleet domain logic belongs in `fleet-core`; host runtime integration belongs in `fleet-agent`.
- The current implementation lives under `packages/fleet-core/src/`.
- `packages/fleet-agent` is the active host capability-bucket home.

## The `admiral.agent` Domain

`admiral/agent/` is the **canonical carrier executor domain** that consolidates CLI backend orchestration for closed-loop carrier turns:

| Public module | Purpose | Pattern |
|---------------|---------|---------|
| `tools.ts` / `bootstrap.ts` | `list` / `invoke` / `registerExtraTools` / `unregisterExtraTools` / `registerAgentTool` / `getAllAgentTools` / `renderAgentToolDoctrineTag` / `getExecutorMcpTools` / `registerFleetCoreDefaultAgentTools` | fleet-core facade over the `packages/fleet-mcp-server` registry. |
| `executor.ts` | `executeWithPool` / `executeOneShot` (`ExecuteOptions` → `ExecResult`, carrier-agnostic) | Callback pattern — closed-loop, caller maps `poolKey`. **Connect-time MCP**: every executor session receives a whitelist-scoped MCP server resolved by `getExecutorMcpTools(carrierId)`. |
| `connections.ts` | `disconnect` / `disconnectAll` / `cleanIdle` / `getSessionIdFor` | `poolKey`-keyed pool operations |
| `models.ts` | `parseId` / `buildId` / `listProviders` / `getProviderIds` / `getCliModels` / `getCliEffortLevels` / `getSelectableThinkingLevels` | CLI/model codec and selectable UI thinking-level policy |

## The `admiral.mcp` Domain

`admiral/mcp/` is the domain for Fleet's Model Context Protocol orchestration. It manages the lifecycle of the internal MCP server and provides session-based access control.

| Public module | Purpose | Pattern |
|---------------|---------|---------|
| `index.ts` | `getEndpoint` / `issueDedicatedSessionToken` | Facade for the MCP server lifecycle and token issuance. |

- `getEndpoint(): Promise<{ url: string }>`: Returns the active MCP server URL, starting it if necessary.
- `issueDedicatedSessionToken({ label, cwd }): string`: Generates a dedicated session token with a specific label and working directory.

`admiral/agent/internal/` houses non-public engines that the surfaces above lean on: `session-runtime.ts` (JSONL custom-entry backed carrier session mapping persistence), `executor-engine.ts` (pool + drift detection for the callback path), and `post-connect.ts`.

**Public consumer rule**: there is no `@sbluemin/fleet-core/admiral/agent` subpath. Consumers reach this domain through the `@sbluemin/fleet-core` root barrel re-exports only.

### Facade-First Export Rule
All new domain features MUST be exposed through their respective domain facade (`admiral`, `admiralty`, `infra`) and consumed via the facade namespace (e.g., `admiral.protocols.xxx`). Direct named exports to the root barrel for new domain functionality are prohibited.

### Unified `AgentToolSpec` shape

The agent tool registry uses a single doctrine + execution interface.

```ts
interface AgentToolSpec {
  readonly id: string;            // dispatch id (a-z, 0-9, _) — also the MCP tool name
  readonly tag: string;           // `<fleet section="tool-guide" tool="${tag}">` block id
  readonly title: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly whenToUse: readonly string[];
  readonly whenNotToUse: readonly string[];
  readonly usageGuidelines: readonly string[];
  readonly guardrails?: readonly string[];
  readonly parameters: Record<string, unknown>; // JSON Schema
  execute(args: unknown, ctx: AgentToolCtx): Promise<unknown>;
}
```

Single SSoT for the generic type and registry lives in `packages/fleet-mcp-server`; `admiral/agent/tools.ts` exposes the fleet-core facade plus carrier metadata adapter.

## Owns

- Fleet domain modules under `admiral/`:
  - `_shared/` — SSOT carrier job stream events (`carrier-job-events.ts`) and CLI tool type aliases (`cli-tool-types.ts`).
  - `agent/` — the canonical agent domain documented above.
  - Builtin external MCP catalog (`external-mcp.ts`) — internal helper resolving carrier-specific external servers.
- `carrier/`, `carrier-jobs/`, `taskforce/` — carrier framework, fleet tool specs, roster rendering, and execution doctrine.
  - `store/` — provider catalog and `fleet-store.ts` unified persistence.
  - `protocols/` — operational protocols with integrated `standing-orders/`.
- `admiralty/` (internalized Grand Fleet domain), `infra/auth/`, `infra/job` (including `sanitize.ts` and `detached-job-lifecycle.ts`), and unified settings/log infra.
- Public API contracts and frozen consumer surfaces, including lifecycle-only `public/runtime.ts` boot/shutdown.
- `bootFleetCore` as the canonical lifecycle boot entry point, exported from the package root; domain operations are consumed through root-barrel facades.
- Agent execution is orchestrated through `admiral.agent.executor` (`executeWithPool`, `executeOneShot`) backed by `admiral/agent/internal/executor-engine.ts`. Pool lifecycle is owned by `admiral.agent.connections`.

- Fleet tool spec builders, explicit default registration bootstrap, prompt usage, and registry facade functions that are host-agnostic and backed by `packages/fleet-mcp-server`
- `[carrier:result]` system-reminder assembly via `infra/job/job-reminders.ts`.
- Global runtime stores, **runtime-owned settings singletons (owned by `infra/settings`)**, job lifecycle infrastructure, streaming event contracts, and compatibility keys used by host adapters
- Pure prompt composition, domain-level orchestration logic, and **render-agnostic view-model builders**.
- The Fleet Wiki domain extracted to the leaf `packages/fleet-wiki`
- Default carrier persona metadata extracted to the leaf `packages/fleet-carriers`

## Must Not Own

- Host-specific registration hooks (`pi.on`, `registerTool`, etc.) or host lifecycle dependencies.
- `@sbluemin/fleet-unified-agent`, `@sbluemin/fleet-tui`, or any Fleet host runtime wiring
- Direct agent provider usage
- TUI rendering that depends on host widgets, overlays, or editor components

## Import Boundaries

- Do not import `@sbluemin/fleet-*` engine packages.
- `@sbluemin/fleet-mcp-server` is the sole allowed Fleet workspace dependency for generic MCP registry/server primitives.
- Public consumers must use the package root barrel or documented public subpaths only.
- Builtin external MCP catalog (`admiral/external-mcp.ts`) is an internal helper and MUST NOT be exposed via public root barrel.
- `fleet-core` may expose ports, adapters, and pure state machines, but host implementations live in `fleet-agent`.
- If a module needs host lifecycle hooks or UI registration, that code belongs in `fleet-agent`, not here.

## Migration Guardrails

- Do not reintroduce Fleet domain folders back into legacy host-side homes.
- Do not reintroduce removed prompt-helper domains into `fleet-core`.
- Do not add new deep-import dependencies from `fleet-agent` into `fleet-core/src/**`; use public exports.
- When splitting mixed modules, move the pure/domain half into `fleet-core` and keep only the host adapter half in `fleet-agent`.

## Invariants

- `api/PUBLIC_API.md` is the frozen public API contract for the productization migration.
- Provider MCP FIFO, token isolation, pre-queue, and HTTP-hold behavior are invariants.
- `fleet-agent` must not introduce or preserve `globalThis` usage patterns.
- Background paths must accept plain runtime data and host ports, never host-specific context.
- Job archive behavior remains read-many within TTL.
- **UTF-8 safe job archives**: Job archive serialization guarantees valid UTF-8 output during truncation.
- **Prefix-based policy enforcement**: Sub-operation byte caps and formatting are consistently applied via `jobId` prefix detection.
- Fleet Store (`admiral/store/fleet-store.ts`) writes are guarded by compare-then-write.
- **State Consistency via `_generation` Token**: Every state update increments a monotonic `_generation` counter.
- **Self-Healing State Resolution**: The store implements a healing-aware `loadModels()`.
- **Pull-Based CLI Type Resolution**: The carrier framework pulls the current override directly from the fleet store snapshot via a resolver.
- Carrier registration is idempotent.
- Carrier registration does not mutate executor MCP authorization state.
- CLI type resolution is pull-based.
- **Builtin External MCP Invariants**:
  - **HTTP/HTTPS MCP Transport only**: Builtin external MCP catalog must only define HTTP/HTTPS servers.
  - **strictMcp:true preservation**: Every executor connect options holds strict MCP tool resolution.
  - **fleet-tools Bearer Isolation**: fleet-tools authentication Bearer tokens must never leak to external MCP servers.
  - **No local workspace JSON configurations**: Local `.fleet/external-mcp.json` is not supported; external MCP server registration is statically owned by code catalog.

## CLI Provider Constants

CLI provider constants are derived from `@sbluemin/fleet-unified-agent`'s `CLI_BACKENDS` SSoT:
- `CliType` is imported from `@sbluemin/fleet-unified-agent`.
- `CLI_PROVIDER_DISPLAY_NAMES` (auto-derived from `getProviderModels(cli).name`) vs `CARRIER_DISPLAY_NAMES` (manual mapping for carrier personas).
- `CLI_DISPLAY_NAMES` merges both maps for backward compatibility.
- `CARRIER_COLORS`, `CARRIER_BG_COLORS`, `CARRIER_RGBS` iterate `CLI_BACKENDS`.
- `VALID_CLI_TYPES` and `CLI_TYPE_DISPLAY_ORDER` are computed from `Object.keys(CLI_BACKENDS)`.
- `TASKFORCE_CLI_TYPES` (in `admiral/taskforce/types.ts`) is `Object.keys(CLI_BACKENDS) as CliType[]`.
- Task Force configuration hint is built from `TASKFORCE_CLI_TYPES × CLI_DISPLAY_NAMES`.
- Model selection types carry only `model` / `effort` / `direct`. There is no `budgetTokens` field.
