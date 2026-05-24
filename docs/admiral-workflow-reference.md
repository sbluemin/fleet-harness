# Admiral Workflow Reference

This document is the operational doctrine for Admiral and Carrier agents working inside this repository.

## 1. Architecture State

- `runtime/fleet-cli` owns the CLI host, Composition Root, absorbed single-fleet Admiral policy in `src/admiral/**`, and absorbed Grand Fleet policy in `src/grand-fleet/**`.
- `packages/fleet-carriers` owns carrier personas, dispatch, carrier jobs, store, and carrier runtime state.
- `packages/fleet-infra` owns host-agnostic auth, settings, executor/session infrastructure, logs, and I/O gateways.
- `packages/fleet-mcp-server` owns the generic MCP registry/server, token isolation, and tool snapshots.

## 2. Ownership Model

`fleet-cli` owns:
- CLI lifecycle registration and dedicated CLI launch.
- TUI rendering, overlays, widgets, and host input routing.
- Admiral prompt/protocol/tool/MCP policy modules under `src/admiral/**`.
- Grand Fleet IPC, prompt, reporting, status, and runtime access helpers under `src/grand-fleet/**`.
- Concrete runtime assembly in `src/runtime/runtime.ts`.

`fleet-cli` must not own carrier persona catalogs, host-agnostic infrastructure internals, or generic MCP transport internals.

## 3. Allowed Dependency Direction

```text
fleet-cli
  -> fleet-carriers
  -> fleet-infra
  -> fleet-mcp-server
  -> fleet-wiki / fleet-wiki-ui
  -> fleet-tui
```

Forbidden patterns:
- Lower packages importing `fleet-cli`.
- Recreating deleted compatibility packages or namespace facades.
- Deep-importing package `src/**` or `internal/**` across package boundaries.

## 4. Operational Guidance For Agents

1. Ask whether the behavior belongs to host assembly, carrier runtime, generic infrastructure, or generic MCP transport.
2. Put Admiral prompt/protocol/tool policy in `runtime/fleet-cli/src/admiral/**`.
3. Put Grand Fleet coordination helpers in `runtime/fleet-cli/src/grand-fleet/**`.
4. Put carrier persona/runtime behavior in `packages/fleet-carriers`.
5. Keep runtime boot order explicit in `runtime/fleet-cli/src/runtime/runtime.ts`.

## 5. Compatibility Invariants

Preserve:
- Slash command names.
- Carrier completion push semantics.
- Detached-job acceptance vs completion-push distinction.
- MCP/provider FIFO and archive behavior.
- Multi-instance state integrity for shared `states.json`.
