# fleet-carriers Doctrine

`packages/fleet-carriers` is a leaf workspace package that owns Fleet's default carrier persona catalog, persona metadata, default persona registration helper, and carrier-framework self-registration.

## Owns

- Default carrier persona metadata under `src/personas/`
- Persona-only constants under `src/constants.ts`
- Self-registration into the `@sbluemin/fleet-core` carrier facade via `src/agent-specs.ts`
- Package-local tests for default persona data and self-registration behavior
- Explicit default persona executor access: all 8 personas must explicitly list `carrier_jobs` in `allowedExecutorTools`.
- Explicit default persona `<prior_jobs?>` request blocks: all 8 personas must explicitly append `PRIOR_JOBS_REQUEST_BLOCK` to `requestBlocks`.
- Chronicle's opaque `allowedExecutorTools` metadata for chronicle-exclusive wiki tools. Four pure read-only wiki tools are registered globally and available to all carriers.

## Must Not Own

- Carrier framework, dispatch, roster rendering, request-block validation, status overlays, or execution logic
- Host runtime wiring, message renderers, UI components, or host adapters
- Imports of host packages, engines, `fleet-agent`, `fleet-wiki`, or sibling workspace packages

## Dependency Rules

- This package may import only `@sbluemin/fleet-core` from the workspace, and only through its public package root.
- Deep imports such as `@sbluemin/fleet-core/src/**` are forbidden.
- Reverse dependencies from `fleet-core` back to `fleet-carriers` are forbidden.
- Module-load self-registration must stay side-effect-only and host-agnostic; renderer registration belongs in `fleet-agent`.
- Personas may declare executor tool IDs as strings in `allowedExecutorTools`, but this package must not import the wiki package or its agent-tool ID aggregate.

## TypeScript File Structure

All `.ts` files must follow:

```text
imports -> types/interfaces -> constants -> functions
```
