# fleet-core Doctrine

`packages/fleet-core` is the Pi-agnostic Fleet product core. It owns Fleet domain logic, prompt assets, tool contracts, MCP/runtime internals, job services, SSOT streaming event contracts, and adapter-facing public APIs.

## Current Architecture Status

- The **ownership model is already final**: Fleet domain logic belongs in `fleet-core`; Pi runtime integration belongs in `pi-fleet-extension`.
- The current implementation still lives under `packages/fleet-core/src/`.
- `packages/pi-fleet-extension` uses `src/` as the active Pi capability-bucket home.
- Do not document or assume that Pi capability buckets have moved out of `packages/pi-fleet-extension/src/`.

## Owns

- Fleet domain modules such as `admiral/` (including `_shared/` for agent-runtime with session pool, `executeWithPool`, `executeOneShot`, MCP servers, SSOT carrier job stream events (`carrier-job-events`), pure coalescing reducers (`stream-reducers`), store-free view-model builders (`view-model`), `carrier/`, `carrier-jobs/`, `squadron/`, `store/`, `taskforce/`, and `protocols/` with integrated `standing-orders/`). **The former `admiral/bridge/` directory (run-stream, carrier-panel, carrier-control) has been removed; streaming consumers now use `jobs.streaming.register()` via the SSOT event system.** `admiralty/` (internalized Grand Fleet domain), `services/auth/`, `services/job/` (including `sanitize.ts` and `detached-job-lifecycle.ts`), unified settings/log/tool-registry services (now absorbing tool-snapshot), and `metaphor/`
- Public API contracts and frozen consumer surfaces, including the canonical `public/runtime.ts` for agent runtime assembly. Note that `agent-services.ts` and `tool-registry-services.ts` have been removed from the public surface.
- `createFleetCoreRuntime` as the canonical composition entry point, exported from the package root, that initializes the runtime-owned state and domain services by exposing explicit public APIs in `public/`; it returns `FleetCoreRuntimeContext` containing `fleet`, `grandFleet`, `metaphor`, `jobs`, `log`, and `settings` services. The `fleet` service surface now also exposes runtime-owned auth access. It also owns the `shutdown` lifecycle that cleans up the agent, resets the settings service, and cleans up service status state.
- Agent execution is orchestrated through the internal `@sbluemin/fleet-core/admiral/agent-runtime` layer. Unified-agent request orchestration remains an internal implementation detail and must not be reintroduced as a public `AgentRequestService`/`agentRequest` runtime field.

- Fleet tool specs and registry factories that are host-agnostic and registered by adapters through public APIs
- Global runtime stores, **runtime-owned settings singletons (owned by `services/settings`)**, job lifecycle infrastructure, streaming event contracts, and compatibility keys used by Pi adapters
- Pure prompt composition, domain-level orchestration logic, and **render-agnostic view-model builders**
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
- Preserve existing `globalThis` compatibility keys exactly unless a higher-order doctrine explicitly changes them.
- Background paths must accept plain runtime data and host ports, never Pi `ExtensionContext`.
- Job archive behavior remains read-many within TTL.

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
