# Fleet Console

Standalone loopback web console for observing registered Fleet CLI workspaces, carrier jobs, live output streams, and multi-session PTY terminal workspaces.

## What It Does

Fleet Console owns its own local HTTP server. Fleet CLI processes register with the console when available, push ordered event batches through the CLI-only ingest API, and continue normally if the console is absent.

- Registered CLI workspaces and observed jobs in a navigable rail.
- Workspace hub sessions created from OS-native folder selection.
- Console-spawned `fleet-cli --native` PTYs with deterministic registration binding.
- Per-job carrier tracks with incremental output text, reasoning folds, and tool-call activity.
- Browser observer snapshots and SSE streams backed by console-owned global observed ids.
- Browser terminal access through short-lived tickets over WebSocket.

## Runtime Channels

| Channel | Purpose | Token Boundary |
|---|---|---|
| `POST /api/cli/register` | CLI registers a workspace session. | Uses the console bootstrap token from the lock file. |
| `POST /api/cli/events` | CLI pushes `{ cliRunId, seq, at, event }[]` batches. | Uses CLI-only `ingestToken`; never sent to browser code. |
| `/observer/*` | Browser snapshot and SSE observer surface. | Uses browser observer token only. |
| `POST /terminal/folders/pick` | Opens a native folder picker and returns a one-use folder grant, or `{ cancelled: true }`. | Uses the browser terminal token; selected paths are kept server-side. |
| `POST /terminal/sessions` | Consumes `{ folderGrantId }` to create a console-spawned `fleet-cli --native` PTY session. | Raw cwd values from browser requests are rejected. |
| `GET /terminal/sessions` | Lists non-secret terminal session metadata for hydration. | Uses the browser terminal token. |
| `POST /terminal/ticket` + `/terminal/ws` | Browser terminal PTY transport; ticket requests may include `{ sessionId }` and default to `"default"` for compatibility. | Browser receives a ticket, not the raw terminal token. |
| `/console/` | Static React client served from this package's `dist/client`. | Browser tokens are handed off once through the URL fragment. |

`/observer/tenants` may include `terminalSessionId` when a registered CLI workspace is deterministically bound to a console-spawned terminal session. `/terminal/ws` keeps the same path and query shape.

## Session Binding

When the console creates a terminal session, it generates a session id and launches `fleet-cli --native` with `FLEET_CONSOLE_SESSION_ID`, `INIT_CWD`, and `PWD` set to the selected absolute cwd. Fleet CLI uses that session id as `cliRunId` unless an explicit `cliRunId` was provided. The console binds registration metadata to a pending terminal session only when `cliRunId === sessionId` and the canonical cwd matches. It does not use pid matching or cwd/time proximity fallback.

Folder grants are one-use and in-memory. Folder picker cancellation is a normal response. Picker failures are reported with typed errors such as `unsupported_platform`, `dialog_unavailable`, `dialog_timeout`, and `invalid_folder`.

## Security Notes

All HTTP surfaces are loopback-only and protected by the existing bearer tokens. Browser code receives only observer/terminal browser tokens and non-secret session metadata. CLI `ingestToken`, MCP session tokens, bootstrap tokens, and selected absolute paths are not exposed through browser payloads, URL query strings, SSE frames, terminal tickets, logs, or static assets.

## Usage

```bash
fleet console        # via fleet-cli
fleet-console        # standalone binary
fleet-console status
fleet-console stop
```

The launcher ensures the local console server is running and opens `/console/` with observer and terminal browser tokens in the URL fragment. The client moves them to `sessionStorage` and strips the fragment from the address bar.

## Development

```bash
pnpm --filter @dotobokuri/fleet-console dev
pnpm --filter @dotobokuri/fleet-console test
pnpm --filter @dotobokuri/fleet-console typecheck
pnpm --filter @dotobokuri/fleet-console build
```

`build` emits `dist/cli.mjs` and `dist/client/`. There is no external embed step.

See `AGENTS.md` for ownership, token-boundary, and streaming invariants.
