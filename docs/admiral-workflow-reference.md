# Admiral Workflow Reference

This document is the operational doctrine for Admiral and Carrier agents working inside this repository.

## 1. Architecture State

- `runtime/fleet-cli` owns the CLI host and Composition Root, and consumes single-fleet Admiral policy from `@dotobokuri/fleet-admiral`.
- `packages/fleet-carriers` owns carrier personas, dispatch, carrier jobs (including detached jobs), store, and carrier runtime state.
- `packages/core-agent` owns the host-agnostic executor/session/model runtime engine (`executeWithPool` / `executeOneShot`) and the builtin external MCP catalog.
- `packages/core-unified-agent` owns the unified ACP CLI backend client engine and the `CLI_BACKENDS` provider catalog.
- `packages/fleet-infra` owns host-agnostic auth, data-dir resolution, global options, and the durable `fs-store` I/O primitives.
- `packages/core-mcp-server` owns the generic MCP registry/server, token isolation, and tool snapshots.

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
  -> core-agent
  -> fleet-infra
  -> core-mcp-server
  -> fleet-wiki / fleet-wiki-ui

core-agent / fleet-carriers / fleet-infra
  -> core-unified-agent
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
