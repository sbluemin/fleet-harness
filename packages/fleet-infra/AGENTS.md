# fleet-infra Doctrine

`packages/fleet-infra` owns Fleet's host-agnostic runtime infrastructure.

## Owns

- `auth/` — CLI auth provider mapping, storage, migration, validation, and user-facing auth messages.
- `agent/` — executor runtime engine, pool/session persistence, provider/model codec, `TrackStatus` SSoT, builtin external MCP catalog, and the two-method `ExecutorPort`.
- `data-dir/` — Fleet data directory resolution and legacy migration.
- `job/` — detached job archive, lifecycle, concurrency, cancellation, reminders, IDs, sanitization, and cache helpers.
- `log/` — runtime log store and log entry contracts.
- `settings/` — settings store, runtime singleton, and settings service.

## Public Surface

Consumers use the package root or documented subdomain barrels only:

- `@sbluemin/fleet-infra`
- `@sbluemin/fleet-infra/agent`
- `@sbluemin/fleet-infra/auth`
- `@sbluemin/fleet-infra/data-dir`
- `@sbluemin/fleet-infra/job`
- `@sbluemin/fleet-infra/log`
- `@sbluemin/fleet-infra/settings`

Do not add individual deep source-file exports without an explicit public API decision.

## Dependency Boundary

- This package must stay host-agnostic.
- It may depend on `@sbluemin/fleet-unified-agent` for shared CLI type definitions.
- It may depend on `@sbluemin/fleet-mcp-server` for generic MCP registry/server types and executor MCP routing.
- It must not import `@sbluemin/fleet-core`, `@sbluemin/fleet-agent`, host UI/runtime packages, or engine packages.
- Relative imports inside `src/` must stay within `packages/fleet-infra/src/**`.
- `ExecutorPort` has exactly two methods: `getCarrierExternalMcpServerIds` and `getExecutorMcpTools`; lookup before `bootFleetCore()` registration must hard throw.

## Tests

Infrastructure tests live in `packages/fleet-infra/tests/**`.

- Agent infrastructure tests live in `packages/fleet-infra/tests/agent/**`.
- Reset global singleton state in tests that touch agent executor ports/pools, job archive/cache/concurrency/cancel registry, settings runtime, or log store.
- Prefer package-local source imports for unit tests and public barrels when validating the exported package surface.
