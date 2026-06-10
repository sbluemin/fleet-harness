# fleet-infra Doctrine

`packages/fleet-infra` owns Fleet's host-agnostic infrastructure I/O services.

## Owns

- `auth/` — CLI auth provider mapping, storage, migration, validation, and user-facing auth messages.
- `data-dir/` — Fleet data directory resolution and legacy migration.
- `global-options/` — host-agnostic global option I/O for Fleet startup behavior.
- `fs-store/` — generic durable filesystem I/O primitive: atomic writes (temp+rename+fsync), advisory directory locks with quarantine-based stale recovery, secure directory/file modes, symlink guards, and path-traversal defenses. Consumed by global-options, auth, and carriers storage via explicit DI.

## I/O Gateway Contract

`fleet-infra` is the bottom layer of the DI graph for durable Fleet infrastructure storage and auth/data-dir resolution.

- The DI layer order is one-way: `fleet-cli` -> `fleet-admiral` -> `fleet-carriers` -> `fleet-infra` for infrastructure services.
- `createInfraServices(deps)` is the public construction boundary for infrastructure services.
- Filesystem storage, auth storage, data-dir resolution, and global-options persistence belong here.
- Higher layers must receive infra capabilities as explicit dependencies; `fleet-infra` must not look up host, carrier, or admiral services.
- Keep Fleet-domain policy out of this package. It provides gateways and durable runtime primitives, not carrier persona, admiral policy, or host UI behavior.

## Public Surface

Consumers use the package root or documented subdomain barrels only:

- `@dotobokuri/fleet-infra`
- `@dotobokuri/fleet-infra/auth`
- `@dotobokuri/fleet-infra/data-dir`
- `@dotobokuri/fleet-infra/global-options`
- `@dotobokuri/fleet-infra/fs-store`

Do not add individual deep source-file exports without an explicit public API decision.

## Dependency Boundary

- This package must stay host-agnostic.
- It may depend on `@dotobokuri/core-unified-agent` for shared CLI type definitions and the CLI provider catalog (`CLI_BACKENDS`), the SSoT from which auth provider env/baseUrl values are derived.
- It must not import `@dotobokuri/fleet-cli`, `fleet-carriers`, host UI/runtime packages, or engine packages.
- Relative imports inside `src/` must stay within `packages/fleet-infra/src/**`.

## Tests

Infrastructure tests live in `packages/fleet-infra/tests/**`.

- Prefer package-local source imports for unit tests and public barrels when validating the exported package surface.
