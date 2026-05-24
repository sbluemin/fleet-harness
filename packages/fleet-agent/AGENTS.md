# Fleet CLI Doctrine

`packages/fleet-agent` is the primary Fleet CLI entry point (`fleet`) that embeds a local CLI process inside a permanent vertical two-pane Fleet TUI.

## Package Identity & Boundary

This package owns the local host assembly for the Dedicated CLI PTY, Fleet PTY lower pane, absorbed single-fleet Admiral policy modules, and absorbed Grand Fleet policy modules.

- **Must Own**: local host assembly, host `controls/**`, host `sections/**`, carrier-status domain wiring, dedicated CLI profile resolution, CLI process lifecycle, programmatic PTY input bridge, Fleet's CLI Composition Root, `src/admiral/**`, and `src/grand-fleet/**`.
- **Must Not Own**: carrier persona definitions, host-agnostic infrastructure, generic MCP server internals, or generic engine logic.
- **Dependencies**: Restricted to `@dotobokuri/fleet-infra` for auth/session/settings infrastructure, `@dotobokuri/fleet-carriers` for carrier runtime and detached job count, `@dotobokuri/fleet-mcp-server`, `@dotobokuri/fleet-tui`, `@dotobokuri/fleet-wiki`, and `@dotobokuri/fleet-wiki-web`.

Direct dependencies on execution-engine packages are generally forbidden. Execution and model catalog access flow through `fleet-infra` and the Fleet orchestration packages. The Job Bar functionality is fully absorbed into `fleet-agent`.

## Composition Root Contract

`fleet-agent` is the only Composition Root for the CLI runtime. It assembles all service instances bottom-up and passes dependencies downward through explicit factory dependency objects.

- The DI layer order is one-way: `fleet-agent` -> `fleet-carriers` -> `fleet-infra`; `fleet-mcp-server` is a generic leaf dependency consumed through public APIs.
- `fleet-agent` may call `createInfraServices(deps)`, `createCarrierRuntime(deps)`, default agent tool registration, and MCP startup while assembling the runtime, but lower layers must not reach back into host wiring.
- Service construction must stay explicit in the host assembly path; do not introduce hidden global service containers, lazy host lookups, or reverse imports from lower layers.
- Host UI and PTY objects are terminal adapters only. Domain services receive narrow dependencies, not `fleet-agent` module state.

## Canonical Layout

Only the permanent vertical two-pane layout is allowed:

- **Dedicated CLI PTY**: Upper pane.
- **Fleet PTY**: Lower pane.
- **Shared PTY negotiation**: `@dotobokuri/fleet-tui/pty` owns desired-height layout.
- **Generic input core**: `@dotobokuri/fleet-tui/input` owns keyboard routing.
- **Host control policy**: `src/controls/modes.ts` owns MIRROR/DEDICATED mode semantics.

## Input & Mode Logic

- `MIRROR` mode forwards Fleet PTY keystrokes to the Dedicated CLI PTY.
- `DEDICATED` mode gives exclusive control to the Dedicated CLI PTY.
- `Ctrl+T` toggles between modes.
- The Fleet PTY owns no visible text input.

## Host Cursor Policy

Outer-terminal cursor sync policy is owned here; `fleet-tui` supplies only generic anchor primitives (`getCursorAnchor`, `setCursorAnchorTarget`, `cursorSyncEnabled`, post-flush `requestRender` callback).

- **Policy sync**: `createCursorPolicySync()` in `app.ts` (assigned to `syncCursorPolicy`) runs before each scheduled render and sets `LocalTui.setCursorAnchorTarget(...)`. Active target is the Dedicated PTY view in `MIRROR`/`DEDICATED` when cursor sync is on, mode-toggle suppression is off, and the Fleet PTY has no active overlay; otherwise the target is cleared.
- **Mode-toggle suppression**: `Ctrl+T` clears the target and schedules one hidden render frame; policy resumes in the renderer post-flush `afterRender` callback (`scheduleRender` → `ui.requestRender(..., callback)`), then a follow-up render — not via independent timer chains.
- **Off-switch** (read-only env; do not mutate `process.env`): `RunAppOptions.cursorSync` (default on), CLI `--disable-cursor-sync`, and `FLEET_CURSOR_SYNC=0` or `false` parsed in `cli-args.ts` and passed through `index.ts`.
- **Boundary**: IME/terminal compatibility decisions and overlay/mode gating stay in this package; do not push host policy into `fleet-tui` renderer or anchor types.

## Development & Execution

- Use the root `pnpm fleet` script.
- Installed or linked `fleet` commands enter through `packages/fleet-agent/bin/fleet`.

## Operational Standards

- ESM-only with TypeScript `NodeNext`.
- Local imports use `.js` specifiers.
- Do not mutate `process.env`.
