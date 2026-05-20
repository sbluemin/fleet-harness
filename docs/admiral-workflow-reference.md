# Admiral Workflow Reference

This document is the operational doctrine for Admiral and Carrier agents working inside this repository.

## 1. Architecture State

- `packages/fleet-core` owns Fleet **domain logic**.
- `packages/fleet-core/src/admiralty` owns the internalized **Grand Fleet domain**.
- `packages/fleet-agent` owns **host domains** and CLI integration (Flat Domain Architecture).

Physical domain layout:
- `packages/fleet-core` remains the foundation for domain orchestration.
- `packages/fleet-agent` is the active physical home for host integration, assembling the Fleet runtime by composing domain modules.

## 2. Ownership Model

### 2.1 `fleet-core`

`fleet-core` owns:
- Fleet domain orchestration
- Prompt composition and doctrine assets
- Admiral-owned carrier, carrier-jobs, taskforce, store, and SSOT streaming event layers under `src/admiral/`
- Agent execution (session pool, executor, MCP server, runtime)
- Tool registry/snapshot domain and job domain logic
- Pure runtime stores, ports, and adapter-facing contracts

`fleet-core` must not own:
- CLI host lifecycle registration
- Command/Shortcut registration
- TUI rendering
- Grand Fleet formation/process management

### 2.2 `fleet-core/src/admiralty`

`fleet-core/src/admiralty` owns:
- Grand Fleet prompt composition and status source logic
- Grand Fleet IPC protocol contracts
- Grand Fleet reporter output helpers, tool specs, and shared types

### 2.3 `fleet-agent`

`fleet-agent` owns:
- CLI host lifecycle registration
- Command, keybind, and tool registration
- Provider registration/stream glue and session handling
- Settings, log, HUD glue, and lifecycle management
- TUI overlays, widgets, and editor/footer rendering
- Compatibility adapters and push delivery seams

`fleet-agent` must not become a home for pure Fleet domain business logic.

## 3. Domain Layout

In the Flat Domain Architecture, host ownership is expressed through these domain-internal homes and entrypoints in `packages/fleet-agent`:

- `src/boot.ts` — Entry point — assembles the Fleet runtime by composing domain modules
- `src/fleet.ts` — Fleet lifecycle, runtime initialization, and host port implementation
- `src/provider.ts` — Fleet-AI gateway and provider runtime registration
- `src/admiralty/` — Multi-instance Grand Fleet orchestration
- `src/wiki/` — Fleet knowledge base and ingest
- `src/hud/`, `src/panel/`, `src/pty/` — Host shell integration and terminal features
- `src/jobs.ts` — Detached carrier job management
- `src/settings.ts` — Fleet-wide settings and configuration
- `src/logs.ts` — Fleet activity logging

## 4. Allowed Dependency Direction

The intended dependency direction is:

```text
fleet-wiki
  -> (leaf package; no workspace imports)

fleet-core
  -> admiralty public subpaths

fleet-agent domains
  -> fleet-core public APIs
  -> fleet-core admiralty public APIs
  -> fleet-wiki
  -> Host TUI / CLI facilities
```

Forbidden patterns:
- `fleet-core` importing host-specific packages
- `fleet-agent` deep-importing `fleet-core/src/**`
- New pure domain logic landing under `fleet-agent`

## 5. Operational Guidance For Agents

When editing or reviewing this repo:
1. Ask first whether the behavior is pure Fleet domain logic or host integration.
2. Put pure logic in `fleet-core`.
3. Put lifecycle/registration/rendering in the appropriate domain home in `fleet-agent`.
4. Keep documentation and code organization aligned with the active `packages/fleet-agent/src/` layout.

## 6. Compatibility Invariants

Preserve:
- Slash command names
- Carrier completion push semantics
- Detached-job acceptance vs completion-push distinction
- MCP/provider FIFO and archive behavior
- **Multi-Instance State Integrity**: Shared `states.json` must remain race-free through `_generation` token guarding and `fs.watch` synchronization.
