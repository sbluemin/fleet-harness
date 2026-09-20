# core-infra

Host-agnostic gateways for durable Fleet infrastructure I/O.

## Directory index

| Directory | Responsibility |
|---|---|
| `src/agent-options/` | Shared Agent execution-policy schema (no storage of its own) |
| `src/data-dir/` | Fleet data-root resolution |
| `src/fs-store/` | Atomic, locked, permission-safe filesystem primitives |
| `src/workspace-dir/` | cwd-keyed durable workspace directory resolution and identity |
| `tests/` | Infrastructure and security contracts |

## Constraints

- This is the bottom durable-I/O layer; it owns no Admiral, host, provider, or UI policy. Provider credentials are a worked example: the durable mechanism that stores them is `src/fs-store/`, while the file's identity, its provider-id namespace, and the key-validation wire belong to `core-ai-gateway`. A secret this package could not name is a secret it must not own.
- Durable writes preserve atomic replacement, advisory locking, symlink guards, traversal defense, and secure modes as one shared contract.
- Data-root resolution is self-contained; caller overrides and the `FLEET_DATA_DIR` environment override are for isolation, not a second production policy. `FLEET_DATA_DIR` moves the whole root and must stay absolute-or-throw, because a silently ignored value writes an isolated run into the real user root.
- A store built on these primitives takes the directory it writes to; it never resolves one itself, not even as a fallback for a caller that omitted it. A default is worse than a missing argument: it compiles, it never fails a test, and the run that forgot to state its slot quietly reads and overwrites another one's file — including credentials and the permission-gate toggle. Requiring the directory makes that a type error instead.
- `createStoreCarryOver` owns moving a value from a previous location exactly once. Completion is the destination's existence, never emptiness, so a user who cleared a setting does not get the old value resurrected; and while a previous file cannot be read the caller must refuse to write, because the first write to the destination ends the migration and strands whatever was not read.
