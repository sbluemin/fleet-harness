# fleet-infra Doctrine

`packages/fleet-infra` owns Fleet's host-agnostic runtime infrastructure and I/O gateway services.

## Owns

- `auth/` — CLI auth provider mapping, storage, migration, validation, and user-facing auth messages.
- `agent/` — executor runtime engine, in-memory client pool, provider/model codec, `TrackStatus` SSoT, builtin external MCP catalog, and the two-method `ExecutorPort`.
- `data-dir/` — Fleet data directory resolution and legacy migration.
- `preset/` — host-agnostic user preset I/O for CLI startup defaults.

## I/O Gateway Contract

`fleet-infra` is the bottom layer of the DI graph and the only package in the carrier runtime chain that may own generic runtime I/O gateways.

- The DI layer order is one-way: `fleet-cli` -> `fleet-admiral` -> `fleet-carriers` -> `fleet-infra`.
- `createInfraServices(deps)` is the public construction boundary for infrastructure services.
- Filesystem, auth storage, data-dir resolution, in-process executor pool infrastructure, and generic MCP routing belong here.
- Higher layers must receive infra capabilities as explicit dependencies; `fleet-infra` must not look up host, carrier, or admiral services.
- Keep Fleet-domain policy out of this package. It provides gateways and durable runtime primitives, not carrier persona, admiral policy, or host UI behavior.

## Public Surface

Consumers use the package root or documented subdomain barrels only:

- `@dotobokuri/fleet-infra`
- `@dotobokuri/fleet-infra/agent`
- `@dotobokuri/fleet-infra/auth`
- `@dotobokuri/fleet-infra/data-dir`
- `@dotobokuri/fleet-infra/preset`

Do not add individual deep source-file exports without an explicit public API decision.

## Dependency Boundary

- This package must stay host-agnostic.
- It may depend on `@dotobokuri/fleet-unified-agent` for shared CLI type definitions.
- It may depend on `@dotobokuri/fleet-mcp-server` for generic MCP registry/server types and executor MCP routing.
- It must not import `@dotobokuri/fleet-cli`, `fleet-carriers`, host UI/runtime packages, or engine packages.
- Relative imports inside `src/` must stay within `packages/fleet-infra/src/**`.
- `ExecutorPort` has exactly two methods: `getCarrierExternalMcpServerIds` and `getExecutorMcpTools`; lookup before fleet-cli Composition Root registration must hard throw.

## Tests

Infrastructure tests live in `packages/fleet-infra/tests/**`.

- Agent infrastructure tests live in `packages/fleet-infra/tests/agent/**`.
- Reset global singleton state in tests that touch agent executor ports/pools.
- Prefer package-local source imports for unit tests and public barrels when validating the exported package surface.
