# Fleet Development Reference Guide

This guide explains how Fleet development is organized.

## 1. Architectural Split

Fleet development follows a hard one-way dependency graph:

- `runtime/fleet-cli` — sole CLI Composition Root and host adapter; consumes Admiral policy from `@dotobokuri/fleet-admiral`; owns one in-process MCP HTTP/JSON-RPC server per CLI process and the console register publisher.
- `packages/core-agent` — host-agnostic executor/session/model runtime engine, builtin external MCP catalog, generic in-process MCP server primitives, and shared register data contract.
- `packages/core-infra` — host-agnostic auth, data-dir resolution, data-dir/settings, and durable `fs-store` I/O primitives.
- `runtime/fleet-console` — standalone loopback Console Service and sole owner of CLI register ingest, REST/SSE/WebSocket, Terminal PTY/provider/plugin runtime, durable state, and static UI serving.
- `runtime/fleet-desktop` — optional thin Electron native shell; supervises a separately packaged standard Node sidecar and has no renderer, HTTP server, PTY, provider, plugin, or durable-state implementation.
- `packages/fleet-wiki` and `runtime/fleet-console` Codex — Fleet knowledge package and web UI.
- `packages/core-unified-agent` — independent execution engine client package.

## 2. Where New Work Goes

### 2.1 `runtime/fleet-cli`

Put code here when it requires terminal rendering, CLI process lifecycle management, host input routing, concrete service assembly, per-process in-process MCP serving, console registration publishing, or Admiral prompt/protocol/tool policy.

### 2.3 `packages/core-infra`

Put code here when it owns generic auth, data-dir resolution, data-dir/settings, or durable `fs-store` I/O primitives. Executor/session infrastructure belongs to `packages/core-agent`.

### 2.4 `runtime/fleet-console`

Put code here when it owns the standalone loopback HTTP backend for CLI register ingest, observer REST/SSE, terminal WebSocket tickets, static console serving, Console durable state, plugin runtime, PTY runtime, or console server lifecycle.

### 2.4.1 `runtime/fleet-desktop`

Put code here only when it concerns Electron main-process lifecycle, one native window/tray/menu, native update surfaces, or supervision of the packaged standard Node Console Service. The shell must load the verified loopback `/console/` URL and must not duplicate Console UI, HTTP/REST/SSE/WebSocket, `node-pty`, provider policy, plugin routes, or durable state.

### 2.5 `packages/core-agent`

Put code here when it owns the host-agnostic one-shot executor/session/model runtime engine (fresh provider client per call, readiness/session discovery, and explicit resume), builtin external MCP catalog, generic in-process MCP server primitives, or shared register data contracts.

## 3. Import Rules

- `fleet-cli` assembles concrete services through explicit leaf package calls.
- Lower packages must not import `fleet-cli` or any package above them in the dependency graph.
- Consumers use public package exports only.
- Do not deep-import `src/**` or `internal/**` across package boundaries.
- The Desktop shell depends on the Console Service protocol; the Console Service never depends on Electron.

## 4. State Synchronization

Fleet supports multiple concurrent instances sharing the same durable state files via the `fs-store` advisory directory lock (`withDirectoryLock`) combined with atomic writes and read-time snapshots. Developers must avoid hidden process-global state and use explicit service instances plus pull-based resolvers.
