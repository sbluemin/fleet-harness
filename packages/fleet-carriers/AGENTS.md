# fleet-carriers Doctrine

`packages/fleet-carriers` owns Fleet's default carrier persona catalog and carrier runtime implementation.

## Owns

- Default carrier persona metadata under `src/personas/`
- Carrier runtime constants under `src/constants.ts`
- `dispatch/` — carrier framework, `carrier_dispatch`, Task Force auto-promotion, request-block validation, status overlay, and sortie helpers
- `jobs/` — `carrier_jobs` lookup/control tool surface and prompt/schema contract
- `store/` — `states.json` carrier runtime persistence with `state-io.ts` as the single file-I/O and lock/update gate
- `events/` — carrier job stream event types and Set-based handler registry
- Explicit default carrier registration via `registerDefaultCarriers()`
- Package-local tests for persona data, runtime registration, store reset, stream reset, and framework reset behavior

## Must Not Own

- Host runtime wiring, message renderers, UI components, or host adapters
- `fleet-core` protocol/admiralty policy implementation
- `packages/fleet-infra/src/job/`; detached job infrastructure stays in `fleet-infra`

## Dependency Rules

- This package may import `@sbluemin/fleet-infra`, `@sbluemin/fleet-mcp-server`, `@sbluemin/fleet-unified-agent`, and `typebox`.
- This package MUST NOT import `@sbluemin/fleet-core` or `packages/fleet-core/src/**`.
- `fleet-core` may depend on this package only through the public package root for compatibility facades.
- Personas may declare executor tool IDs and builtin external MCP server IDs as opaque strings without importing host/UI/wiki packages.

## Testing Doctrine

- Use `clearRegisteredCarriers()` / `resetCarrierRegistryForTests()` for dispatch framework isolation.
- Use `clearStreamHandlers()` for event registry isolation.
- Use `resetStoreForTests()` plus `initStore(tempDir)` for store isolation.

## TypeScript File Structure

All `.ts` files must follow:

```text
imports -> types/interfaces -> constants -> functions
```
