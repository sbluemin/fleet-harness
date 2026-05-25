# Fleet TUI Doctrine

`packages/fleet-tui` is the Fleet TUI engine and the shared brand-style hub. It owns reusable terminal rendering, component contracts, layout math, text helpers, cursor-anchor primitives, terminal-size helpers, and the Fleet CLI/help brand style assets (ANSI palette, ASCII banner, paint helpers, and TTY/`NO_COLOR` gating).

The "fleet-agnostic" framing previously applied to this package has been retired. fleet-tui is a private workspace package for the Fleet monorepo; Fleet brand assets and Fleet TUI primitives live together here as the single source of truth.

## Package Identity & Boundary

- **Must Own**: terminal renderer primitives, generic component contracts, cursor-anchor primitives, terminal-size helpers, layout math, text/render helpers, and Fleet brand style assets (palette, banner, paint, TTY/`NO_COLOR` gating, and help tokens).
- **Must Not Own**: carrier persona definitions, fleet-cli host policy, host adapter code, default lower-pane content, input-router runtime, programmatic PTY input, PTY process lifecycle, panel host runtime, Mission Control policy, Agent CLI lifecycle, web-client design tokens (those live in `runtime/fleet-wiki-ui/client`), help text builders, CLI argument parsers, or any engine workspace package.
- **Allowed Runtime Dependencies**: none.
- **Forbidden Workspace Dependencies**: `@dotobokuri/fleet-carriers`, `@dotobokuri/fleet-cli`, `@dotobokuri/fleet-wiki`, `@dotobokuri/fleet-wiki-ui`, and `@dotobokuri/fleet-unified-agent`.

## Public Surface

Consumers must use documented subpath exports only:

- `@dotobokuri/fleet-tui/core`
- `@dotobokuri/fleet-tui/components`
- `@dotobokuri/fleet-tui/layout`
- `@dotobokuri/fleet-tui/primitives`
- `@dotobokuri/fleet-tui/style`

The root `@dotobokuri/fleet-tui` barrel is reserved for shared types/constants. Implementation modules should prefer the narrow subpath exports.

Deep imports are permanently forbidden: no `/src/*`, no `/dist/*`, and no file-level undocumented subpaths.

## Internal Doctrine

- Keep TypeScript files ordered as imports, types/interfaces, constants, then functions.
- Keep local imports with `.js` specifiers.
- Do not mutate `process.env`; child process environment overlays must use copied objects supplied by the caller, and brand-style helpers (`resolveColorEnabled`) must accept explicit env/TTY options.
- Keep the permanent vertical two-pane layout math. Horizontal layouts, tabs, and multi-pane layout engines are out of scope.
- Host controls, lower-pane overlays, input routing, and PTY process lifecycle live in `runtime/fleet-cli/src/controls`.
- `./style` owns only Fleet CLI/help brand assets — ANSI palette, ASCII banner, paint/strip helpers, and TTY/`NO_COLOR` token helpers. It does not own help builders, CLI argument parsers, or web-client design tokens.

## Cursor Anchor Contract

Generic outer-terminal cursor positioning primitive. When to sync, overlay suppression, and off-switch policy live exclusively in `fleet-cli`; this package exposes frame-local geometry only.

- **Component contract**: optional `getCursorAnchor(width)` returns `CursorAnchor | null` — frame-local `row`/`column` (0-based within the component's rendered region) plus `visible`. Host terminal viewport projection lives in `runtime/fleet-cli/src/controls/terminal-view.ts`.
- **LocalTui API**: `setCursorAnchorTarget(component | undefined)` selects the anchor source; `cursorSyncEnabled` (default on) gates per-render sync ANSI. `requestRender(force?, afterRender?)` accepts an optional post-flush callback after stdout flush (hosts use this for phased policy resume; it is not a host-policy surface).
- **Cursor-anchor type invariant**: cursor-anchor types and renderer paths stay free of host-policy hooks and overlay semantics so the anchor primitive remains reusable across host surfaces.
- **Visibility invariant**: `start()` hides the cursor; `stop()` / `restoreTerminal()` show it. Each render pass appends either `\x1b[row;colH\x1b[?25h` (valid visible in-frame anchor) or `\x1b[?25l` (sync disabled, no target, `visible: false`, or fail-closed invalid coordinates).
- **Fail-closed validation**: non-safe-integer, negative, or out-of-frame row/column values are treated as hidden (emit hide cursor).
- **Unchanged invariants**: host policy, protocol runtime, and xterm-backed viewport rendering stay outside this package.
