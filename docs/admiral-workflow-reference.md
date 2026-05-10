# Admiral Workflow Reference

This document is the operational doctrine for Admiral and Carrier agents working inside this repository during the Fleet capability-flattening migration.

## 1. Current Architecture State

The migration target is already fixed:

- `packages/fleet-core` owns Fleet **domain logic**
- `packages/fleet-core/src/admiralty` owns the internalized **Grand Fleet domain**
- `packages/fleet-harness` owns Pi **host domains** (Flat Domain Architecture)

The repository uses this **current physical state**:

- `packages/fleet-core` remains under `packages/fleet-core/src/`
- `packages/fleet-core/src/admiralty` is an internalized domain within `fleet-core` with public subpaths `./admiralty` and `./admiralty/ipc`
- `packages/fleet-harness/src/` is the active physical home for the Flat Domain Architecture mirroring fleet-core public services.

Agents must not confuse logical ownership with physical domain layout. `packages/fleet-harness/src/` remains the active physical home, and the old legacy capability buckets have been removed and absorbed into domain homes.

## 2. Ownership Model

### 2.1 `fleet-core`

`fleet-core` owns:

- Fleet domain orchestration
- prompt composition and doctrine assets
- persona, tone, worldview, operation-name, and directive-refinement domain logic
- Admiral-owned carrier, carrier-jobs, squadron, taskforce, store, and SSOT streaming event layers under `src/admiral/`
- Agent execution (session pool, executeWithPool/executeOneShot, MCP server, session-store, runtime) consolidated under `src/admiral/_shared/agent-runtime.ts` + `src/admiral/_shared/mcp.ts`
- Tool registry/snapshot domain under `src/services/tool-registry/` and job domain logic under `src/services/job/`
- pure runtime stores, ports, and adapter-facing contracts
- shared doctrine/runtime surfaces consumed by extracted leaf packages

Runtime composition is exposed only through the package root (`@sbluemin/fleet-core`). The legacy `@sbluemin/fleet-core/runtime` subpath has been removed. Public service access flows through `FleetCoreRuntimeContext` (`fleet`, `grandFleet`, `metaphor`, `jobs`, `log`, `settings`, `shutdown`); the agent runtime layer is reachable via the `@sbluemin/fleet-core/admiral/agent-runtime` compatibility subpath for adapters that need direct executor access.

`fleet-core` must not own:

- `ExtensionContext`
- `pi.on(...)`
- `pi.registerTool(...)`
- `pi.registerCommand(...)`
- `pi.registerShortcut(...)`
- `pi.registerProvider(...)`
- `pi.sendMessage(...)`
- Pi TUI rendering
- Grand Fleet formation/tmux process management

### 2.2 `fleet-core/src/admiralty`

`fleet-core/src/admiralty` (renamed from `gfleet`) owns:

- Grand Fleet prompt composition and status source logic
- Grand Fleet IPC protocol contracts
- Grand Fleet reporter output helpers, tool specs, text sanitization, and shared types

`fleet-core/src/admiralty` must not own:

- Pi runtime wiring or `@mariozechner/pi-*` imports
- deep imports into `fleet-core`
- any reverse dependency from `fleet-core`
- formation/tmux process management (removed)

### 2.3 `fleet-harness`

`fleet-harness` owns:

- Pi lifecycle registration
- command registration
- keybind registration
- tool registration
- provider registration/stream glue and non-provider session handling
- settings/keybind/log/HUD glue and lifecycle management
- Pi overlays, widgets, editor/footer rendering
- compatibility adapters and push delivery seams

`fleet-harness` must not become a new home for Fleet domain business logic.

## 3. Domain Layout

In the Flat Domain Architecture, Pi ownership is expressed through these domain-internal homes and entrypoints:

- `src/boot.ts` — Entry point — assembles the Fleet runtime by composing domain modules
- `src/fleet.ts` — Fleet lifecycle, runtime initialization, and Pi host port implementation
- `src/provider.ts` — Fleet-AI gateway, streamAcp adapter, and provider runtime registration
- `src/grand-fleet/` — Multi-instance Grand Fleet orchestration
- `src/wiki/` — Fleet knowledge base and ingest
- `src/hud/`, `src/panel/`, `src/pty/`, `src/welcome.ts` — Host shell integration and terminal features
- `src/metaphor.ts` — Persona, worldview, and naval metaphors
- `src/jobs.ts` — Detached carrier job management
- `src/settings.ts` — Fleet-wide settings and configuration
- `src/logs.ts` — Fleet activity logging and categories
- `src/tools.ts` — Tool registration and discovery

These are the **current doctrinal homes** even though the package still physically retains `src/`.

## 4. Legacy Folder Interpretation

The former legacy capability buckets below are already removed:

- `packages/fleet-harness/src/commands/`
- `packages/fleet-harness/src/keybinds/`
- `packages/fleet-harness/src/tools/`
- `packages/fleet-harness/src/tui/`
- `packages/fleet-harness/src/provider/`
- `packages/fleet-harness/src/session/`

Agents must not use those historical paths as permission to reintroduce capability-first architecture inside `fleet-harness`.

## 5. Allowed Dependency Direction

The intended dependency direction is:

```text
fleet-wiki
  -> (leaf package; no workspace imports)

fleet-core
  -> admiralty public subpaths

fleet-harness domains
  -> fleet-core public APIs
  -> fleet-core admiralty public APIs
  -> fleet-wiki
  -> Pi runtime / TUI / host facilities
```

Forbidden patterns:

- `fleet-core` importing Pi packages
- `fleet-core` duplicating internal admiralty ownership via a separate package
- `fleet-harness` deep-importing `fleet-core/src/**`
- `fleet-harness` importing Grand Fleet surfaces from the deprecated Fleet Core location
- new pure domain logic landing under `fleet-harness/src/fleet/**`
- new Pi registration code landing inside `fleet-core`

## 6. Operational Guidance For Agents

When editing or reviewing this repo:

1. Ask first whether the behavior is pure Fleet domain logic or Pi host integration.
2. Put pure logic in `fleet-core`.
3. Put Pi lifecycle/registration/rendering in the appropriate domain home or entrypoint.
4. If a legacy module mixes both, split by ownership instead of preserving the old directory boundary.
5. Keep documentation and code organization aligned with the active `packages/fleet-harness/src/` layout.

## 7. Compatibility Invariants

The migration does **not** authorize silent behavioral drift. Preserve:

- slash command names
- explicit compatibility accessors or module-level singleton state following the `border-bridge` pattern
- carrier completion push semantics
- detached-job acceptance vs completion-push distinction
- MCP/provider FIFO and archive behavior

## 8. Documentation Guidance

When updating docs during this migration:

- describe the **current observable state**
- separate **logical ownership** from **physical bucket placement**
- mention that legacy domain folders have been removed when that context matters
- avoid stating or implying that Pi capability buckets are scheduled to move out of `packages/fleet-harness/src/`
