# Fleet Console

Standalone loopback web console for observing carrier jobs, live output streams, and multi-session PTY terminal workspaces.

## What It Does

Fleet Console owns its own local HTTP server. Terminal sessions are spawned by the console server and observed in-process; carrier events are streamed to the browser through the observer API.

- Console-owned terminal sessions and observed jobs in a navigable rail.
- Workspace hub sessions created from OS-native folder selection.
- Console-spawned Agent CLI PTYs with in-process observation.
- Per-job carrier tracks with incremental output text, reasoning folds, and tool-call activity.
- Codex/Fleet Wiki browsing under the shared Console GNB at `/console/codex`.
- Browser observer snapshots and SSE streams backed by console-owned global observed ids.
- Browser terminal access through short-lived tickets over WebSocket.

## Runtime Channels

| Channel | Purpose | Token Boundary |
|---|---|---|
| `/observer/*` | Browser snapshot and SSE observer surface. | Loopback-only; no browser bearer token. |
| `POST /terminal/folders/pick` | Opens a native folder picker and returns a one-use folder grant, or `{ cancelled: true }`. | Requires the terminal Origin boundary; selected paths are kept server-side. |
| `POST /terminal/sessions` | Consumes `{ folderGrantId }` to create a console-spawned Agent CLI PTY session. | Raw cwd values from browser requests are rejected. |
| `GET /terminal/sessions` | Lists non-secret terminal session metadata for hydration. | Requires the terminal Origin boundary. |
| `POST /terminal/ticket` + `/terminal/ws` | Browser terminal PTY transport; ticket requests may include `{ sessionId }` and default to `"default"` for compatibility. | Browser receives a one-use ticket. |
| `/console/` | Static React client served from this package's `dist/client`. | Served directly from the loopback console URL. |
| `/console/codex/*` | Console-owned Codex/Fleet Wiki web, workspace API, and migrated Maritime Codex client. | Admin workspace registration uses the lock bearer token; browser reads stay token-free on allowed local origins. |

`/observer/tenants` may include `terminalSessionId` for console-owned terminal sessions. `/terminal/ws` keeps the same path and query shape.

## Session Binding

When the console creates a terminal session, it generates a session id, resolves the selected Agent CLI through the shared fleet-admiral runtime, and keeps the selected absolute cwd server-side. The console records non-secret session metadata for observer hydration.

Folder grants are one-use and in-memory. Folder picker cancellation is a normal response. Picker failures are reported with typed errors such as `unsupported_platform`, `dialog_unavailable`, `dialog_timeout`, and `invalid_folder`.

## Security Notes

HTTP surfaces are loopback-only. Browser observer routes are directly available on loopback and terminal routes retain their Origin boundary. MCP session tokens, bootstrap tokens, and selected absolute paths are not exposed through browser payloads, URL query strings, SSE frames, terminal tickets, logs, or static assets.

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
