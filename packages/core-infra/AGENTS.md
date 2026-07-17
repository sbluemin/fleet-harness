# core-infra

Host-agnostic gateways for durable Fleet infrastructure I/O.

## Directory index

| Directory | Responsibility |
|---|---|
| `src/auth/` | Credential storage and Anthropic-compatible validation |
| `src/data-dir/` | Fleet data-root resolution, migration, and global settings |
| `src/fs-store/` | Atomic, locked, permission-safe filesystem primitives |
| `src/workspace-dir/` | cwd-keyed durable workspace directory resolution and identity |
| `tests/` | Infrastructure and security contracts |

## Constraints

- This is the bottom durable-I/O layer; it owns no Carrier, Admiral, host, or UI policy.
- Durable writes preserve atomic replacement, advisory locking, symlink guards, traversal defense, and secure modes as one shared contract.
- Data-root resolution is self-contained; caller overrides are for isolation, not a second production policy.
