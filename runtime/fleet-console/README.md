# Fleet Console

Standalone loopback web console for observing carrier jobs, live output streams, and plugin-owned PTY terminal workspaces.

## What It Does

Fleet Console owns its own local HTTP server. The Terminal plugin owns Shell and Agent PTY runtime, tickets, launch, and WebSocket transport; carrier events are streamed to the browser through the observer API.

- Plugin-owned terminal sessions and observed jobs in a navigable rail.
- Workspace hub sessions created through an in-console directory browser — no OS-native dialog.
- Terminal plugin-spawned Agent CLI PTYs with in-process observation.
- Per-job carrier tracks with incremental output text, reasoning folds, and tool-call activity.
- Codex/Fleet Wiki browsing under the shared Console GNB at `/console/codex`.
- Browser observer snapshots and SSE streams backed by console-owned global observed ids.
- Browser terminal access through short-lived tickets over WebSocket.

The built-in terminal plugin lives at `runtime/fleet-plugins/terminal` (`@fleet-plugins/terminal`). It is the single built-in plugin id `terminal`, provides operation types `shell`, `agent`, and `agent.streaming`, owns plugin-scoped WebSocket, ticket, PTY session, and launch runtime, and serves Shell/Agent plugin routes under `/plugins/terminal/{shell,agent}/*`. The console owns Theater folder selection through `/theaters/folders/*`. The Shell launch title is `Shell`.

## Runtime Channels

| Channel | Purpose | Token Boundary |
|---|---|---|
| `/observer/*` | Browser snapshot and SSE observer surface. | Loopback-only; no browser bearer token. |
| `POST /theaters/folders/list` | Returns a directory listing (`{ path, parentPath, roots, entries, truncated? }`) for the given path, or the server home directory when `path` is null. Directories only, non-recursive, capped at 500 entries. | Requires the terminal Origin boundary (`isTerminalAuthorized`); no adminToken. |
| `POST /theaters/folders/grants` | Validates the client-supplied absolute path through `validateAbsoluteDirectory` and returns a one-use `{ folderGrantId }`. | Requires the terminal Origin boundary; no adminToken. |
| `/plugins/terminal/shell/*` | Shell launch and ticket routes for the `shell` operation type. | Shell cwd is resolved server-side from the selected Theater; browser receives only one-use terminal tickets. |
| `/plugins/terminal/agent/*` | Agent launch, session, ticket, job, event, tenant, and state routes for the `agent` and `agent.streaming` operation types. | Requires the terminal Origin boundary; MCP/session tokens remain server-only. |
| Terminal plugin WebSocket route | Terminal plugin-owned browser PTY WebSocket transport used by Shell and Agent operations under the plugin namespace. | Browser reaches it through a one-use ticket from the terminal plugin routes. |
| `/console/` | Static React client served from this package's `dist/client`. | Served directly from the loopback console URL. |
| `/console/codex/*` | Console-owned Codex/Fleet Wiki web, workspace API, and migrated Maritime Codex client. | Admin workspace registration uses the lock bearer token; browser reads stay token-free on allowed local origins. |

`/observer/tenants` may include `terminalSessionId` for plugin-owned terminal sessions. Shell and Agent HTTP routes plus WebSocket transport live under `/plugins/terminal/*`.

## Session Binding

When the Terminal plugin creates a terminal session, it generates a session id, resolves the selected Agent CLI through the shared fleet-admiral runtime, and keeps the selected absolute cwd server-side. The plugin records non-secret session metadata for observer hydration through generic console operation and event capabilities.

Folder selection is handled entirely in the browser UI: the React directory browser modal calls the console-owned `POST /theaters/folders/list` route to browse the server's local filesystem, then calls `POST /theaters/folders/grants` once the operator confirms a directory. The resulting one-use grant is consumed by Theater registration; Shell and Agent launches resolve cwd from the Theater server-side. No OS-native dialog or child process is involved. The browser modal works in remote and headless browser sessions without any OS-level dialog support.

Folder grants are one-use and in-memory. Browser-side cancellation stays local to the modal and does not call the server grant endpoint.

## Security Notes

HTTP surfaces are loopback-only. Browser observer routes are directly available on loopback and terminal routes retain their Origin boundary (`isTerminalAuthorized`). MCP session tokens, bootstrap tokens, and selected absolute paths are not exposed through browser payloads, URL query strings, SSE frames, terminal tickets, logs, or static assets.

`POST /theaters/folders/list` and `POST /theaters/folders/grants` both require `validateHost` and `isTerminalAuthorized`. No adminToken or bearer auth is used for folder endpoints. Selected absolute paths appear only in list and grant API responses; they are not included in session, Theater, observer, or SSE payloads. When a Theater is registered, the resolved cwd is stored in durable local state (`~/.fleet/console/state.json`, `sensitivity: "sensitive"`) exactly as before; this is a sensitive local file and is not transmitted to the browser.

Codex/Fleet Wiki routes preserve the migrated wiki security boundary: Host allowlist, Origin checks for write routes, loopback write gates, path containment, DOMPurify markdown sanitization, strict Mermaid rendering, and lockfile bearer auth for workspace registration.

## Usage

```bash
fleet console        # via fleet-cli
fleet-console        # standalone binary
fleet-console status
fleet-console stop
fleet wiki           # opens the console-owned Codex surface
fleet-wiki           # standalone compatibility binary from this package
```

The launcher ensures the local console server is running and opens `/console/` directly without browser token fragments.

## Development

Source is split under `core/host/` for the Node CLI/backend and `core/client/` for the Vite React SPA. The built-in Terminal plugin package lives at `../fleet-plugins/terminal/`. The private `@fleet-console/sdk` package under `sdk/` is the shared plugin contract surface for core and built-in plugins.

```bash
pnpm --filter @dotobokuri/fleet-console dev
pnpm --filter @dotobokuri/fleet-console test
pnpm --filter @dotobokuri/fleet-console typecheck
pnpm --filter @dotobokuri/fleet-console build
```

`build` emits `dist/cli.mjs`, `dist/cli-bin.mjs`, `dist/client/`, and `dist/fleet-plugins/terminal/routes.mjs`. There is no external embed step.

See `AGENTS.md` for ownership, token-boundary, and streaming invariants.
