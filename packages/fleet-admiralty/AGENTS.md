# fleet-admiralty Doctrine

`packages/fleet-admiralty` owns multi-fleet coordination after the fleet-admiral split.

## Ownership

- Grand Fleet IPC protocol, runtime access, status source, reporting, tool specs, prompts, text sanitization, and shared multi-fleet types.
- The explicit `createFleetAdmiralty(deps): FleetAdmiralty` construction boundary.

## Import Boundaries

- May depend on `@sbluemin/fleet-admiral` through its public interface.
- Must not import `@sbluemin/fleet-admiral` or `@sbluemin/fleet-agent`.
- Host UI/runtime APIs must remain at the `fleet-agent` composition edge.

## Factory Discipline

- Use explicit factory functions with dependency objects.
- Do not use DI containers, service locators, hidden global registries, process-global runtime keys, or import-time self-registration.
- Runtime state must be owned by factory-created instances.

## Tests

Multi-fleet behavior tests live under `packages/fleet-admiralty/tests/**`.
