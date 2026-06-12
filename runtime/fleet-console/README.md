# Fleet Console

Web surface for observing Fleet Gateway tenants, carrier jobs, and live output streams.

## What it does

Fleet Console is the operator-facing GUI for the machine-wide Fleet Gateway daemon. It connects to the gateway's read-only observer surface and renders:

- Connected workspaces (tenants) and their observed jobs in a navigable rail.
- Per-job carrier tracks with smooth, incremental streaming of output text, reasoning folds, and inline tool-call activity.
- Job lifecycle state (running / done / error / aborted), finalize summaries, and a raw event timeline for debugging.

The console is the seed of the unified Fleet GUI and is expected to absorb additional surfaces over time.

## How it is served

The package builds a static React SPA (`client/` → `dist/client/`, base path `/console/`) and a CLI launcher (`src/cli.ts` → `dist/cli.mjs`, binary `fleet-console`). The SPA output is embedded into the Fleet Gateway's `dist/client/` at build time and served **loopback-only** under `http://127.0.0.1:<port>/console/`.

Open it with:

```bash
fleet console        # via fleet-cli (relays to this package's CLI)
fleet-console        # standalone binary
```

The launcher ensures the gateway daemon is running (via the `@dotobokuri/fleet-gateway` lifecycle API) and opens the browser with the aggregate observer token passed once through the URL fragment. The client immediately moves the token to `sessionStorage` and strips it from the address bar. Tokens never travel in query strings.

## Architecture

| Piece | Role |
|-------|------|
| `src/cli.ts` | `fleet-console` CLI launcher: ensures the gateway daemon and opens the console in a browser. |
| `client/src/reduce.ts` | Pure event reducer: folds gateway observability events into per-job/per-track view models. Text events are deltas and accumulate. |
| `client/src/store.ts` | Framework-agnostic external store (snapshots, live events, selection), bridged to React via `useSyncExternalStore`. |
| `client/src/connection.ts` | Connection loop: snapshot resync → SSE consume → exponential-backoff reconnect. |
| `client/src/sse.ts` | Incremental SSE frame parser + observer frame interpretation (aggregate and tenant-scoped shapes). |
| `client/src/components/` | Topbar, workspace/job rail, job stage, streaming track cards, event timeline. |
| `client/src/styles/` | Three layers: `theme.css` tokens, `layout.css` shell grid, `components.css` surfaces. |

## Development

```bash
pnpm --filter @dotobokuri/fleet-console dev        # Vite dev server (UI shell only; observer API needs a running gateway)
pnpm --filter @dotobokuri/fleet-console test       # vitest (reducer / SSE / store / CLI)
pnpm --filter @dotobokuri/fleet-console typecheck
pnpm --filter @dotobokuri/fleet-console build      # emits dist/cli.mjs + dist/client, then pushes the gateway embed
```

See `AGENTS.md` for the design doctrine and streaming invariants.
