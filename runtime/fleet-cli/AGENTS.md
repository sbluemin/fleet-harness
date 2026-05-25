# Fleet CLI Doctrine

`runtime/fleet-cli` is the primary Fleet CLI entry point (`fleet`) that embeds a local CLI process inside a permanent vertical two-pane Fleet TUI.

## Package Identity & Boundary

This package owns the local host assembly for the Agent CLI PTY and Fleet PTY lower pane, and consumes `@dotobokuri/fleet-admiral` for single-fleet Admiral policy.

- **Must Own**: local host assembly, host `controls/**`, host `sections/**`, carrier-status domain wiring, mission-control domain wiring, panel host callback, agent CLI profile resolution, CLI process lifecycle, programmatic PTY input bridge, xterm-backed Agent CLI viewport, in-process update subsystem (`src/update/**`), and Fleet's CLI Composition Root.
- **Must Not Own**: carrier persona definitions, host-agnostic infrastructure, generic MCP server internals, or generic engine logic.
- **Dependencies**: Restricted to `@dotobokuri/fleet-admiral` for Admiral prompt/tool policy, `@dotobokuri/fleet-infra` for auth/session/settings infrastructure, `@dotobokuri/fleet-carriers` for carrier runtime and detached job count, `@dotobokuri/fleet-mcp-server`, `@dotobokuri/fleet-tui`, `@dotobokuri/fleet-wiki`, and `@dotobokuri/fleet-wiki-ui`.

Direct dependencies on execution-engine packages are generally forbidden. Execution and model catalog access flow through `fleet-infra` and the Fleet orchestration packages. The Job Bar functionality is fully integrated into `fleet-cli`.

## Composition Root Contract

`fleet-cli` is the only Composition Root for the CLI runtime. It assembles all service instances bottom-up and passes dependencies downward through explicit factory dependency objects.

- The DI layer order is one-way: `fleet-cli` -> `fleet-admiral` -> `fleet-carriers` / `fleet-mcp-server`; `fleet-mcp-server` is a generic leaf dependency consumed through public APIs.
- `fleet-cli` may call `createInfraServices(deps)`, `createCarrierRuntime(deps)`, default agent tool registration, and MCP startup while assembling the runtime, but lower layers must not reach back into host wiring.
- Service construction must stay explicit in the host assembly path; do not introduce hidden global service containers, lazy host lookups, or reverse imports from lower layers.
- Host UI and PTY objects are terminal adapters only. Domain services receive narrow dependencies, not `fleet-cli` module state.

## Canonical Layout

Only the permanent vertical two-pane layout is allowed:

- **Agent CLI PTY**: Upper pane. Hosted by Mission Control as the default upper interaction layer.
- **Fleet PTY**: Lower pane.
- **Mission Control**: Upper interaction layer that hosts the Agent CLI PTY and temporarily yields to panels (e.g., Carrier Status) while they are active.
- **Session Options**: Owned by `src/mission-control/options/`. Mission Control owns the interactive option state; the Options Drawer (`O`) edits boolean flags and `S` persists defaults through `fleet-infra/preset`. Model editing is handled inline via `→` arrow key in the idle CLI selection view, not in the Options Drawer.
- **Shared PTY negotiation**: `src/controls/pty.ts` owns host resize negotiation over `@dotobokuri/fleet-tui/layout` primitives.
- **Terminal viewport**: `src/controls/terminal-view.ts` owns the xterm-backed Agent CLI viewport, scrollback rendering, alternate-buffer detection, ANSI style reconstruction, and logical cursor projection.
- **Input runtime**: `src/controls/input.ts` owns host keyboard routing, keybinding helpers, mouse parsing, and programmatic PTY input.
- **Panel runtime**: `src/controls/panels.ts` owns lower-pane panel API, overlays, sections, theme/key helpers, and desired-height adapters.
- **Render coordination**: `src/controls/render.ts` owns host render scheduling, cursor policy sync, viewport adapter, and mouse-to-PTY routing helpers.
- **Shared controls types**: `src/controls/types.ts` owns PTY/input/panel/render types used by this host.
- **Controls barrel**: `src/controls/index.ts` is package-local only; it is not a public workspace surface.

## Input & Mode Logic

- `MIRROR` mode forwards Fleet PTY keystrokes to the Agent CLI PTY.
- `DEDICATED` mode gives exclusive control to the Agent CLI PTY.
- `Ctrl+T` toggles between modes.
- The Fleet PTY owns no visible text input.

## Host Cursor Policy

Outer-terminal cursor sync policy is owned here; `fleet-tui` supplies only generic anchor primitives (`getCursorAnchor`, `setCursorAnchorTarget`, `cursorSyncEnabled`, post-flush `requestRender` callback).

- **Policy sync**: `createCursorPolicySync()` in `src/controls/render.ts` runs before each scheduled render and sets `LocalTui.setCursorAnchorTarget(...)`. Active target is the Dedicated PTY view in `MIRROR`/`DEDICATED` when cursor sync is on, mode-toggle suppression is off, the Fleet PTY has no active overlay, and the Mission Control has no active panel; otherwise the target is cleared.
- **Mode-toggle suppression**: `Ctrl+T` clears the target and schedules one hidden render frame; policy resumes in the renderer post-flush `afterRender` callback (`scheduleRender` → `ui.requestRender(..., callback)`), then a follow-up render — not via independent timer chains.
- **Off-switch** (read-only env; do not mutate `process.env`): `RunAppOptions.cursorSync` (default on), CLI `--disable-cursor-sync`, and `FLEET_CURSOR_SYNC=0` or `false` parsed in `cli-args.ts` and passed through `index.ts`.
- **Boundary**: IME/terminal compatibility decisions and overlay/mode gating stay in this package; do not push host policy into `fleet-tui` renderer or anchor types.

## Development & Execution

- Use the root `pnpm fleet` script.
- Installed or linked `fleet` commands enter through `runtime/fleet-cli/bin/fleet`.

## Operational Standards

- ESM-only with TypeScript `NodeNext`.
- Local imports use `.js` specifiers.
- Do not mutate `process.env`.
