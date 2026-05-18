# fleet-core Doctrine

`packages/fleet-core` is the Pi-agnostic Fleet product core. It owns Fleet domain logic, prompt assets, fleet-core tool builders/facades, runtime composition, job services, SSOT streaming event contracts, and adapter-facing public APIs.

## Core Philosophy

`fleet-core` is **the** authoritative Fleet domain. Three principles direct every decision in this package:

1. **Host-agnostic by construction** — no Fleet host runtime, no Fleet host UI, no Fleet-AI imports. The package compiles and runs without `fleet-harness`.
2. **Two execution patterns own two surfaces** — the streaming `admiral.session.*` + `admiral.events` module channel for long-lived ACP sessions (Pi `streamAcp`); the callback-pattern `admiral.executor.{executeWithPool, executeOneShot}` for closed-loop carrier turns. They share `internal/executor-engine.ts` pool/session-store wiring but never share their public surfaces.
3. **Single Source of Truth, single owner** — session persistence (`internal/session-runtime.ts`), generic MCP server/registry (`packages/fleet-mcp-server`), TrackStatus enum (`_shared/carrier-job-events.ts`), CLI catalog (`@sbluemin/fleet-unified-agent` `CLI_BACKENDS`), and the fleet-core tool facade/default builders (`admiral.agent.tools` + `admiral.agent.bootstrap`) each have exactly one home. Reaching around them — copying state, re-defining types, shadowing stores — is treated as a regression.

## Current Architecture Status

- The **ownership model is already final**: Fleet domain logic belongs in `fleet-core`; Pi runtime integration belongs in `fleet-harness`.
- The current implementation still lives under `packages/fleet-core/src/`.
- `packages/fleet-harness` uses `src/` as the active Pi capability-bucket home.
- Do not document or assume that Pi capability buckets have moved out of `packages/fleet-harness/src/`.

## The `admiral.agent` Domain

`admiral/agent/` is the **canonical agent domain** that consolidates all CLI backend orchestration. It exposes two complementary surfaces backed by shared internal infrastructure:

| Public module | Purpose | Pattern |
|---------------|---------|---------|
| `session.ts` | `ensure` / `sendMessage` / `deliverToolResults` / `resolveSession` | Streaming — events flow through `events.ts` module channel |
| `events.ts` | `register` / `unregister` / `emit` / `clear` for `AgentStreamEvent` | Module-level emit/register, `carrier-job-events.ts` doppelgänger |
| `tools.ts` / `bootstrap.ts` | `list` / `invoke` / `registerExtraTools` / `unregisterExtraTools` / `registerAgentTool` / `getAllAgentTools` / `renderAgentToolDoctrineTag` / `getExecutorMcpTools` / `registerFleetCoreDefaultAgentTools` | fleet-core facade over the `packages/fleet-mcp-server` registry. Default fleet tool specs are explicitly bootstrapped by use sites, not module-load registered; host extras stay scoped by `scopeKey`. Executor MCP exposure is resolved lazily at connect time from the possibly-empty global scope, tool-centric `registerExecutorTool(..., { allowedCarriers })`, and carrier-centric `CarrierMetadata.allowedExecutorTools`; missing metadata IDs are ignored until a spec is registered. No tools are inherited by default; even `carrier_jobs` must be explicitly listed in a persona's metadata. |
| `executor.ts` | `executeWithPool` / `executeOneShot` (`ExecuteOptions` → `ExecResult`, carrier-agnostic) | Callback pattern — closed-loop, caller maps `poolKey` (`carrier_dispatch` resolves `poolKey` from its `carrier_id` argument; `carrier_squadron` / `carrier_taskforce` use a synthetic id). **Connect-time MCP**: every executor session receives a whitelist-scoped MCP server resolved by `getExecutorMcpTools(carrierId)`; default personas must explicitly list `carrier_jobs` (and any other required tools) for access. No runtime-context tags are injected into executor requests. |
| `lifecycle.ts` | `bindHostSession` / `shutdownAllSessions` | Pi `session_start`/`session_shutdown` integration point |
| `connections.ts` | `disconnect` / `disconnectAll` / `cleanIdle` / `getSessionIdFor` | `poolKey`-keyed pool operations (`carrier_dispatch` passes the resolved `carrierId`; squadron/taskforce pass synthetic ids) |
| `models.ts` | `parseId` / `buildId` / `listProviders` / `getProviderIds` / `getCliModels` / `getCliEffortLevels` / `getSelectableThinkingLevels` | CLI/model codec and selectable UI thinking-level policy |
| `service-status.ts` | `read` / `refresh` / `events` | Unified-agent service status delegation |
| `bridge.ts` | `buildLaunchCommand` (get-only) | Alt+T bridge launch data |

`admiral/agent/internal/` houses non-public engines that the surfaces above lean on: `state.ts` (session/launch/bridge maps), `session-runtime.ts` (JSONL custom-entry backed session mapping persistence with `HostSessionStore`/`CarrierSessionStore` split, `ResumeFailureKind` classifier, and legacy sidecar cleanup), `session-engine.ts` (ensure/sendMessage/deliverToolResults engine with FIFO fatal error handling for tool-call queues), `event-normalizer.ts` (unified-agent → `AgentStreamEvent`), `executor-engine.ts` (pool + drift detection for the callback path; module-level Maps replace legacy `globalThis`), and `post-connect.ts` (single `applyPostConnectConfig` shared by session-engine and executor-engine). Generic MCP router and tool snapshot logic live in `packages/fleet-mcp-server`.

**Public consumer rule**: there is no `@sbluemin/fleet-core/admiral/agent` subpath. Consumers reach this domain through the `@sbluemin/fleet-core` root barrel re-exports only.

### Facade-First Export Rule
All new domain features MUST be exposed through their respective domain facade (`admiral`, `admiralty`, `metaphor`, `infra`) and consumed via the facade namespace (e.g., `admiral.protocols.xxx`). Direct named exports to the root barrel for new domain functionality are prohibited. The root barrel may only re-export the facade objects and frozen legacy symbols.

### Unified `AgentToolSpec` shape

The agent tool registry uses a single doctrine + execution interface. There is no longer a separate `ToolPromptManifest` / `AgentToolMcpDescriptor` / `AgentToolPiDescriptor` / `AgentToolRenderDescriptor` split:

```ts
interface AgentToolSpec {
  readonly id: string;            // dispatch id (a-z, 0-9, _) — also the MCP tool name
  readonly tag: string;           // `<fleet section="tool-guide" tool="${tag}">` block id
  readonly title: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly whenToUse: readonly string[];     // binding — no emphasis markers
  readonly whenNotToUse: readonly string[];  // binding — no emphasis markers
  readonly usageGuidelines: readonly string[];
  readonly guardrails?: readonly string[];
  readonly parameters: Record<string, unknown>; // JSON Schema
  execute(args: unknown, ctx: AgentToolCtx): Promise<unknown>;
}
```

Single SSoT for the generic type and registry lives in `packages/fleet-mcp-server`; `admiral/agent/types.ts` re-exports `AgentToolCtx` + `AgentToolSpec`, and `admiral/agent/tools.ts` exposes the fleet-core facade plus carrier metadata adapter. The deprecated `name` / `label` / `promptGuidelines` / `render` / `pi` / `mcp` fields and the entire `infra/tool-registry/` directory (six files: `derive.ts`, `formatter.ts`, `registry.ts`, `tool-snapshot.ts`, `types.ts`, `index.ts`) are removed.

## Owns

- Fleet domain modules under `admiral/`:
  - `_shared/` — SSOT carrier job stream events (`carrier-job-events.ts`) and CLI tool type aliases (`cli-tool-types.ts`). Generic MCP HTTP server internals are owned by `packages/fleet-mcp-server`. The former `bridge/` directory has been removed; streaming consumers use `jobs.streaming.register()` instead.
  - `agent/` — the canonical agent domain documented above.
- `carrier/`, `carrier-jobs/`, `squadron/`, `taskforce/` — carrier framework, fleet tool specs, roster rendering, and execution doctrine. Default carrier persona data is owned by `packages/fleet-carriers`.
  - `store/` — provider catalog and `fleet-store.ts` unified persistence.
  - `protocols/` — operational protocols with integrated `standing-orders/`.
- `admiralty/` (internalized Grand Fleet domain), `infra/auth/`, `infra/job` (including `sanitize.ts` and `detached-job-lifecycle.ts`), unified settings/log infra, and `metaphor/`. The former `infra/tool-registry/` directory has been removed; generic tool registry, doctrine formatter, and tool snapshot now live in `packages/fleet-mcp-server`, with `admiral/agent/tools.ts` retaining the fleet-core facade and carrier metadata adapter.
- Public API contracts and frozen consumer surfaces, including the canonical `public/runtime.ts` for agent runtime assembly. Note that `agent-services.ts` and `tool-registry-services.ts` have been removed from the public surface.
- `createFleetCoreRuntime` as the canonical composition entry point, exported from the package root, that initializes runtime-owned state and returns `FleetCoreRuntimeContext` containing exactly `admiral`, `admiralty`, `metaphor`, `infra`, and `shutdown`.
- Agent execution is orchestrated through `admiral.agent.executor` (`executeWithPool`, `executeOneShot`) backed by `admiral/agent/internal/executor-engine.ts`. Session lifecycle is owned by `admiral.agent.session` and `admiral.agent.lifecycle`; internal session mapping persistence lives in `admiral/agent/internal/session-runtime.ts` as JSONL custom entries.

- Fleet tool spec builders, explicit default registration bootstrap, prompt usage, and registry facade functions that are host-agnostic and backed by `packages/fleet-mcp-server`
- `[carrier:result]` system-reminder assembly via `infra/job/job-reminders.ts`; the `job:finalized` SSOT event carries the pre-assembled string for host adapters to forward.
- Global runtime stores, **runtime-owned settings singletons (owned by `infra/settings`)**, job lifecycle infrastructure, streaming event contracts, and compatibility keys used by Pi adapters
- Pure prompt composition, domain-level orchestration logic, and **render-agnostic view-model builders** (view-model builders have moved to the Pi host `panel/` domain)
- The Fleet Wiki domain extracted to the leaf `packages/fleet-wiki`
- Default carrier persona metadata, default persona catalog registration helpers, and persona-only prompt constants extracted to the leaf `packages/fleet-carriers`

## Must Not Own

- `ExtensionAPI`, `ExtensionContext`, `pi.on(...)`, `pi.registerTool(...)`, `pi.registerCommand(...)`, `pi.registerShortcut(...)`, `pi.registerProvider(...)`, or `pi.sendMessage(...)`
- `@sbluemin/fleet-coding-agent`, `@sbluemin/fleet-tui`, or any Fleet host runtime wiring
- Direct `@sbluemin/fleet-ai` usage
- TUI rendering that depends on Fleet host widgets, overlays, or editor components

## Import Boundaries

- Do not import `@sbluemin/fleet-*` or `@anthropic-ai/*`.
- `@sbluemin/fleet-mcp-server` is the sole allowed Fleet workspace dependency for generic MCP registry/server primitives; it must never import back into `fleet-core`.
- Public consumers must use the package root barrel or documented public subpaths only.
- `fleet-core` may expose ports, adapters, and pure state machines, but Pi implementations live in `fleet-harness`.
- If a module needs Pi lifecycle hooks or UI registration, that code belongs in `fleet-harness`, not here.

## Migration Guardrails

- Do not reintroduce Fleet domain folders back into `packages/fleet-harness/src/fleet/**`, `src/grand-fleet/**`, `src/metaphor/**`, or similar legacy Pi-side domain homes.
- Do not add new deep-import dependencies from `fleet-harness` into `fleet-core/src/**`; use public exports.
- When splitting mixed modules, move the pure/domain half into `fleet-core` and keep only the Pi adapter half in `fleet-harness`.
- Intermediate re-export shims are a migration artifact only; do not treat them as long-term architecture.

## Invariants

- `api/PUBLIC_API.md` is the frozen public API contract for the productization migration.
- Provider MCP FIFO, token isolation, pre-queue, and HTTP-hold behavior are invariants.
- `fleet-harness` must not introduce or preserve `globalThis` usage patterns; compatibility state should flow through explicit public accessors or module-level singleton state. Legacy `globalThis.__pi_unified_agent_client_pool__` and `globalThis.__pi_unified_agent_launch_config__` have been removed.
- Background paths must accept plain runtime data and host ports, never Pi `ExtensionContext`.
- Job archive behavior remains read-many within TTL.
- **UTF-8 safe job archives**: Job archive serialization guarantees valid UTF-8 output during truncation by preventing cuts at multibyte character boundaries (e.g., CJK, emojis).
- **Prefix-based policy enforcement**: Sub-operation byte caps and formatting are consistently applied via `jobId` prefix detection (`squadron:` / `taskforce:`), ensuring architectural intent is preserved even when ephemeral job metadata is evicted from memory.
- Fleet Store (`admiral/store/fleet-store.ts`) writes are guarded by compare-then-write: `updateStates()` computes a pre-mutation snapshot via `structuredClone`, applies the mutator, and skips `writeStates()` when `JSON.stringify` comparison shows no delta. This prevents spurious disk I/O and reduces lock contention.
- **State Consistency via `_generation` Token**: Every state update increments a monotonic `_generation` counter. Concurrent instances use this token to detect stale snapshots and prevent lost updates. `readStatesSnapshot()` provides a point-in-time view with the current generation, which is preserved across atomic update cycles.
- **Self-Healing State Resolution**: The store implements a healing-aware `loadModels()` that reconciles carrier model selections against the current CLI backend catalog. When a missing or mismatched `cliType` is detected during a read or write operation, the store automatically heals the state before proceeding.
- **Pull-Based CLI Type Resolution**: The carrier framework (`admiral/carrier/`) does not maintain an in-memory `cliType` cache or a pending-override queue. It pulls the current override directly from the fleet store snapshot via a resolver. This ensures that every tool dispatch and status check uses the authoritative state synchronized across all Fleet instances.
- Carrier registration is idempotent. `registerCarrier()` in the carrier framework preserves the existing `CarrierConfig` reference and mutates individual fields in place; it never replaces the config object wholesale. Re-registration with the same `id` updates metadata but does not create a new state entry.
- Carrier registration does not mutate executor MCP authorization state. Carrier-centric executor tool access is declared as opaque strings in `CarrierMetadata.allowedExecutorTools` and resolved lazily by `getExecutorMcpTools(carrierId)` alongside the possibly-empty default executor scope and tool-centric whitelist entries. No tools (including `carrier_jobs`) are inherited by default; default personas must explicitly list `carrier_jobs` for prior-job self-fetch access.
- CLI type resolution is pull-based. The carrier framework does not maintain a pending-override queue. At registration time, `resolveCarrierCliType(carrierId, defaultCliType)` reads the current override directly from the fleet store. Callers do not push overrides into the framework; the framework pulls from the store each time.

## CLI Provider Constants

CLI provider constants are derived from `@sbluemin/fleet-unified-agent`'s `CLI_BACKENDS` SSoT:

- `CliType` (`keyof typeof CLI_BACKENDS`) is imported from `@sbluemin/fleet-unified-agent` — not a manual union.
- `CLI_PROVIDER_DISPLAY_NAMES` (auto-derived from `getProviderModels(cli).name`, i.e. `models.json` provider name, used as-is with no stripping) vs `CARRIER_DISPLAY_NAMES` (manual mapping for carrier personas: genesis, sentinel, vanguard).
- `CLI_DISPLAY_NAMES` merges both maps for backward compatibility.
- `CARRIER_COLORS`, `CARRIER_BG_COLORS`, `CARRIER_RGBS` iterate `CLI_BACKENDS` using `colorRgb` / `bgColorRgb`.
- `VALID_CLI_TYPES` and `CLI_TYPE_DISPLAY_ORDER` are computed from `Object.keys(CLI_BACKENDS)`.
- `TASKFORCE_CLI_TYPES` (in `admiral/taskforce/types.ts`) is `Object.keys(CLI_BACKENDS) as CliType[]` — `carrier_taskforce` accepts every registered CLI provider, not a manual `claude/codex/gemini` whitelist. `TaskForceCliType` is an alias of `CliType`.
- Task Force configuration hint (`TASKFORCE_CONFIGURE_HINT` in `admiral/taskforce/prompts.ts`) is built from `TASKFORCE_CLI_TYPES × CLI_DISPLAY_NAMES`, so adding a `CLI_BACKENDS` entry automatically expands the whitelist without editing prompts.
- Model selection types (`ModelSelection`, `PerCliSettings`, `TaskForceSelection`) and runner `modelConfig` shapes carry only `model` / `effort` / `direct`. There is no `budgetTokens` field anywhere in the selection or runner contracts — providers without supported reasoning effort follow the Gemini pattern (`effort.supported = false`) and surface no effort/budget controls.
