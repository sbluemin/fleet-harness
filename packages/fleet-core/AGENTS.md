# fleet-core Doctrine

`packages/fleet-core` is the Pi-agnostic Fleet product core. It owns Fleet domain logic, prompt assets, tool contracts, MCP/runtime internals, job services, SSOT streaming event contracts, and adapter-facing public APIs.

## Core Philosophy

`fleet-core` is **the** authoritative Fleet domain. Three principles direct every decision in this package:

1. **Pi-agnostic by construction** — no Pi runtime, no Pi UI, no Pi-AI imports. The package compiles and runs without `pi-fleet-extension`.
2. **Two execution patterns own two surfaces** — the streaming `admiral.session.*` + `admiral.events` module channel for long-lived ACP sessions (Pi `streamAcp`); the callback-pattern `admiral.executor.{executeWithPool, executeOneShot}` for closed-loop carrier turns. They share `internal/executor-engine.ts` pool/session-store wiring but never share their public surfaces.
3. **Single Source of Truth, single owner** — session persistence (`internal/session-runtime.ts`), MCP singleton (`_shared/mcp.ts`), TrackStatus enum (`_shared/carrier-job-events.ts`), CLI catalog (`@sbluemin/unified-agent` `CLI_BACKENDS`), and the fleet tool registry (`admiral.tools.list/invoke`) each have exactly one home. Reaching around them — copying state, re-defining types, shadowing stores — is treated as a regression.

## Current Architecture Status

- The **ownership model is already final**: Fleet domain logic belongs in `fleet-core`; Pi runtime integration belongs in `pi-fleet-extension`.
- The current implementation still lives under `packages/fleet-core/src/`.
- `packages/pi-fleet-extension` uses `src/` as the active Pi capability-bucket home.
- Do not document or assume that Pi capability buckets have moved out of `packages/pi-fleet-extension/src/`.

## The `admiral.agent` Domain

`admiral/agent/` is the **canonical agent domain** that consolidates all CLI backend orchestration. It exposes two complementary surfaces backed by shared internal infrastructure:

| Public module | Purpose | Pattern |
|---------------|---------|---------|
| `session.ts` | `ensure` / `sendMessage` / `deliverToolResults` / `resolveSession` | Streaming — events flow through `events.ts` module channel |
| `events.ts` | `register` / `unregister` / `emit` / `clear` for `AgentStreamEvent` | Module-level emit/register, `carrier-job-events.ts` doppelgänger |
| `tools.ts` | `list` / `invoke` / `registerExtraTools` / `unregisterExtraTools` | Default fleet tool specs auto-registered; host extras scoped by `scopeKey` |
| `executor.ts` | `executeWithPool` / `executeOneShot` (returns `CarrierExecResult`) | Callback pattern — closed-loop, carrier-tier consumers only |
| `lifecycle.ts` | `bindHostSession` / `shutdownAllSessions` | Pi `session_start`/`session_shutdown` integration point |
| `connections.ts` | `disconnect` / `disconnectAll` / `cleanIdle` / `getSessionIdFor` | Carrier-id-keyed pool operations |
| `models.ts` | `parseId` / `buildId` / `listProviders` / `getProviderIds` / `getThinkingLevels` | CLI/model codec |
| `service-status.ts` | `read` / `refresh` / `events` | Unified-agent service status delegation |
| `bridge.ts` | `buildLaunchCommand` (get-only) | Alt+T bridge launch data |

`admiral/agent/internal/` houses non-public engines that the surfaces above lean on: `state.ts` (session/launch/bridge maps), `session-runtime.ts` (the **single** persistence store + `ResumeFailureKind` classifier), `session-engine.ts` (ensure/sendMessage/deliverToolResults engine), `event-normalizer.ts` (unified-agent → `AgentStreamEvent`), `mcp-router.ts` (MCP token routing + FIFO + tool registration), `executor-engine.ts` (pool + drift detection for the callback path; module-level Maps replace legacy `globalThis`), and `post-connect.ts` (single `applyPostConnectConfig` shared by session-engine and executor-engine).

**Public consumer rule**: there is no `@sbluemin/fleet-core/admiral/agent` subpath. Consumers reach this domain through the `@sbluemin/fleet-core` root barrel re-exports only.

## Owns

- Fleet domain modules under `admiral/`:
  - `_shared/` — SSOT carrier job stream events (`carrier-job-events.ts`), CLI tool type aliases (`cli-tool-types.ts`), and the lazy-singleton MCP HTTP server (`mcp.ts`). The former `bridge/` directory has been removed; streaming consumers use `jobs.streaming.register()` instead.
  - `agent/` — the canonical agent domain documented above.
  - `carrier/`, `carrier-jobs/`, `squadron/`, `taskforce/` — fleet tool specs and execution doctrine.
  - `store/` — provider catalog and `fleet-store.ts` unified persistence.
  - `protocols/` — operational protocols with integrated `standing-orders/`.
- `admiralty/` (internalized Grand Fleet domain), `services/auth/`, `services/job/` (including `sanitize.ts` and `detached-job-lifecycle.ts`), unified settings/log/tool-registry services (now absorbing tool-snapshot), and `metaphor/`.
- Public API contracts and frozen consumer surfaces, including the canonical `public/runtime.ts` for agent runtime assembly. Note that `agent-services.ts` and `tool-registry-services.ts` have been removed from the public surface.
- `createFleetCoreRuntime` as the canonical composition entry point, exported from the package root, that initializes the runtime-owned state and domain services by exposing explicit public APIs in `public/`; it returns `FleetCoreRuntimeContext` containing `fleet`, `grandFleet`, `metaphor`, `jobs`, `log`, and `settings` services. The `fleet` service surface now also exposes runtime-owned auth access. It also owns the `shutdown` lifecycle that cleans up the agent, resets the settings service, and cleans up service status state.
- Agent execution is orchestrated through `admiral/agent/executor.ts` (`executeWithPool`, `executeOneShot`) backed by `admiral/agent/internal/executor-engine.ts`. Session lifecycle is owned by `admiral/agent/internal/session-engine.ts` with persistence in `admiral/agent/internal/session-runtime.ts`. Public connections/lifecycle surface is exposed via root barrel re-exports (`getSessionIdFor`, `disconnect`, `disconnectAll`, `cleanIdle`, `bindHostSession`, `shutdownAllSessions`). Unified-agent request orchestration remains an internal implementation detail and must not be reintroduced as a public `AgentRequestService`/`agentRequest` runtime field.

- Fleet tool specs and registry factories that are host-agnostic and registered by adapters through public APIs
- `[carrier:result]` system-reminder assembly via `services/job/job-reminders.ts`; the `job:finalized` SSOT event carries the pre-assembled string for host adapters to forward.
- Global runtime stores, **runtime-owned settings singletons (owned by `services/settings`)**, job lifecycle infrastructure, streaming event contracts, and compatibility keys used by Pi adapters
- Pure prompt composition, domain-level orchestration logic, and **render-agnostic view-model builders** (view-model builders have moved to the Pi host `panel/` domain)
- The Fleet Wiki domain extracted to the leaf `packages/fleet-wiki`

## Must Not Own

- `ExtensionAPI`, `ExtensionContext`, `pi.on(...)`, `pi.registerTool(...)`, `pi.registerCommand(...)`, `pi.registerShortcut(...)`, `pi.registerProvider(...)`, or `pi.sendMessage(...)`
- `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, or any Pi runtime wiring
- Direct `@mariozechner/pi-ai` usage
- TUI rendering that depends on Pi widgets, overlays, or editor components

## Import Boundaries

- Do not import `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`, or `@anthropic-ai/*`.
- Public consumers must use the package root barrel or documented public subpaths only.
- `fleet-core` may expose ports, adapters, and pure state machines, but Pi implementations live in `pi-fleet-extension`.
- If a module needs Pi lifecycle hooks or UI registration, that code belongs in `pi-fleet-extension`, not here.

## Migration Guardrails

- Do not reintroduce Fleet domain folders back into `packages/pi-fleet-extension/src/fleet/**`, `src/grand-fleet/**`, `src/metaphor/**`, or similar legacy Pi-side domain homes.
- Do not add new deep-import dependencies from `pi-fleet-extension` into `fleet-core/src/**`; use public exports.
- When splitting mixed modules, move the pure/domain half into `fleet-core` and keep only the Pi adapter half in `pi-fleet-extension`.
- Intermediate re-export shims are a migration artifact only; do not treat them as long-term architecture.

## Invariants

- `api/PUBLIC_API.md` is the frozen public API contract for the productization migration.
- Provider MCP FIFO, token isolation, pre-queue, and HTTP-hold behavior are invariants.
- `pi-fleet-extension` must not introduce or preserve `globalThis` usage patterns; compatibility state should flow through explicit public accessors or module-level singleton state. Legacy `globalThis.__pi_unified_agent_client_pool__` and `globalThis.__pi_unified_agent_launch_config__` have been removed.
- Background paths must accept plain runtime data and host ports, never Pi `ExtensionContext`.
- Job archive behavior remains read-many within TTL.
- Fleet Store (`admiral/store/fleet-store.ts`) writes are guarded by compare-then-write: `updateStates()` computes a pre-mutation snapshot via `structuredClone`, applies the mutator, and skips `writeStates()` when `JSON.stringify` comparison shows no delta. This prevents spurious disk I/O and reduces lock contention.
- Carrier registration is idempotent. `registerCarrier()` in the carrier framework preserves the existing `CarrierConfig` reference and mutates individual fields in place; it never replaces the config object wholesale. Re-registration with the same `id` updates metadata but does not create a new state entry.
- CLI type resolution is pull-based. The carrier framework does not maintain a pending-override queue. At registration time, `resolveCarrierCliType(carrierId, defaultCliType)` reads the current override directly from the fleet store. Callers do not push overrides into the framework; the framework pulls from the store each time.

## CLI Provider Constants

CLI provider constants are derived from `@sbluemin/unified-agent`'s `CLI_BACKENDS` SSoT:

- `CliType` (`keyof typeof CLI_BACKENDS`) is imported from `@sbluemin/unified-agent` — not a manual union.
- `CLI_PROVIDER_DISPLAY_NAMES` (auto-derived from `getProviderModels(cli).name`, i.e. `models.json` provider name, used as-is with no stripping) vs `CARRIER_DISPLAY_NAMES` (manual mapping for carrier personas: genesis, sentinel, vanguard).
- `CLI_DISPLAY_NAMES` merges both maps for backward compatibility.
- `CARRIER_COLORS`, `CARRIER_BG_COLORS`, `CARRIER_RGBS` iterate `CLI_BACKENDS` using `colorRgb` / `bgColorRgb`.
- `VALID_CLI_TYPES` and `CLI_TYPE_DISPLAY_ORDER` are computed from `Object.keys(CLI_BACKENDS)`.
- `TASKFORCE_CLI_TYPES` (in `admiral/taskforce/types.ts`) is `Object.keys(CLI_BACKENDS) as CliType[]` — `carrier_taskforce` accepts every registered CLI provider, not a manual `claude/codex/gemini` whitelist. `TaskForceCliType` is an alias of `CliType`.
- Task Force prompt copy (`TASKFORCE_CONFIGURE_HINT`, `[carrier:result]` backend label examples in `admiral/taskforce/prompts.ts`) is built from `TASKFORCE_CLI_TYPES × CLI_DISPLAY_NAMES`, so adding a `CLI_BACKENDS` entry automatically expands the whitelist and tool description without editing prompts.
- Model selection types (`ModelSelection`, `PerCliSettings`, `TaskForceSelection`) and runner `modelConfig` shapes carry only `model` / `effort` / `direct`. There is no `budgetTokens` field anywhere in the selection or runner contracts — providers without supported reasoning effort follow the Gemini pattern (`reasoningEffort.supported = false`) and surface no effort/budget controls.
