# Admiral Workflow Reference

This document is the operational doctrine for Admiral and Carrier agents working inside this repository.

## 1. Architecture State

- `runtime/fleet-cli` owns the CLI host and Composition Root, and consumes single-fleet Admiral policy from `@dotobokuri/fleet-admiral`.
- `packages/fleet-carriers` owns carrier personas, dispatch, carrier jobs, store, and carrier runtime state.
- `packages/fleet-infra` owns host-agnostic auth, settings, executor/session infrastructure, logs, and I/O gateways.
- `packages/fleet-mcp-server` owns the generic MCP registry/server, token isolation, and tool snapshots.

## 2. Ownership Model

`fleet-cli` owns:
- CLI lifecycle registration and agent CLI launch.
- TUI rendering, overlays, widgets, and host input routing.
- Host adapters that consume Admiral prompt/protocol/tool policy from `@dotobokuri/fleet-admiral`.
- Concrete runtime assembly in `src/runtime/runtime.ts`.

`fleet-cli` must not own carrier persona catalogs, host-agnostic infrastructure internals, or generic MCP transport internals.

## 3. Allowed Dependency Direction

```text
fleet-cli
  -> fleet-admiral
  -> fleet-carriers
  -> fleet-infra
  -> fleet-mcp-server
  -> fleet-wiki / fleet-wiki-ui
```

Forbidden patterns:
- Lower packages importing `fleet-cli`.
- Recreating deleted compatibility packages or namespace facades.
- Deep-importing package `src/**` or `internal/**` across package boundaries.

## 4. Operational Guidance For Agents

1. Ask whether the behavior belongs to host assembly, carrier runtime, generic infrastructure, or generic MCP transport.
2. Put Admiral prompt/protocol/tool policy in `packages/fleet-admiral/src/**`.
3. Put carrier persona/runtime behavior in `packages/fleet-carriers`.
4. Keep runtime boot order explicit in `runtime/fleet-cli/src/runtime/runtime.ts`.

## 5. Compatibility Invariants

Preserve:
- Slash command names.
- Carrier completion push semantics.
- Detached-job acceptance vs completion-push distinction.
- MCP/provider FIFO and archive behavior.
- Multi-instance state integrity for shared `carriers.json`.
