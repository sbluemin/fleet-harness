# core-infra

Host-agnostic gateways for durable Fleet infrastructure I/O.

## Directory index

| Directory | Responsibility |
|---|---|
| `src/data-dir/` | Fleet data-root resolution, migration, and global settings |
| `src/fs-store/` | Atomic, locked, permission-safe filesystem primitives |
| `src/workspace-dir/` | cwd-keyed durable workspace directory resolution and identity |
| `tests/` | Infrastructure and security contracts |

## Constraints

- This is the bottom durable-I/O layer; it owns no Admiral, host, provider, or UI policy. Provider credentials are a worked example: the durable mechanism that stores them is `src/fs-store/`, while the file's identity, its provider-id namespace, and the key-validation wire belong to `core-ai-gateway`. A secret this package could not name is a secret it must not own.
- Durable writes preserve atomic replacement, advisory locking, symlink guards, traversal defense, and secure modes as one shared contract.
- Data-root resolution is self-contained; caller overrides and the `FLEET_DATA_DIR` environment override are for isolation, not a second production policy. `FLEET_DATA_DIR` moves the whole root — credentials, global settings, gateway selection, workspaces — and must stay absolute-or-throw, because a silently ignored value writes an isolated run into the real user root. A store built on these primitives resolves its path when it is constructed, never at module load: a path frozen at import time is decided before an isolated run can state its root, and that run then reads and overwrites the real user's file.
