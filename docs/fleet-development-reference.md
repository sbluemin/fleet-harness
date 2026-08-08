# Fleet Development Reference Guide

This guide explains how Fleet development is organized.

## 1. Architectural Split

Fleet development follows a hard one-way dependency graph:

- `runtime/fleet-console/cli` — thin `fleet` launcher Composition Root inside `@dotobokuri/fleet-console`; consumes Admiral policy from `@dotobokuri/fleet-admiral`; owns argv/process lifecycle, one in-process Fleet MCP, an ephemeral loopback AI Gateway, and a Claude Code child with inherited stdio (no PTY/TUI/interception).
- `packages/core-agent` — host-agnostic executor/session/model runtime engine, builtin external MCP catalog, generic in-process MCP server primitives, and shared register data contract.
- `packages/core-infra` — host-agnostic auth, data-dir resolution, data-dir/settings, and durable `fs-store` I/O primitives.
- `runtime/fleet-console` — standalone loopback Console Service and sole owner of CLI register ingest, REST/SSE/WebSocket, Terminal PTY/provider/plugin runtime, durable state, and static UI serving.
- `runtime/fleet-desktop` — optional thin Electron native shell; supervises a separately packaged standard Node sidecar and has no renderer, HTTP server, PTY, provider, plugin, or durable-state implementation.
- `packages/fleet-wiki` and `runtime/fleet-console` Codex — Fleet knowledge package and web UI.
- `packages/core-unified-agent` — independent execution engine client package.

## 2. Where New Work Goes

### 2.1 `runtime/fleet-console/cli`

Put code here when it belongs to the thin `fleet` launcher: argv/process lifecycle, Claude Code passthrough, `auth`/`update`/`console` dispatch, one in-process Fleet MCP, an ephemeral loopback AI Gateway, concrete service assembly, or Admiral prompt/protocol/tool policy. Do not put PTY, TUI, or terminal I/O interception here.

### 2.3 `packages/core-infra`

Put code here when it owns generic auth, data-dir resolution, data-dir/settings, or durable `fs-store` I/O primitives. Executor/session infrastructure belongs to `packages/core-agent`.

### 2.4 `runtime/fleet-console`

Put code here when it owns the standalone loopback HTTP backend for CLI register ingest, observer REST/SSE, terminal WebSocket tickets, static console serving, Console durable state, plugin runtime, PTY runtime, or console server lifecycle.

### 2.4.1 `runtime/fleet-desktop`

Put code here only when it concerns Electron main-process lifecycle, one native window/tray/menu, native update surfaces, or supervision of the packaged standard Node Console Service. The shell must load the verified loopback `/console/` URL and must not duplicate Console UI, HTTP/REST/SSE/WebSocket, `node-pty`, provider policy, plugin routes, or durable state.

### 2.5 `packages/core-agent`

Put code here when it owns the host-agnostic one-shot executor/session/model runtime engine (fresh provider client per call, readiness/session discovery, and explicit resume), builtin external MCP catalog, generic in-process MCP server primitives, or shared register data contracts.

## 3. Import Rules

- The Console-owned `fleet` launcher assembles concrete services through explicit leaf package calls.
- Lower packages must not import runtime hosts (`runtime/fleet-console`, `runtime/fleet-desktop`) or any package above them in the dependency graph.
- Consumers use public package exports only.
- Do not deep-import `src/**` or `internal/**` across package boundaries.
- The Desktop shell depends on the Console Service protocol; the Console Service never depends on Electron.

## 4. State Synchronization

Fleet supports multiple concurrent instances sharing the same durable state files via the `fs-store` advisory directory lock (`withDirectoryLock`) combined with atomic writes and read-time snapshots. Developers must avoid hidden process-global state and use explicit service instances plus pull-based resolvers.

## 5. Isolated Development Data

By default every Fleet host reads and writes the real user data root at `~/.fleet` — credentials, global settings, AI Gateway selection, and workspaces all live there. `pnpm cli`, `pnpm console`, and `pnpm desktop` therefore run through `scripts/run-isolated.mjs`, which points all three at one checkout-local root so a development run cannot read or overwrite the user's own environment:

| Variable | Development value | Owns |
|---|---|---|
| `FLEET_DATA_DIR` | `<checkout>/.fleet/isolated` | Credentials, global settings, AI Gateway selection, workspaces |
| `FLEET_CONSOLE_DATA_DIR` | `<checkout>/.fleet/isolated/console` | Console durable state and runtime lock |
| `FLEET_DESKTOP_DATA_DIR` | `<checkout>/.fleet/isolated/desktop` | Desktop owner identity and Electron user data |

Because the root is isolated, a development run starts with no credentials, no installed marketplace plugins, and no accumulated workspace knowledge — that is the point of the isolation, not a defect. Set any variable yourself to override the default slot; each must be an absolute path, and a relative value fails loudly rather than silently falling back to the real root. `FLEET_CONSOLE_DIR` remains accepted as the former name of `FLEET_CONSOLE_DATA_DIR` so already-shipped Desktop shells keep working, but Desktop honors that older name only when packaged.
