# fleet-admiral Doctrine

`packages/fleet-admiral` owns single-fleet orchestration after the fleet-admiral split.

## Ownership

- Agent tool facades, bootstrap helpers, and executor-facing orchestration.
- Admiral protocols, standing orders, MCP lifecycle facade, prompt policy, and constants.
- The explicit `createFleetAdmiral(deps): FleetAdmiral` construction boundary.

## Import Boundaries

- Allowed Fleet dependencies: `@sbluemin/fleet-carriers`, `@sbluemin/fleet-infra`, and `@sbluemin/fleet-mcp-server`.
- Must not import `@sbluemin/fleet-admiral`, `@sbluemin/fleet-agent`, or `@sbluemin/fleet-admiralty`.
- Host UI, PTY, and concrete runtime assembly belong in `fleet-agent`.

## Factory Discipline

- Use explicit factory functions with dependency objects.
- Do not use DI containers, service locators, hidden global registries, or import-time self-registration.
- Default boot or registration work must be exposed as explicit methods returned by the factory.

## Tests

Single-fleet behavior tests live under `packages/fleet-admiral/tests/**`.
