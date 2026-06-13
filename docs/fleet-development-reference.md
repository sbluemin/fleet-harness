# Fleet Development Reference Guide

This guide explains how Fleet development is organized.

## 1. Architectural Split

Fleet development follows a hard one-way dependency graph:

- `runtime/fleet-cli` — sole CLI Composition Root and host adapter; consumes Admiral policy from `@dotobokuri/fleet-admiral`; owns one in-process MCP HTTP/JSON-RPC server per CLI process and the console register publisher.
- `packages/fleet-carriers` — carrier runtime, personas, jobs (including detached jobs), and carrier state.
- `packages/core-agent` — host-agnostic executor/session/model runtime engine, builtin external MCP catalog, generic in-process MCP server primitives, and shared register data contract.
- `packages/fleet-infra` — host-agnostic auth, data-dir resolution, global options, and durable `fs-store` I/O primitives.
- `runtime/fleet-console` — standalone loopback HTTP backend for CLI register ingest, observer SSE, terminal WebSocket, and static console serving for a single workspace.
- `packages/fleet-wiki` and `runtime/fleet-wiki-ui` — Fleet knowledge package and web UI.
- `packages/core-unified-agent` — independent execution engine client package.

## 2. Where New Work Goes

### 2.1 `runtime/fleet-cli`

Put code here when it requires terminal rendering, CLI process lifecycle management, host input routing, concrete service assembly, per-process in-process MCP serving, console registration publishing, or Admiral prompt/protocol/tool policy.

### 2.2 `packages/fleet-carriers`

Put code here when it owns carrier persona metadata, carrier dispatch, carrier job surfaces, or carrier state persistence.

### 2.3 `packages/fleet-infra`

Put code here when it owns generic auth, data-dir resolution, global options, or durable `fs-store` I/O primitives. Executor/session infrastructure belongs to `packages/core-agent`; detached-job infrastructure belongs to `packages/fleet-carriers`.

### 2.4 `runtime/fleet-console`

Put code here when it owns the standalone loopback HTTP backend for CLI register ingest, observer REST/SSE, terminal WebSocket tickets, static console serving, or console server lifecycle for a single workspace.

### 2.5 `packages/core-agent`

Put code here when it owns the host-agnostic executor pool/session/model runtime engine, builtin external MCP catalog, generic in-process MCP server primitives, or shared register data contracts.

## 3. Import Rules

- `fleet-cli` assembles concrete services through explicit leaf package calls.
- Lower packages must not import `fleet-cli` or any package above them in the dependency graph.
- Consumers use public package exports only.
- Do not deep-import `src/**` or `internal/**` across package boundaries.

## 4. State Synchronization

Fleet supports multiple concurrent instances sharing the same `carriers.json` file via the `fs-store` advisory directory lock (`withDirectoryLock`) combined with atomic writes and read-time snapshots. Developers must avoid hidden process-global state and use explicit service instances plus pull-based resolvers.
