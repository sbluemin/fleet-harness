# Fleet Gateway Doctrine

`runtime/fleet-gateway` owns the machine-wide local Fleet Gateway daemon.

## Owns

- Loopback-only daemon lifecycle, lock-file discovery, health probe, tenant-aware deferred stale restart, and stop helpers.
- Fixed local MCP endpoint and local admin/control/observer HTTP surfaces.
- Loopback static serving for the embedded Fleet Console assets (built by `@dotobokuri/fleet-console` and embedded into `dist/client/` via `scripts/embed-console.mjs`, which both packages' builds invoke; it resolves fleet-console by monorepo-relative path to avoid a workspace dependency cycle).
- Tenant/session/control/observer token isolation.
- Schema-agnostic MCP pass-through routing and in-memory queues.
- In-memory observability REST/SSE state.
- Gateway-native consumer SDK protocol: `createGatewayConsumerClient`, registration, control-call SSE consumption, result/event publication, reconnect, lease tracking, duplicate-call suppression, release, and bootstrap-token lookup.

## Must Not Own

- Fleet tool builders, `AgentToolSpec.execute`, carrier persona policy, or provider-specific CLI launch logic.
- Host tool execution and registry/session shape conversion; execution must be injected through `GatewayToolExecutionPort` rather than importing Fleet or core-agent runtime types.
- The Fleet Console UI source and the console CLI launcher / browser opening (owned by `@dotobokuri/fleet-console`).
- Durable call, result, job, or event journals.
- Non-loopback or remote API serving.

## Invariants

- Shared mutable state must be constructed through `create*(deps)` factories.
- Lock directories are `0700`; lock files are `0600`; symlink lock files are rejected.
- The daemon binds only to loopback.
- Automatic stale restart only occurs when no tenants are registered; explicit restart always replaces the daemon.
- Gateway restart drops all in-memory tenants, sessions, calls, results, and observability.
- The public SDK surface remains gateway-native and must not import `@dotobokuri/core-agent`, `@dotobokuri/fleet-carriers`, `AgentToolSpec`, `McpToolRegistry`, or `ExecutorMcpSession`.

## TypeScript File Structure

All `.ts` files follow:

```text
imports -> types/interfaces -> constants -> functions
```

## Tests

- `pnpm --filter @dotobokuri/fleet-gateway test`
- `pnpm --filter @dotobokuri/fleet-gateway typecheck`
- `pnpm --filter @dotobokuri/fleet-gateway build`
