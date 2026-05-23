# Fleet TUI Doctrine

`packages/fleet-tui` is the Fleet-owned generic TUI engine package. It owns reusable terminal rendering, input routing, PTY infrastructure, Fleet PTY overlay primitives, and permanent vertical pane negotiation.

## Package Identity & Boundary

- **Must Own**: terminal renderer primitives, generic input routing, programmatic PTY input, Dedicated CLI PTY host/view infrastructure, Fleet PTY component/overlay API, and vertical two-pane split negotiation.
- **Must Not Own**: Fleet domain logic, carrier persona definitions, fleet-agent host policy, host adapter code, default Fleet PTY content, or any engine workspace package.
- **Allowed Runtime Dependencies**: `@xterm/headless` and `node-pty`.
- **Forbidden Workspace Dependencies**: `@sbluemin/fleet-carriers`, `@sbluemin/fleet-agent`, `@sbluemin/fleet-wiki`, `@sbluemin/fleet-wiki-web`, and `@sbluemin/fleet-unified-agent`.

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

## Cursor Anchor Contract

Generic outer-terminal cursor positioning primitive. When to sync, overlay suppression, and off-switch policy live exclusively in `fleet-agent`; this package exposes frame-local geometry only.

- **Component contract**: optional `getCursorAnchor(width)` returns `CursorAnchor | null` — frame-local `row`/`column` (0-based within the component's rendered region) plus `visible`. Dedicated PTY implements this via xterm logical cursor projection (`pty/dedicated/`).
- **LocalTui API**: `setCursorAnchorTarget(component | undefined)` selects the anchor source; `cursorSyncEnabled` (default on) gates per-render sync ANSI. `requestRender(force?, afterRender?)` accepts an optional post-flush callback after stdout flush (hosts use this for phased policy resume; it is not a host-policy surface).
- **Host-agnostic invariant**: cursor-anchor types and renderer paths MUST NOT reference Fleet, IME, Dedicated CLI branding, overlay semantics, or host-policy names.
- **Visibility invariant**: `start()` hides the cursor; `stop()` / `restoreTerminal()` show it. Each render pass appends either `\x1b[row;colH\x1b[?25h` (valid visible in-frame anchor) or `\x1b[?25l` (sync disabled, no target, `visible: false`, or fail-closed invalid coordinates).
- **Fail-closed validation**: non-safe-integer, negative, or out-of-frame row/column values are treated as hidden (emit hide cursor).
- **Unchanged invariants** (DIR-1 does not touch): `@sbluemin/fleet-tui/input` tokenization/routing, key-encoding identity passthrough, and `@xterm/headless` `disableStdin: true` on the Dedicated bridge.
