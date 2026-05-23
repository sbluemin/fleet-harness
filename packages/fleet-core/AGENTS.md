# fleet-core Doctrine

`packages/fleet-core` is the host-agnostic Fleet compatibility core. It owns prompt assets, fleet-core tool facades, runtime composition, protocol/admiralty domains, frozen public API compatibility, and adapter-facing lifecycle APIs. Carrier runtime implementation now lives in `packages/fleet-carriers`.

## Core Philosophy

`fleet-core` is **the** authoritative Fleet domain. Three principles direct every decision in this package:

1. **Host-agnostic by construction** — no Fleet host runtime, no Fleet host UI, no Fleet-AI imports. The package compiles and runs without `fleet-agent`.
2. **Executor surface only** — `admiral.agent.executor.{executeWithPool, executeOneShot}` is the retained agent entrypoint pair for closed-loop carrier turns. Runtime pool operations stay under `admiral.agent.connections`.
3. **Single Source of Truth, single owner** — executor runtime/session/model infrastructure, TrackStatus, and the builtin external MCP catalog live in `packages/fleet-infra/src/agent/`; generic MCP server/registry lives in `packages/fleet-mcp-server`; CLI catalog lives in `@sbluemin/fleet-unified-agent` `CLI_BACKENDS`; fleet-core tool facade/default builders stay in fleet-core. Reaching around them — copying state, re-defining types, shadowing stores — is treated as a regression.

## Current Architecture Status

- The **ownership model is already final**: Fleet domain logic belongs in `fleet-core`; host runtime integration belongs in `fleet-agent`.
- Carrier runtime, jobs, store, stream events, and carrier runtime constants are implemented in `packages/fleet-carriers/src/` and consumed through fleet-core compatibility facades.
- `packages/fleet-agent` is the active host capability-bucket home.

## The `admiral.agent` Domain

`admiral/agent/` is the **fleet-core compatibility facade** for the carrier executor surface:

| Public module | Purpose | Pattern |
|---------------|---------|---------|
| `tools.ts` / `bootstrap.ts` | `list` / `invoke` / `registerExtraTools` / `unregisterExtraTools` / `registerAgentTool` / `getAllAgentTools` / `renderAgentToolDoctrineTag` / `getExecutorMcpTools` / `registerFleetCoreDefaultAgentTools` | fleet-core facade over the `packages/fleet-mcp-server` registry. |
| `executor` re-export | `executeWithPool` / `executeOneShot` (`ExecuteOptions` → `ExecResult`, carrier-agnostic) | Re-export from `@sbluemin/fleet-infra/agent`; callback pattern — closed-loop, caller maps `poolKey`. |
| `connections` re-export | `disconnect` / `disconnectAll` / `cleanIdle` / `getSessionIdFor` | Re-export from `@sbluemin/fleet-infra/agent`; `poolKey`-keyed pool operations. |
| `models` re-export | `parseId` / `buildId` / `listProviders` / `getProviderIds` / `getCliModels` / `getCliEffortLevels` / `getSelectableThinkingLevels` | Re-export from `@sbluemin/fleet-infra/agent`; CLI/model codec and selectable UI thinking-level policy. |

## The `admiral.mcp` Domain

`admiral/mcp/` is the domain for Fleet's Model Context Protocol orchestration. It manages the lifecycle of the internal MCP server and provides session-based access control.

| Public module | Purpose | Pattern |
|---------------|---------|---------|
| `index.ts` | `getEndpoint` / `issueDedicatedSessionToken` | Facade for the MCP server lifecycle and token issuance. |

- `getEndpoint(): Promise<{ url: string }>`: Returns the active MCP server URL, starting it if necessary.
- `issueDedicatedSessionToken({ label, cwd }): string`: Generates a dedicated session token with a specific label and working directory.

Executor internals live in `packages/fleet-infra/src/agent/internal/`: `session-runtime.ts` (JSONL custom-entry backed carrier session mapping persistence), `executor-engine.ts` (pool + drift detection for the callback path), and `post-connect.ts`. `bootFleetCore()` registers the two-method infra `ExecutorPort` with resolved carrier external MCP IDs and executor MCP tools, then connects shutdown to infra `disconnectAll()`.

**Public consumer rule**: there is no `@sbluemin/fleet-core/admiral/agent` subpath. Consumers reach this domain through the `@sbluemin/fleet-core` root barrel re-exports only.

### Facade-First Export Rule
All new fleet-core domain features MUST be exposed through their respective domain facade (`admiral`, `admiralty`) and consumed via the facade namespace (e.g., `admiral.protocols.xxx`). Direct named exports to the root barrel for new domain functionality are prohibited.

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
  - `agent/` — retained bootstrap/tool facade and root-barrel compatibility re-exports for the infra executor surface.
  - `protocols/` — operational protocols with integrated `standing-orders/`.
- Carrier runtime symbols (`carrier`, `carrierJobs`, `store`, `taskforce`) are re-exported from `@sbluemin/fleet-carriers` through the `admiral` facade root; implementation ownership is not in fleet-core.
- `admiralty/` (internalized Grand Fleet domain).
- Public API contracts and frozen consumer surfaces, including lifecycle-only `public/runtime.ts` boot/shutdown.
- `bootFleetCore` as the canonical lifecycle boot entry point, exported from the package root; domain operations are consumed through root-barrel facades.
- Agent execution is exposed through `admiral.agent.executor` (`executeWithPool`, `executeOneShot`) and backed by `@sbluemin/fleet-infra/agent`. Pool lifecycle is exposed through `admiral.agent.connections`.

- Fleet tool spec builders, explicit default registration bootstrap, prompt usage, and registry facade functions that are host-agnostic and backed by `packages/fleet-mcp-server`
- Streaming event contracts and compatibility keys used by host adapters.
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
- `@sbluemin/fleet-carriers` is the allowed carrier runtime dependency for compatibility facades.
- `@sbluemin/fleet-mcp-server` is the allowed Fleet workspace dependency for generic MCP registry/server primitives.
- `@sbluemin/fleet-infra` is the allowed Fleet workspace dependency for host-agnostic auth, data-dir, job, log, and settings infrastructure.
- Public consumers must use the package root barrel or documented public subpaths only.
- Builtin external MCP catalog is owned by `@sbluemin/fleet-infra/agent` and is not exposed through the `@sbluemin/fleet-core` root barrel.
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
- `fleet-carriers` and `fleet-agent` must not introduce or preserve `globalThis` usage patterns; shared carrier state uses the `CarrierRegistry` module-level singleton.
- Background paths must accept plain runtime data and host ports, never host-specific context.
- Job archive behavior remains read-many within TTL.
- `carrier_dispatch` is the only public carrier delegation entrypoint; Task Force runs are an internal execution mode selected automatically from carrier configuration.
- `carrier_jobs` full responses are schema-stable by job kind: Task Force job IDs return backend-keyed `results` without `full_result`, while non-Task-Force job IDs preserve the existing `full_result` contract exactly.
- **UTF-8 safe job archives**: Job archive serialization guarantees valid UTF-8 output during truncation.
- **Prefix-based policy enforcement**: Sub-operation byte caps and formatting are consistently applied via `jobId` prefix detection.
- Fleet Store writes are implemented in `@sbluemin/fleet-carriers` and guarded by compare-then-write.
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
- `TASKFORCE_CLI_TYPES` (re-exported from `@sbluemin/fleet-carriers`) is `Object.keys(CLI_BACKENDS) as CliType[]`.
- Task Force configuration hint is built from `TASKFORCE_CLI_TYPES × CLI_DISPLAY_NAMES`.
- Model selection types carry only `model` / `effort` / `direct`. There is no `budgetTokens` field.
