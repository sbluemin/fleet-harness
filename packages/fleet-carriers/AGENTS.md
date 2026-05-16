# fleet-carriers Doctrine

`packages/fleet-carriers` is a leaf workspace package that owns Fleet's default carrier persona catalog, persona metadata, default persona registration helper, and carrier-framework self-registration.

## Owns

- Default carrier persona metadata under `src/personas/`
- Persona-only constants under `src/constants.ts`
- Self-registration into the `@sbluemin/fleet-core` carrier facade via `src/agent-specs.ts`
- Package-local tests for default persona data and self-registration behavior

## Must Not Own

- Carrier framework, dispatch, roster rendering, request-block validation, status overlays, or execution logic
- Pi runtime wiring, message renderers, UI components, or host adapters
- Imports of Pi packages, engines, `fleet-harness`, `fleet-wiki`, or sibling workspace packages

## Dependency Rules

- This package may import only `@sbluemin/fleet-core` from the workspace, and only through its public package root.
- Deep imports such as `@sbluemin/fleet-core/src/**` are forbidden.
- Reverse dependencies from `fleet-core` back to `fleet-carriers` are forbidden.
- Module-load self-registration must stay side-effect-only and host-agnostic; Pi renderer registration belongs in `fleet-harness`.

## TypeScript File Structure

All `.ts` files must follow:

```text
imports -> types/interfaces -> constants -> functions
```
