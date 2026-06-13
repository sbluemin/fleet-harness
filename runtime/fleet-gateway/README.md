# Fleet Gateway

Machine-wide local gateway daemon for Fleet MCP and observability traffic.

## What it does

The gateway replaces per-instance MCP servers with a single local daemon that runs on a fixed loopback endpoint. It provides schema-agnostic MCP pass-through routing, per-session tenant token isolation, an in-memory call queue, and loopback serving of the Fleet Console for local observability. The Fleet Console UI and its CLI launcher are owned by the `@dotobokuri/fleet-console` package; its build output is embedded into the gateway's `dist/client/` at build time and served under `/console/`. Observer tokens grant read-only access to daemon health, tenant state, job snapshots, and event timelines without permitting MCP calls.

## Scope

**Owns**

- Loopback-only daemon lifecycle, lock-file discovery, health probe, stale restart, and stop helpers.
- Fixed local MCP endpoint and local admin/control/observer HTTP surfaces.
- Loopback static serving for the embedded Fleet Console assets (built by `@dotobokuri/fleet-console` and copied into `dist/client/` at build time).
- Tenant/session/control/observer token isolation.
- Schema-agnostic MCP pass-through routing and in-memory queues.
- In-memory observability REST/SSE state.

**Must not own**

- Fleet tool builders, agent execution logic, carrier persona policy, or provider-specific CLI launch logic.
- Durable call, result, job, or event journals.
- Non-loopback or remote API serving.

## Security model

- The daemon binds only to the loopback interface.
- Lock directories are created with mode `0700`; lock files with mode `0600`. Symlink lock files are rejected.
- Tenant tokens isolate sessions. Control tokens expose admin surfaces. Per-tenant observer tokens expose only that tenant's read-only status, jobs, and events.
- The lock file includes an aggregate observer token for the local Fleet Console. It can list tenants and read aggregate `/observer/jobs` and `/observer/events`, but cannot register tenants, release tenants, issue MCP calls, post control events/results, or read call/result payloads.
- Static console responses and observer responses use no-store security headers and a same-origin CSP. The Fleet Console is served only from the existing loopback daemon under `/console/`.
- Carrier output text in observability events is retained in memory, clamped to a per-event cap of 8,192 characters; text-bearing events also expose the original length as metadata. Memory use is bounded by the per-event cap combined with the existing tenant/job event limits, and exposure is bounded by the loopback-only daemon and observer token gating.
- All call state and observability data are in-memory. Restarting the gateway drops all tenants, sessions, calls, results, job snapshots, and event timelines.

## Using the gateway

- Start: the Fleet CLI composition root starts the gateway automatically when launching a session.
- Stop: `fleet-gateway stop` or send a stop request through the admin surface.
- Restart: a stale or unhealthy daemon is detected by lock-file probing and restarted automatically.
- Console: run `fleet console` (or the standalone `fleet-console` binary, owned by `@dotobokuri/fleet-console`) to ensure the daemon and open `http://127.0.0.1:<port>/console/`. The launcher passes the aggregate observer token once through the URL fragment; the browser client immediately moves it to `sessionStorage` and removes the fragment from the address bar. Tokens are never passed in query strings.
- Tenant observer workflow: use the per-tenant observer token returned from registration to inspect `/observer/status`, `/observer/jobs`, or `/observer/events` for that tenant only.
- Aggregate observer workflow: use the lock-file aggregate observer token for `GET /observer/tenants`, aggregate `GET /observer/jobs`, `GET /observer/jobs?tenant=<tenantId>`, and all-tenant `GET /observer/events` SSE.

## Package shape

The source manifest keeps `private: true`; publishing is performed by CI or an Admiral-authorized release path through `scripts/publish-fleet-gateway.mjs`, which temporarily removes `private`, empties runtime dependencies for the packed artifact, and restores the original manifest in `finally`.

- Binary: `fleet-gateway` resolves to `dist/cli-bin.mjs`.
- Library CLI entry: `./cli` exposes `dist/cli.mjs` with declarations and no direct-run side effects.
- Root API: `.` exposes `createGatewayDaemonLifecycle`, `createGatewayConsumerClient`, and gateway-native public protocol types only.
- Binary export: `./cli-bin` exposes the executable entry without declarations.
- Embedded console assets are required: `dist/client/index.html` must exist before publish or the publish helper fails hard.
- Dry-run verification: run `pnpm --filter @dotobokuri/fleet-console build`, `pnpm --filter @dotobokuri/fleet-gateway build`, then `npm pack --dry-run` from `runtime/fleet-gateway` and confirm `dist/client/index.html`, `dist/cli-bin.mjs`, `dist/cli.mjs`, `dist/index.mjs`, and `dist/server.mjs` are listed.

## Consumer SDK

Fleet CLI consumes the gateway through `createGatewayConsumerClient(deps)`. Gateway owns endpoint assembly, daemon ensure, bootstrap-token lookup, tenant registration, control-call SSE consumption, result/event publication, reconnect, lease tracking, duplicate-call suppression, and release. Fleet tool execution stays host-injected through `GatewayToolExecutionPort`, so this package does not import Fleet tool builders, carrier runtime types, or core-agent registry/session shapes.

## Observability model

- `/observer/tenants` returns tenant id, label, cwd, creation time, and session count without session/control tokens.
- `/observer/jobs` returns in-memory job snapshots keyed by job id. The job list does not depend solely on retained event replay, so active and recent finalized jobs remain visible after event truncation.
- Finalized job snapshots are retained per tenant for the most recent 100 finalized jobs. Active jobs remain visible.
- Tenant event timelines retain the most recent 1,000 events and expose truncation metadata when older events are dropped.
- `/observer/events` is SSE. The Fleet Console client uses `fetch` with `ReadableStream` and `Authorization: Bearer`; it does not use `EventSource`.

## TypeScript conventions

All `.ts` files follow the Fleet declaration order:

```text
imports -> types/interfaces -> constants -> functions
```

## Tests

```bash
pnpm --filter @dotobokuri/fleet-gateway test
pnpm --filter @dotobokuri/fleet-gateway typecheck
pnpm --filter @dotobokuri/fleet-gateway build
```
