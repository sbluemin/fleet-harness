# Fleet Console

Standalone loopback web console for observing carrier jobs, live output streams, and multi-session PTY terminal workspaces.

## What It Does

Fleet Console owns its own local HTTP server. Terminal sessions are spawned by the console server and observed in-process; carrier events are streamed to the browser through the observer API.

- Console-owned terminal sessions and observed jobs in a navigable rail.
- Workspace hub sessions created through an in-console directory browser — no OS-native dialog.
- Console-spawned Agent CLI PTYs with in-process observation.
- Per-job carrier tracks with incremental output text, reasoning folds, and tool-call activity.
- Codex/Fleet Wiki browsing under the shared Console GNB at `/console/codex`.
- Browser observer snapshots and SSE streams backed by console-owned global observed ids.
- Browser terminal access through short-lived tickets over WebSocket.

## Runtime Channels

| Channel | Purpose | Token Boundary |
|---|---|---|
| `/observer/*` | Browser snapshot and SSE observer surface. | Loopback-only; no browser bearer token. |
| `POST /terminal/folders/list` | Returns a directory listing (`{ path, parentPath, roots, entries, truncated? }`) for the given path, or the server home directory when `path` is null. Directories only, non-recursive, capped at 500 entries. | Requires the terminal Origin boundary (`isTerminalAuthorized`); no adminToken. |
| `POST /terminal/folders/grants` | Validates the client-supplied absolute path through `validateAbsoluteDirectory` and returns a one-use `{ folderGrantId }`. | Requires the terminal Origin boundary; no adminToken. |
| `POST /terminal/sessions` | Consumes `{ folderGrantId }` to create a console-spawned Agent CLI PTY session. | Raw cwd values from browser requests are rejected. |
| `GET /terminal/sessions` | Lists non-secret terminal session metadata for hydration. | Requires the terminal Origin boundary. |
| `POST /terminal/ticket` + `/terminal/ws` | Browser terminal PTY transport; ticket requests may include `{ sessionId }` and default to `"default"` for compatibility. | Browser receives a one-use ticket. |
| `/console/` | Static React client served from this package's `dist/client`. | Served directly from the loopback console URL. |
| `/console/codex/*` | Console-owned Codex/Fleet Wiki web, workspace API, and migrated Maritime Codex client. | Admin workspace registration uses the lock bearer token; browser reads stay token-free on allowed local origins. |

`/observer/tenants` may include `terminalSessionId` for console-owned terminal sessions. `/terminal/ws` keeps the same path and query shape.

## Session Binding

When the console creates a terminal session, it generates a session id, resolves the selected Agent CLI through the shared fleet-admiral runtime, and keeps the selected absolute cwd server-side. The console records non-secret session metadata for observer hydration.

Folder selection is handled entirely in the browser UI: the React directory browser modal calls `POST /terminal/folders/list` to browse the server's local filesystem, then calls `POST /terminal/folders/grants` once the operator confirms a directory. The resulting one-use grant is consumed by `POST /terminal/sessions` or Theater registration; no OS-native dialog or child process is involved. The browser modal works in remote and headless browser sessions without any OS-level dialog support.

Folder grants are one-use and in-memory. Browser-side cancellation stays local to the modal and does not call the server grant endpoint.

## Security Notes

HTTP surfaces are loopback-only. Browser observer routes are directly available on loopback and terminal routes retain their Origin boundary (`isTerminalAuthorized`). MCP session tokens, bootstrap tokens, and selected absolute paths are not exposed through browser payloads, URL query strings, SSE frames, terminal tickets, logs, or static assets.

`POST /terminal/folders/list` and `POST /terminal/folders/grants` both require `validateHost` and `isTerminalAuthorized`. No adminToken or bearer auth is used for folder endpoints. Selected absolute paths appear only in list and grant API responses; they are not included in session, Theater, observer, or SSE payloads. When a Theater is registered, the resolved cwd is stored in durable local state (`~/.fleet/console/state.json`, `sensitivity: "sensitive"`) exactly as before; this is a sensitive local file and is not transmitted to the browser.

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

```bash
pnpm --filter @dotobokuri/fleet-console dev
pnpm --filter @dotobokuri/fleet-console test
pnpm --filter @dotobokuri/fleet-console typecheck
pnpm --filter @dotobokuri/fleet-console build
```

`build` emits `dist/cli.mjs` and `dist/client/`. There is no external embed step.

See `AGENTS.md` for ownership, token-boundary, and streaming invariants.
