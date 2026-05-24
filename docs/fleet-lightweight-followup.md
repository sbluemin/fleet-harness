# Fleet Lightweight Follow-up

## Background

Fleet now uses explicit package ownership without standalone Admiral compatibility packages.

- `runtime/fleet-cli` owns CLI lifecycle wiring, TUI rendering, host-specific adapters, and concrete runtime assembly; it consumes Admiral policy from `@dotobokuri/fleet-admiral` and owns Grand Fleet policy.
- `packages/fleet-carriers` owns carrier personas, dispatch, carrier jobs, and carrier state.
- `packages/fleet-infra` owns host-agnostic infrastructure and I/O gateways.
- `packages/fleet-mcp-server` owns generic MCP registry/server behavior.
- `@dotobokuri/fleet-unified-agent` remains the independent backend client package.

## Purpose

The follow-up keeps lower packages host-agnostic while preserving a clear home for each behavior. The goal is explicit construction, one-way dependencies, and no hidden process-global runtime state.

## Current State

- **Logical ownership:** Final package homes are split by domain.
- **Dependency direction:** `fleet-cli` -> `fleet-carriers` -> `fleet-infra`, with `fleet-mcp-server` consumed as a generic leaf.

## Goals

- **Thin lower layers:** Keep lower packages focused on reusable carrier, infrastructure, and MCP behavior.
- **Explicit host assembly:** Keep concrete boot order in `fleet-cli`.
- **No compatibility facades:** Do not recreate deleted namespace or factory packages.

## Guardrails

- Keep lower packages host-agnostic.
- Keep host imports on public package exports plus package-local `.js` relative imports.
- Use explicit `create*(deps)` factories where a new injectable service is genuinely needed.
