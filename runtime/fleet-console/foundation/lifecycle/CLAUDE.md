# Lifecycle (@fleet-console/lifecycle)

The observation and IO half of the single Console process lifecycle contract (`docs/console-lifecycle-contract.md`); the pure half is `@fleet-console/protocol/lifecycle`.

## Constraints

- Leaf foundation package: depends only on `@fleet-console/protocol` and Node built-ins. Console, the CLI, Desktop, and the update worker bundle may each carry a copy, so never coordinate through module-scoped state.
- Actors choose policy (how long to wait, whether to act); judgments about pid liveness, lock and instance state, and exit records live here once. Never reimplement them in a consumer.
- Only ESRCH means a pid is gone. Never signal a process or remove a file on evidence this package cannot prove.
