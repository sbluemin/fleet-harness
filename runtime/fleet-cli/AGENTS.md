# Fleet CLI Doctrine

`runtime/fleet-cli` is the primary Fleet CLI entry point (`fleet`). It embeds a local CLI process inside a vertical two-pane Fleet TUI.

## Package Identity & Boundary

This package owns the local host assembly for the Agent CLI PTY and Fleet PTY lower pane, and consumes `@dotobokuri/fleet-admiral` for single-fleet Admiral policy.

- **Must Own**: local host assembly, host-owned TUI engine under `src/tui/`, host-owned SGR/color/brand/help style SSoT under `src/styles/`, host `controls/**`, Mission Bridge lower Fleet PTY domain wiring under `src/mission-bridge/**`, carrier-roster domain wiring, mission-control domain wiring, panel host callback, CLI process lifecycle, host Codex command runner, host hook executable adapter, programmatic PTY input bridge, xterm-backed Agent CLI viewport, in-process update subsystem (`src/update/**`) that wraps the shared `@dotobokuri/core-agent` global-package-updater substrate while keeping CLI-specific update lifecycle (console stop hook and operator-facing messages), and Fleet's CLI Composition Root; Agent CLI profile resolution, Fleet activation rendering, and Fleet MCP runtime assembly are consumed from `@dotobokuri/fleet-admiral`.
- **Must Not Own**: carrier persona definitions, host-agnostic infrastructure, generic MCP server internals, or generic engine logic.
- **Dependencies**: Restricted to `@dotobokuri/fleet-admiral` for Admiral prompt/tool policy, `@dotobokuri/core-infra` for auth/session infrastructure and data-dir/settings, `@dotobokuri/fleet-carriers` for carrier runtime and detached job count, `@dotobokuri/core-agent` for ExecutorPort/provider registration, execution substrate assembly, generic tool registry primitives, binary resolution helpers, and in-process MCP HTTP/JSON-RPC primitives, `@dotobokuri/core-unified-agent` when CLI SDK types or provider metadata are needed, `@dotobokuri/fleet-wiki` (wiki tool specs and entry count only — no binary relay), and `@dotobokuri/fleet-console` (the `fleet console` subcommand relays to the console-owned CLI as a child process).

Direct dependencies on execution-engine internals or deep implementation files are forbidden. Fleet's Composition Root may depend on the `@dotobokuri/core-agent` root API to register `ExecutorPort` policy, executor MCP runtime providers, auth resolvers, and shutdown hooks explicitly. The Job Bar functionality is fully integrated into `fleet-cli`.

## Composition Root Contract

`fleet-cli` is the only Composition Root for the CLI runtime. It assembles all service instances bottom-up and passes dependencies downward through explicit factory dependency objects.

- The DI layer order is one-way: `fleet-cli` -> `fleet-admiral` -> `fleet-carriers` / `core-agent`; core packages are generic leaf dependencies consumed through public APIs.
- `fleet-cli` may call `createInfraServices(deps)`, `createCarrierRuntime(deps)`, default agent tool registration, core-agent executor/provider registration, and one in-process MCP server assembly while booting the runtime, but lower layers must not reach back into host wiring.
- `runtime/fleet-cli/src/runtime/runtime.ts` owns exactly one in-process MCP HTTP/JSON-RPC server per Fleet CLI process, assembled from `@dotobokuri/core-agent` root exports. Main and executor sessions are separated by session token/tool snapshot inside that one server; runtime별 or session별 MCP server branching is not allowed.
- Service construction must stay explicit in the host assembly path; do not introduce hidden global service containers, lazy host lookups, or reverse imports from lower layers.
- Host UI and PTY objects are terminal adapters only. Domain services receive narrow dependencies, not `fleet-cli` module state.

## Canonical Layout

The default app uses the permanent vertical two-pane layout:

- **Agent CLI PTY**: Upper pane. Hosted by Mission Control as the default upper interaction layer.
- **Fleet PTY**: Lower pane.
- **Mission Control**: Upper interaction layer that hosts the Agent CLI PTY and temporarily yields to panels (e.g., Carrier Roster) while they are active. Panel renderers consume shared block-level alignment primitives for choice and key:value rows; centering is reserved for banner, title, and footer lines only.
- **Mission Bridge**: Lower interaction layer under `src/mission-bridge/` that assembles Fleet status, Job Bar state/sections, lower Fleet PTY API consumption, and lower viewport lifecycle.
- **Session Options**: Owned by `src/mission-control/options/`. Mission Control owns the interactive option state; the flat root `OPTION` section toggles boolean flags (Mode, Metaphor) and auto-persists each change immediately through `core-infra/data-dir/settings` (no manual save/reset). Model editing is handled inline via `→` arrow key on a `LAUNCH` row as a session-only override that is not persisted.
- **Shared PTY negotiation**: `src/controls/pty.ts` is a compatibility facade; actual PTY responsibilities live in `src/controls/pty/{shell,keyboard,csi-u,host,resize}.ts`. `pty/resize.ts` owns host resize negotiation over `src/tui/layout` primitives.
- **Terminal viewport**: `src/controls/terminal-view.ts` owns the xterm-backed Agent CLI viewport, scrollback rendering, alternate-buffer detection, ANSI style reconstruction, and logical cursor projection.
- **Mouse runtime**: `src/controls/mouse/{parser,protocol,router}.ts` own SGR mouse parse/encode, DEC private mouse protocol state (including drag tracking), pane hit-testing, app-mouse forwarding, and scroll fallback.
- **Input runtime**: `src/controls/input.ts` is a compatibility facade; actual input responsibilities live in `src/controls/input/{keybindings,router,programmatic,contract}.ts`. `input/router.ts` owns host keyboard routing, `input/keybindings.ts` owns keybinding registry/config, `input/programmatic.ts` owns programmatic PTY input, and `input/contract.ts` owns input contract/predicates.
- **Panel runtime**: `src/controls/panels.ts` owns lower-pane panel API, overlays, sections, theme/key helpers, and desired-height adapters.
- **Render coordination**: `src/controls/render.ts` owns host render scheduling, cursor policy sync, and viewport adapter.
- **Shared controls types**: `src/controls/types.ts` owns PTY/input/panel/render types used by this host.
- **Controls barrel**: `src/controls/index.ts` is an explicit package-local barrel; it is not a public workspace surface.
- **Process runtime**: Cross-subsystem binary resolution and Windows shim wrapping are consumed from `@dotobokuri/core-agent`; update and agent-cli subsystems use that root API.
## Input Ownership

- The old Fleet input mode system is retired. There is no mode toggle and no Fleet-owned global `Ctrl+C`, `Ctrl+Q`, or `Ctrl+T` shortcut.
- Before launch, operator keyboard input belongs to Mission Control launcher and panel controls.
- After launch, operator keyboard input belongs to the active embedded Agent CLI PTY.
- Fleet process exit is driven by launcher Exit selection, child process/PTY lifecycle, or process lifecycle cleanup signals; do not add a Fleet global exit shortcut.
- **Mouse forwarding (Option C)**: Outer terminal motion is enabled via `?1000h?1002h?1006h`. When the active child is in app-mouse mode, press/motion/release/wheel events are forwarded as raw SGR sequences in local coordinates. Non-app-mouse events fall back to viewport scrollback or alt-buffer arrow navigation.

## Host Cursor Policy

Outer-terminal cursor sync policy is owned here; `src/tui/` supplies the local renderer and generic anchor primitives (`getCursorAnchor`, `setCursorAnchorTarget`, `cursorSyncEnabled`, post-flush `requestRender` callback).

- **Policy sync**: `createCursorPolicySync()` in `src/controls/render.ts` runs before each scheduled render and sets `LocalTui.setCursorAnchorTarget(...)`. Active target is the Agent CLI PTY view when cursor sync is on, the Fleet PTY has no active overlay, and Mission Control has no active panel; otherwise the target is cleared. Cursor sync defaults on for all platforms and Agent CLI profiles — the trailing-padding-trim projection in `src/controls/terminal-view.ts` keeps the Windows ConPTY/Ink cursor anchored at the input cell, so the former `win32`+Claude-family auto-disable was removed (it hid the cursor entirely and broke CJK IME composition; see CHANGELOG).
- **Off-switch** (read-only env; do not mutate `process.env`): `RunAppOptions.cursorSync` (default on), CLI `--disable-cursor-sync`, and `FLEET_CURSOR_SYNC=0` or `false` parsed in `cli-args.ts` and passed through `index.ts`. This is the escape hatch for any terminal whose IME anchoring still misbehaves.
- **Boundary**: IME/terminal compatibility decisions and overlay gating stay in this package; do not push host policy into generic `src/tui` renderer or anchor types.

## Development & Execution

- Use the root `pnpm cli` script.
- Installed or linked `fleet` commands enter through `runtime/fleet-cli/bin/fleet`.

## Operational Standards

- ESM-only with TypeScript `NodeNext`.
- Local imports use `.js` specifiers.
- Do not mutate `process.env`.
