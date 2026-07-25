# fleet-plans

Workspace-scoped Fleet Plan storage, deterministic Markdown validation, stable PlanRef/TaskRef identity, and Agent MCP tool specifications.

## Directory index

| Directory | Responsibility |
|---|---|
| `src/` | Plan references, linting, storage, and tool registration |
| `tests/` | Plan schema, path safety, mutation, and tool contracts |

## Constraints

- Plan files live only under the Fleet data-dir `workspaces/<workspace-ref>/plans/` boundary resolved by `core-infra`.
- `plan_write`, `plan_verify`, and `plan_mark_tasks` are host-only, and `plan_read` is the shared read surface.
- `plan_write` rejects invalid Markdown before mutation; `plan_mark_tasks` may only flip known task checkboxes after reading under the same lock.
- PlanRef and TaskRef are logical identities, never caller-supplied filesystem paths.
- `plan_verify` reports Plan-state readiness only; it never claims that implementation artifacts are correct.
