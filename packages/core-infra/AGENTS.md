# core-infra Doctrine

`packages/core-infra` owns Fleet's host-agnostic infrastructure I/O services.

## Owns

- `auth/` — generic auth storage and Anthropic-compatible validation helpers. No active CLI provider mapping is defined here.
- `data-dir/` — Fleet data directory resolution and legacy migration.
- `data-dir/settings/` — host-agnostic global option I/O for Fleet startup behavior.
- `fs-store/` — generic durable filesystem I/O primitive: atomic writes (temp+rename+fsync), advisory directory locks with quarantine-based stale recovery, secure directory/file modes, symlink guards, and path-traversal defenses. Consumed by data-dir/settings, auth, and carriers storage via explicit DI.

## I/O Gateway Contract

`core-infra` is the bottom layer of the DI graph for durable Fleet infrastructure storage and auth/data-dir resolution.

- The DI layer order is one-way: `fleet-cli` -> `fleet-admiral` -> `fleet-carriers` -> `core-infra` for infrastructure services.
- `createInfraServices(deps)` is the public construction boundary for infrastructure services.
- Filesystem storage, auth storage, data-dir resolution, and global-options persistence belong here.
- Higher layers must receive infra capabilities as explicit dependencies; `core-infra` must not look up host, carrier, or admiral services.
- Keep Fleet-domain policy out of this package. It provides gateways and durable runtime primitives, not carrier persona, admiral policy, or host UI behavior.
- data-dir path resolution is self-contained: `getFleetDataDir()` is called directly by admiral/carriers. The `dataDir` optional override is for test isolation only.

## Public Surface

Consumers use the package root or documented subdomain barrels only:

- `@dotobokuri/core-infra`
- `@dotobokuri/core-infra/auth`
- `@dotobokuri/core-infra/data-dir`
- `@dotobokuri/core-infra/data-dir/settings`
- `@dotobokuri/core-infra/fs-store`

Do not add individual deep source-file exports without an explicit public API decision.

## Dependency Boundary

- This package must stay host-agnostic.
- It may depend on `@dotobokuri/core-unified-agent` only when an infrastructure primitive genuinely needs shared CLI type definitions or the CLI provider catalog (`CLI_BACKENDS`).
- It must not import `@dotobokuri/fleet-*` packages (fleet-cli, fleet-carriers, host UI/runtime packages, or engine packages).
- Relative imports inside `src/` must stay within `packages/core-infra/src/**`.

## Tests

Infrastructure tests live in `packages/core-infra/tests/**`.

- Prefer package-local source imports for unit tests and public barrels when validating the exported package surface.
