# Desktop Protocol

`@fleet-console/desktop-protocol` is the source-only shared contract between Fleet Console and Fleet Desktop: protocol version, owner metadata, control env names, resource-root marker format, and canonical Console path resolution.

## Constraints

- Contract only: types, constants, and stateless helpers over caller-supplied inputs. No filesystem, process spawning, or Electron access; resource-root and ownership validation stays in Console host.
- Import nothing from Console core, Desktop, plugins, or `@dotobokuri/*`; both hosts bundle this package and consume its declared exports only.
- Exports are a live published protocol for independently versioned shipped shells: changing version-1 semantics, env names, marker format, or canonical paths is a protocol revision, not a refactor.
