# Fleet Gateway Doctrine

`runtime/fleet-gateway` owns the machine-wide local Fleet Gateway daemon.

## Owns

- Loopback-only daemon lifecycle, lock-file discovery, health probe, tenant-aware deferred stale restart, and stop helpers.
- Fixed local MCP endpoint and local admin/control/observer HTTP surfaces.
- Tenant/session/control/observer token isolation.
- Schema-agnostic MCP pass-through routing and in-memory queues.
- In-memory observability REST/SSE state.

## Must Not Own

- Fleet tool builders, `AgentToolSpec.execute`, carrier persona policy, or provider-specific CLI launch logic.
- Durable call, result, job, or event journals.
- Non-loopback or remote API serving.

## Invariants

- Shared mutable state must be constructed through `create*(deps)` factories.
- Lock directories are `0700`; lock files are `0600`; symlink lock files are rejected.
- The daemon binds only to loopback.
- Automatic stale restart only occurs when no tenants are registered; explicit restart always replaces the daemon.
- Gateway restart drops all in-memory tenants, sessions, calls, results, and observability.

## TypeScript File Structure

All `.ts` files follow:

```text
imports -> types/interfaces -> constants -> functions
```

## Tests

- `pnpm --filter @dotobokuri/fleet-gateway test`
- `pnpm --filter @dotobokuri/fleet-gateway build`
