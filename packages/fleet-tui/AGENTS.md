# Fleet TUI Doctrine

`packages/fleet-tui` is the Fleet-owned generic TUI engine package. It owns reusable terminal rendering, input routing, PTY infrastructure, Fleet PTY overlay primitives, and permanent vertical pane negotiation.

## Package Identity & Boundary

- **Must Own**: terminal renderer primitives, generic input routing, programmatic PTY input, Dedicated CLI PTY host/view infrastructure, Fleet PTY component/overlay API, and vertical two-pane split negotiation.
- **Must Not Own**: Fleet domain logic, carrier persona definitions, fleet-agent host policy, Pi host adapter code, default Fleet PTY content, or any engine workspace package.
- **Allowed Runtime Dependencies**: `@xterm/headless` and `node-pty`.
- **Forbidden Workspace Dependencies**: `@sbluemin/fleet-core`, `@sbluemin/fleet-carriers`, `@sbluemin/fleet-harness`, `@sbluemin/fleet-agent`, `@sbluemin/fleet-wiki`, `@sbluemin/fleet-wiki-web`, and `engines/*`.

## Public Surface

Consumers must use documented subpath exports only:

- `@sbluemin/fleet-tui/core`
- `@sbluemin/fleet-tui/layout`
- `@sbluemin/fleet-tui/primitives`
- `@sbluemin/fleet-tui/input`
- `@sbluemin/fleet-tui/pty`

The root `@sbluemin/fleet-tui` barrel is reserved for shared types/constants. Implementation modules should prefer the narrow subpath exports.

Deep imports are permanently forbidden: no `/src/*`, no `/dist/*`, and no file-level undocumented subpaths.

## Internal Doctrine

- Keep TypeScript files ordered as imports, types/interfaces, constants, then functions.
- Keep local imports with `.js` specifiers.
- Do not mutate `process.env`; child process environment overlays must use copied objects supplied by the caller.
- Keep the permanent vertical two-pane model. Horizontal layouts, tabs, and multi-pane layout engines are out of scope.
- Fleet PTY internals such as region stacks and overlay managers are internal implementation details. Public consumers use `@sbluemin/fleet-tui/pty`.
