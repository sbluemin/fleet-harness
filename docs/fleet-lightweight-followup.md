# Fleet Lightweight Follow-up

## Background

Fleet now uses explicit package ownership without standalone Admiral compatibility packages.

- `runtime/fleet-cli` owns CLI lifecycle wiring, TUI rendering, host-specific adapters, concrete runtime assembly, one in-process MCP HTTP/JSON-RPC server per CLI process, and the console register publisher; it consumes Admiral policy from `@dotobokuri/fleet-admiral`.
- `runtime/fleet-console` owns the standalone loopback HTTP backend, REST/SSE/WebSocket, PTY/provider/plugin runtime, durable state, and static UI.
- `runtime/fleet-console-desktop` is an optional thin Electron shell that supervises the existing Console Service through its public desktop protocol and loads `/console/`; it owns no duplicate UI or service runtime.
- `packages/fleet-carriers` owns carrier personas, dispatch, carrier jobs, and carrier state.
- `packages/core-infra` owns host-agnostic infrastructure and I/O gateways.
- `packages/core-agent` owns Fleet-domain-agnostic executor runtime, generic in-process MCP server primitives, and the shared register data contract.
- `@dotobokuri/core-unified-agent` remains the independent backend client package.

## Purpose

The follow-up keeps lower packages host-agnostic while preserving a clear home for each behavior. The goal is explicit construction, one-way dependencies, and no hidden process-global runtime state.

## Current State

- **Logical ownership:** Final package homes are split by domain.
- **Dependency direction:** `fleet-cli` -> `fleet-carriers` -> `core-infra`, with `fleet-console` as the local Console Service, `fleet-console-desktop` -> `fleet-console` for the optional native shell, and `core-agent` consumed as a generic leaf.

## Goals

- **Thin lower layers:** Keep lower packages focused on reusable carrier, infrastructure, and MCP behavior.
- **Explicit host assembly:** Keep concrete boot order in `fleet-cli`.
- **No compatibility facades:** Do not recreate deleted namespace or factory packages.

## Guardrails

- Keep lower packages host-agnostic.
- Keep host imports on public package exports plus package-local `.js` relative imports.
- Use explicit `create*(deps)` factories where a new injectable service is genuinely needed.
