# Fleet Console

Standalone loopback web console for observing registered Fleet CLI workspaces, carrier jobs, live output streams, and PTY terminal sessions.

## What It Does

Fleet Console owns its own local HTTP server. Fleet CLI processes register with the console when available, push ordered event batches through the CLI-only ingest API, and continue normally if the console is absent.

- Registered CLI workspaces and observed jobs in a navigable rail.
- Per-job carrier tracks with incremental output text, reasoning folds, and tool-call activity.
- Browser observer snapshots and SSE streams backed by console-owned global observed ids.
- Browser terminal access through short-lived tickets over WebSocket.

## Runtime Channels

| Channel | Purpose | Token Boundary |
|---|---|---|
| `POST /api/cli/register` | CLI registers a workspace session. | Uses the console bootstrap token from the lock file. |
| `POST /api/cli/events` | CLI pushes `{ cliRunId, seq, at, event }[]` batches. | Uses CLI-only `ingestToken`; never sent to browser code. |
| `/observer/*` | Browser snapshot and SSE observer surface. | Uses browser observer token only. |
| `/terminal/ticket` + `/terminal/ws` | Browser terminal PTY transport. | Browser receives a ticket, not the raw terminal token. |
| `/console/` | Static React client served from this package's `dist/client`. | Browser tokens are handed off once through the URL fragment. |

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
