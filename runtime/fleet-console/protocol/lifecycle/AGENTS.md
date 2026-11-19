# Lifecycle Protocol

`@fleet-console/protocol/lifecycle` is the pure half of the single Console process lifecycle contract (`docs/console-lifecycle-contract.md`): lifecycle states, time budgets, the exit record schema, and lock-slot classification shared by Console, the CLI, Desktop, and the update worker.

## Constraints

- Contract only: types, constants, and stateless helpers over caller-supplied inputs. No filesystem, process, or network access; observation and IO belong to `@fleet-console/lifecycle`.
- Import nothing from Console core, Desktop, plugins, or `@dotobokuri/*`. Shipped Desktop builds and update workers carry frozen copies, so a change to a state, budget relation, or record field is a wire revision (`CONSOLE_LIFECYCLE_WIRE`), not a refactor; extend additively.
- Every actor derives its waits from the budget constants here; never restate a value elsewhere.
