# Fleet Development Reference Guide

This guide explains how Fleet development is organized.

## 1. Architectural Split

Fleet development follows a hard one-way dependency graph:

- `runtime/fleet-cli` — sole CLI Composition Root and host adapter; consumes Admiral policy from `@dotobokuri/fleet-admiral`.
- `packages/fleet-carriers` — carrier runtime, personas, jobs, and carrier state.
- `packages/fleet-infra` — host-agnostic infrastructure and I/O gateways.
- `packages/fleet-mcp-server` — generic MCP server, registry, routing, and tool snapshots.
- `packages/fleet-wiki` and `runtime/fleet-wiki-ui` — Fleet knowledge package and web UI.
- `packages/unified-agent` — independent execution engine client package.

## 2. Where New Work Goes

### 2.1 `runtime/fleet-cli`

Put code here when it requires terminal rendering, CLI process lifecycle management, host input routing, concrete service assembly, or Admiral prompt/protocol/tool policy.

### 2.2 `packages/fleet-carriers`

Put code here when it owns carrier persona metadata, carrier dispatch, carrier job surfaces, or carrier state persistence.

### 2.3 `packages/fleet-infra`

Put code here when it owns generic auth, data-dir, executor, log, settings, detached-job, or runtime I/O primitives.

### 2.4 `packages/fleet-mcp-server`

Put code here when it owns generic MCP registry/server behavior, token isolation, routing, or tool snapshots.

## 3. Import Rules

- `fleet-cli` assembles concrete services through explicit leaf package calls.
- Lower packages must not import `fleet-cli` or any package above them in the dependency graph.
- Consumers use public package exports only.
- Do not deep-import `src/**` or `internal/**` across package boundaries.

## 4. State Synchronization

Fleet supports multiple concurrent instances sharing the same `states.json` file via a `_generation` token and file locks. Developers must avoid hidden process-global state and use explicit service instances plus pull-based resolvers.
