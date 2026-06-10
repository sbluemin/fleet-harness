# Fleet Gateway

Machine-wide local gateway daemon for Fleet MCP and observability traffic.

## What it does

The gateway replaces per-instance MCP servers with a single local daemon that runs on a fixed loopback endpoint. It provides schema-agnostic MCP pass-through routing, per-session tenant token isolation, and an in-memory call queue. A separate observer token grants read-only access to daemon health and tenant state without permitting MCP calls.

## Scope

**Owns**

- Loopback-only daemon lifecycle, lock-file discovery, health probe, stale restart, and stop helpers.
- Fixed local MCP endpoint and local admin/control/observer HTTP surfaces.
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
- Tenant tokens isolate sessions. Control tokens expose admin surfaces. Observer tokens expose read-only health and tenant metadata but cannot issue MCP calls.
- All call state and observability data are in-memory. Restarting the gateway drops all tenants, sessions, calls, results, and observability state.

## Using the gateway

- Start: the Fleet CLI composition root starts the gateway automatically when launching a session.
- Stop: `fleet gateway stop` or send a stop request through the admin surface.
- Restart: a stale or unhealthy daemon is detected by lock-file probing and restarted automatically.
- Observer workflow: request an observer token through the control surface to inspect health and tenant count without affecting runtime traffic.

## TypeScript conventions

All `.ts` files follow the Fleet declaration order:

```text
imports -> types/interfaces -> constants -> functions
```

## Tests

```bash
pnpm --filter @dotobokuri/fleet-gateway test
pnpm --filter @dotobokuri/fleet-gateway build
```
