# PI Development Reference Guide

This guide explains how PI-facing Fleet development is organized during the capability-flattening migration.

## 1. Architectural Split

Fleet development now follows a hard split:

- `packages/fleet-core` — Pi-agnostic Fleet product core
- `packages/fleet-core/src/admiralty` — internalized Grand Fleet domain (formerly `gfleet`)
- `packages/pi-fleet-extension` — Pi capability package

Use this split as the first decision point for every change.

## 2. Migration Stage

The codebase is in a capability-flattening stage:

- logical ownership already follows the final direction
- `packages/pi-fleet-extension/src/` remains the active physical home for Pi capability buckets
- capability buckets currently live under `packages/pi-fleet-extension/src/<bucket>/`

Do not document or implement relocation of these buckets out of `src/`.

## 3. Where New Work Goes

### 3.1 `packages/fleet-core`

Put code here when it is:

- pure orchestration or domain logic
- prompt composition
- state/store logic that does not require Pi runtime objects
- runtime contracts, ports, pure controllers, or public APIs

Public consumption should prefer `FleetCoreRuntimeContext` from the package root. `src/public/runtime.ts` is the internal canonical composition leaf, and `src/public/` contains the domain service modules. Older one-file public leaves are legacy removal candidates, not new export targets.

Do not put Pi registration or TUI mounting here.

### 3.2 `packages/fleet-core/src/admiralty`

Put code here when it is:

- Grand Fleet prompt composition or reporter logic
- Grand Fleet IPC protocol contracts
- Grand Fleet shared types, tool specs, status source logic, or text sanitization

Keep dependencies one-way: `fleet-core`.

### 3.3 `packages/pi-fleet-extension`

Put code here when it requires:

- `ExtensionContext` or `ExtensionAPI`
- `pi.on(...)`
- `pi.registerCommand(...)`
- `pi.registerShortcut(...)`
- `pi.registerTool(...)`
- `pi.registerProvider(...)`
- `pi.sendMessage(...)`
- `@mariozechner/pi-tui`

## 4. Domain Layout Map

Current Flat Domain Architecture in `pi-fleet-extension`:

| Home / Entrypoint | Responsibility |
|-------------------|----------------|
| `src/boot.ts` | Entry point — assembles the Fleet runtime by composing domain modules |
| `src/fleet.ts` | Fleet lifecycle, runtime initialization, and Pi host port implementation |
| `src/agent/` | Domain-internal home for agent orchestration, providers, and carrier gateway |
| `src/grand-fleet/` | Domain-internal home for multi-instance Grand Fleet orchestration |
| `src/fleet-wiki/` | Domain-internal home for knowledge base, ingest, and patching |
| `src/shell/` | Domain-internal home for host shell integration and terminal features |
| `src/fleet.ts` | Domain entrypoint for fleet-wide orchestration and event adapter features |
| `src/metaphor.ts` | Domain entrypoint for persona, worldview, and naval metaphors |
| `src/job.ts` | Domain entrypoint for detached carrier job management |
| `src/settings.ts` | Domain entrypoint for fleet-wide settings and configuration |
| `src/log.ts` | Domain entrypoint for fleet activity logging and categories |
| `src/tool-registry.ts` | Domain entrypoint for tool registration and discovery |

## 5. Removed Legacy Directory Guidance

The following legacy directories under `packages/pi-fleet-extension/src/` are already removed and must not be reintroduced:

- `src/commands/`
- `src/keybinds/`
- `src/tools/`
- `src/tui/`
- `src/provider/`
- `src/session/`

Do not treat historical paths as present-day ownership signals. Their features have been absorbed into the respective domain homes (e.g., `src/agent/` owns its tools and UI).

Do not treat historical paths such as `src/metaphor/`, `src/fleet/admiral/`, or `src/fleet/shipyard/carrier_jobs/` as present-day ownership signals. Their former existence does not change current ownership: Fleet domain logic belongs in `fleet-core`, and Pi host wiring belongs in the active capability buckets under `src/`.

When migrating or restoring behavior that once lived under those paths:

1. move pure/domain code toward `fleet-core`
2. move Pi registration/rendering code toward the correct capability bucket
3. do not recreate the deleted legacy directory as a shim

## 6. Import Rules

- `pi-fleet-extension` must consume `fleet-core` through public exports only.
- For runtime composition, use `@sbluemin/fleet-core` and consume domain APIs through `FleetCoreRuntimeContext`. Direct shared-service subpaths are migration compatibility surfaces only; new public API should be modeled as a domain service. Keybind is not a Fleet Core public service.
- `pi-fleet-extension` must consume Grand Fleet surfaces through `@sbluemin/fleet-core/admiralty` or `@sbluemin/fleet-core/admiralty/ipc`.
- `pi-fleet-extension` may consume `@sbluemin/fleet-wiki` for Fleet Wiki adapters that live in the active bucket-local `src/*/fleet-wiki/` homes.
- Do not deep-import `@sbluemin/fleet-core/src/**` or `@sbluemin/fleet-core/internal/**`.
- Do not import Grand Fleet surfaces from the deprecated Fleet Core location.
- `fleet-core` must not import Pi packages.
- `fleet-core` must not split internal admiralty ownership back out into a separate package.
- `@mariozechner/pi-ai` imports stay confined to `packages/pi-fleet-extension/src/agent/provider.ts`.

## 7. PI Runtime Rules

- Background work must not capture stale Pi `ExtensionContext`.
- Detached-job completion delivery remains a Pi-side responsibility.
- Tool registration, custom renderer registration, and push-message wiring remain Pi capability concerns even when the underlying job logic lives in `fleet-core`.

## 8. Physical Layout Reminder

`packages/pi-fleet-extension/src/` is the active physical home for Pi capability buckets. Any documentation or review must keep that layout explicit and avoid implying that these buckets are scheduled to move.
