# fleet-carriers

Default Carrier personas and the complete Carrier dispatch, job, and state runtime.

## Directory index

| Directory | Responsibility |
|---|---|
| `src/personas/` | Default Carrier catalog |
| `src/dispatch/` | Delegation, Task Force execution, and stream events |
| `src/jobs/` | Detached job lifecycle and archive |
| `src/store/` | Carrier overrides and resolved snapshots |
| `tests/` | Persona, dispatch, job, and store contracts |

## Constraints

- This package owns Carrier runtime and defaults, not host UI, host lifecycle, or Admiral protocol policy.
- Callers construct one Carrier runtime; they must not independently assemble its dispatch, jobs, stream, and store internals.
- Dependencies point only toward core capabilities. Do not import Admiral or runtime host packages.
- Persistent state stores operator overrides; defaults and healing are applied when building the resolved read model.
- `carrier_dispatch` is the sole Carrier delegation surface and executes through the callback executor path; do not add a parallel orchestration API.
- Carrier execution runs one fresh CLI process per dispatch. Successful launches return a process-local `context_id`; callers may pass it back as `resume_context_id` to resume the provider session. Mappings are bounded, metadata-only (provider session ids, never a live client/process), and never serialized through the store, job archive, settings, or any durable file.
- Carrier execution has one CLI-dispatch path; persisted legacy mode fields are ignored.
- Persona tool and MCP identifiers are opaque values and must not create dependencies on the packages that implement them.
