# Fleet Development Reference Guide

This guide explains how Fleet host-adapter development is organized during the capability-flattening migration.

## 1. Architectural Split

Fleet development now follows a hard split:

- `packages/fleet-core` — host-agnostic Fleet product core
- `packages/fleet-core/src/admiralty` — internalized Grand Fleet domain (formerly `gfleet`)
- `packages/fleet-harness` — Fleet host capability package

Use this split as the first decision point for every change.

## 2. Migration Stage

The codebase is in a capability-flattening stage:

- logical ownership already follows the final direction
- `packages/fleet-harness/src/` remains the active physical home for Fleet host capability buckets
- capability buckets currently live under `packages/fleet-harness/src/<bucket>/`

Do not document or implement relocation of these buckets out of `src/`.

## 3. Where New Work Goes

### 3.1 `packages/fleet-core`

Put code here when it is:

- pure orchestration or domain logic
- prompt composition
- state/store logic that does not require Fleet host runtime objects
- runtime contracts, ports, pure controllers, or public APIs

Public consumption should prefer `FleetCoreRuntimeContext` from the package root. `src/public/runtime.ts` is the internal canonical composition leaf, and `src/public/` contains the domain service modules. Older one-file public leaves are legacy removal candidates, not new export targets.

Do not put Fleet host registration or TUI mounting here.

### 3.2 `packages/fleet-core/src/admiralty`

Put code here when it is:

- Grand Fleet prompt composition or reporter logic
- Grand Fleet IPC protocol contracts
- Grand Fleet shared types, tool specs, status source logic, or text sanitization

Keep dependencies one-way: `fleet-core`.

### 3.3 `packages/fleet-harness`

Put code here when it requires:

- `ExtensionContext` or `ExtensionAPI`
- `pi.on(...)`
- `pi.registerCommand(...)`
- `pi.registerShortcut(...)`
- `pi.registerTool(...)`
- `pi.registerProvider(...)`
- `pi.sendMessage(...)`
- `@sbluemin/fleet-tui`

> The `pi.*` host-runtime API surface is the `ExtensionAPI` provided by `@sbluemin/fleet-coding-agent` (the vendored Fleet engine). The local identifier `pi` is a historical variable name preserved for code-level compatibility; conceptually it refers to the Fleet host runtime.

## 4. Domain Layout Map

Current Flat Domain Architecture in `fleet-harness`:

| Home / Entrypoint | Responsibility |
|-------------------|----------------|
| `src/boot.ts` | Entry point — assembles the Fleet runtime by composing domain modules |
| `src/fleet.ts` | Fleet lifecycle, runtime initialization, and Fleet host port implementation |
| `src/provider.ts` | Fleet-AI gateway, streamAcp adapter, and provider runtime registration |
| `src/grand-fleet/` | Domain-internal home for multi-instance Grand Fleet orchestration |
| `src/wiki/` | Domain-internal home for knowledge base, ingest, and patching |
| `src/hud/`, `src/panel/`, `src/pty/`, `src/welcome.ts` | Host shell integration and terminal features |
| `src/metaphor.ts` | Domain entrypoint for persona, worldview, and naval metaphors |
| `src/jobs.ts` | Domain entrypoint for detached carrier job management |
| `src/settings.ts` | Domain entrypoint for fleet-wide settings and configuration |
| `src/logs.ts` | Domain entrypoint for fleet activity logging and categories |
| `src/tools.ts` | Domain entrypoint for tool registration and discovery |

## 5. Removed Legacy Directory Guidance

The following legacy directories under `packages/fleet-harness/src/` are already removed and must not be reintroduced:

- `src/commands/`
- `src/keybinds/`
- `src/tools/`
- `src/tui/`
- `src/provider/`
- `src/session/`

Do not treat historical paths as present-day ownership signals. Their features have been absorbed into the respective domain homes (e.g., `src/provider.ts` owns its tools and UI).

Do not treat historical paths such as `src/metaphor/`, `src/fleet/admiral/`, or `src/fleet/shipyard/carrier_jobs/` as present-day ownership signals. Their former existence does not change current ownership: Fleet domain logic belongs in `fleet-core`, and Fleet host wiring belongs in the active domain adapters under `src/`.

When migrating or restoring behavior that once lived under those paths:

1. move pure/domain code toward `fleet-core`
2. move Fleet host registration/rendering code toward the correct domain adapter
3. do not recreate the deleted legacy directory as a shim

## 6. Import Rules

- `fleet-harness` must consume `fleet-core` through public exports only.
- For runtime composition, use `@sbluemin/fleet-core` and consume domain APIs through `FleetCoreRuntimeContext`. Direct shared-service subpaths are migration compatibility surfaces only; new public API should be modeled as a domain service. Keybind is not a Fleet Core public service.
- `fleet-harness` must consume Grand Fleet surfaces through `@sbluemin/fleet-core/admiralty` or `@sbluemin/fleet-core/admiralty/ipc`.
- `fleet-harness` may consume `@sbluemin/fleet-wiki` for Fleet Wiki adapters that live in `src/wiki/`.
- Do not deep-import `@sbluemin/fleet-core/src/**` or `@sbluemin/fleet-core/internal/**`.
- Do not import Grand Fleet surfaces from the deprecated Fleet Core location.
- `fleet-core` must not import Fleet host runtime packages.
- `fleet-core` must not split internal admiralty ownership back out into a separate package.
- All upstream `@mariozechner/pi-*` engine packages have been fork-vendored as `@sbluemin/fleet-*` under `engines/packages/` and are consumed via `workspace:*` links. The Fleet-AI surface is re-exported from `packages/flee-harness/src/provider.ts` as the **single host gateway**; other adapters consume it through that gateway only.

## 9. Multi-Instance State Synchronization

Fleet supports multiple concurrent instances sharing the same `states.json` file. This is achieved through three core mechanisms:

1. **`_generation` Token (Atomic Consistency)**: The state file contains a monotonic `_generation` counter. Every write increments this token. Instances use this to detect if the file has changed on disk since their last read, preventing lost-update races.
2. **`fs.watch` & Echo Suppression (Real-time Sync)**: `fleet-harness` registers a file watcher on the fleet data directory. When another instance writes to `states.json`, the watcher triggers a state refresh. The writing instance suppresses its own "self-echo" by tracking its last written generation.
3. **Snapshot-based Read & Self-Healing**: All internal lookups (e.g., CLI type, model selection) use a snapshot-based read strategy. If a read path encounters inconsistent or stale data (e.g., a missing `cliType` for a registered carrier), the store automatically triggers a healing cycle to reconcile the state against the active catalog.

Developers must avoid adding in-memory caches for state-derived values. Always use the pull-based resolvers provided by `fleet-core`.
## 7. Fleet Host Runtime Rules

- Background work must not capture stale Fleet host `ExtensionContext`.
- Detached-job completion delivery remains a Fleet host responsibility.
- Tool registration, custom renderer registration, and push-message wiring remain Fleet host capability concerns even when the underlying job logic lives in `fleet-core`.

## 8. Physical Layout Reminder

`packages/fleet-harness/src/` is the active physical home for Fleet host capability buckets. Any documentation or review must keep that layout explicit and avoid implying that these buckets are scheduled to move.
