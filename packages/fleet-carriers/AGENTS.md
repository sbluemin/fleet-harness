# fleet-carriers Doctrine

`packages/fleet-carriers` owns Fleet's default carrier persona catalog and the full carrier runtime implementation.

## Owns

- Default carrier persona metadata under `src/personas/`
- Carrier runtime constants under `src/constants.ts`
- Carrier runtime construction through `createCarrierRuntime(deps)`
- `dispatch/` — carrier framework, `carrier_dispatch`, Task Force auto-promotion, request-block validation, status overlay, and sortie helpers
- `job/` — detached job archive, lifecycle, concurrency, cancellation, reminders, IDs, sanitization, and cache helpers
- `jobs/` — `carrier_jobs` lookup/control tool surface and prompt/schema contract
- `store/` — `states.json` carrier runtime persistence with `state-io.ts` as the single file-I/O and lock/update gate
- `events/` — carrier job stream event types and Set-based handler registry
- Explicit default carrier registration via `registerDefaultCarriers()`
- Package-local tests for persona data, runtime registration, store reset, stream reset, and framework reset behavior

## Must Not Own

- Host runtime wiring, message renderers, UI components, or host adapters
- `fleet-admiral` protocol policy implementation
- Raw filesystem, process, network, or settings I/O beyond carrier-owned state-store gates

## Dependency Rules

- The DI layer order is one-way: `fleet-cli` -> `fleet-carriers` -> `fleet-infra`.
- This package sits above `fleet-infra`; it must expose carrier runtime services upward and consume infrastructure services downward through explicit dependencies.
- `createCarrierRuntime(deps)` is the public construction boundary for carrier runtime services. Do not require callers to assemble dispatch/jobs/store/events internals independently.
- This package may import `@dotobokuri/fleet-infra`, `@dotobokuri/fleet-mcp-server`, `@dotobokuri/fleet-unified-agent`, and `typebox`.
- This package MUST NOT import `fleet-cli`, host UI/runtime packages, or host adapters.
- Personas may declare executor tool IDs and builtin external MCP server IDs as opaque strings without importing host/UI/wiki packages.

## Testing Doctrine

- Use `clearRegisteredCarriers()` / `resetCarrierRegistryForTests()` for dispatch framework isolation.
- Unregister stream event handlers returned from `registerStreamHandler()` for event registry isolation.
- Use `resetStoreForTests()` plus `initStore(tempDir)` for store isolation.

## TypeScript File Structure

All `.ts` files must follow:

```text
imports -> types/interfaces -> constants -> functions
```
