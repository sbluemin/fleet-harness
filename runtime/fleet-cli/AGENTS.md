# Fleet CLI Doctrine

`runtime/fleet-cli` is the primary Fleet CLI entry point (`fleet`). The default boot path embeds a local CLI process inside a vertical two-pane Fleet TUI; `fleet --native` is the terminal-exclusive exception.

## Package Identity & Boundary

This package owns the local host assembly for the Agent CLI PTY and Fleet PTY lower pane, and consumes `@dotobokuri/fleet-admiral` for single-fleet Admiral policy.

- **Must Own**: local host assembly, host-owned TUI engine under `src/tui/`, host-owned SGR/color/brand/help style SSoT under `src/styles/`, host `controls/**`, Mission Bridge lower Fleet PTY domain wiring under `src/mission-bridge/**`, carrier-roster domain wiring (including subagent mode toggle, `[SA]` badge, and signature color), mission-control domain wiring, panel host callback, agent CLI profile resolution, CLI process lifecycle, programmatic PTY input bridge, xterm-backed Agent CLI viewport, agent-cli plugin rendering for Claude/Codex Fleet activation, in-process update subsystem (`src/update/**`), and Fleet's CLI Composition Root.
- **Must Not Own**: carrier persona definitions, host-agnostic infrastructure, generic MCP server internals, or generic engine logic.
- **Dependencies**: Restricted to `@dotobokuri/fleet-admiral` for Admiral prompt/tool policy, `@dotobokuri/fleet-infra` for auth/session infrastructure, `@dotobokuri/fleet-carriers` for carrier runtime and detached job count, `@dotobokuri/core-agent` for ExecutorPort/provider registration, execution substrate assembly, generic tool registry primitives, shared register-contract types, and in-process MCP HTTP/JSON-RPC primitives, `@dotobokuri/core-unified-agent` when CLI SDK types or provider metadata are needed, `@dotobokuri/fleet-wiki`, and `@dotobokuri/fleet-console` (the `fleet wiki` and `fleet console` subcommands relay to the console-owned CLIs as child processes).

Direct dependencies on execution-engine internals or deep implementation files are forbidden. Fleet's Composition Root may depend on the `@dotobokuri/core-agent` root API to register `ExecutorPort` policy, executor MCP runtime providers, auth resolvers, and shutdown hooks explicitly. The Job Bar functionality is fully integrated into `fleet-cli`.

## Composition Root Contract

`fleet-cli` is the only Composition Root for the CLI runtime. It assembles all service instances bottom-up and passes dependencies downward through explicit factory dependency objects.

- The DI layer order is one-way: `fleet-cli` -> `fleet-admiral` -> `fleet-carriers` / `core-agent`; core packages are generic leaf dependencies consumed through public APIs.
- `fleet-cli` may call `createInfraServices(deps)`, `createCarrierRuntime(deps)`, default agent tool registration, core-agent executor/provider registration, one in-process MCP server assembly, and console register publisher assembly while booting the runtime, but lower layers must not reach back into host wiring.
- `runtime/fleet-cli/src/runtime/console-register-publisher.ts` owns the lossy/bounded CLI-to-console registration and telemetry channel. It may discover/probe the console server, register, keep CLI-only registration credentials in memory, POST carrier event batches, heartbeat, retry with backoff, and best-effort deregister on shutdown; it must never block carrier execution or expose ingest/MCP tokens to browser-facing surfaces. The publisher is only started when the operator passes `--headless`; `--headless` is the opt-in gate for console registration and telemetry, independent of `--native`.
- `runtime/fleet-cli/src/runtime/runtime.ts` owns exactly one in-process MCP HTTP/JSON-RPC server per Fleet CLI process, assembled from `@dotobokuri/core-agent` root exports. Main and executor sessions are separated by session token/tool snapshot inside that one server; runtime별 or session별 MCP server branching is not allowed.
- Service construction must stay explicit in the host assembly path; do not introduce hidden global service containers, lazy host lookups, or reverse imports from lower layers.
- Host UI and PTY objects are terminal adapters only. Domain services receive narrow dependencies, not `fleet-cli` module state.

## Canonical Layout

The default app uses the permanent vertical two-pane layout:

- **Agent CLI PTY**: Upper pane. Hosted by Mission Control as the default upper interaction layer.
- **Fleet PTY**: Lower pane.
- **Mission Control**: Upper interaction layer that hosts the Agent CLI PTY and temporarily yields to panels (e.g., Carrier Roster) while they are active. Panel renderers consume shared block-level alignment primitives for choice and key:value rows; centering is reserved for banner, title, and footer lines only.
- **Mission Bridge**: Lower interaction layer under `src/mission-bridge/` that assembles Fleet status, Job Bar state/sections, lower Fleet PTY API consumption, and lower viewport lifecycle.
- **Session Options**: Owned by `src/mission-control/options/`. Mission Control owns the interactive option state; the flat root `OPTION` section toggles boolean flags (Mode, System prompt, Metaphor) and auto-persists each change immediately through `fleet-infra/global-options` (no manual save/reset). Model editing is handled inline via `→` arrow key on a `LAUNCH` row as a session-only override that is not persisted.
- **Shared PTY negotiation**: `src/controls/pty.ts` is a compatibility facade; actual PTY responsibilities live in `src/controls/pty/{shell,keyboard,csi-u,host,resize}.ts`. `pty/resize.ts` owns host resize negotiation over `src/tui/layout` primitives.
- **Terminal viewport**: `src/controls/terminal-view.ts` owns the xterm-backed Agent CLI viewport, scrollback rendering, alternate-buffer detection, ANSI style reconstruction, and logical cursor projection.
- **Mouse runtime**: `src/controls/mouse/{parser,protocol,router}.ts` own SGR mouse parse/encode, DEC private mouse protocol state (including drag tracking), pane hit-testing, app-mouse forwarding, and scroll fallback.
- **Input runtime**: `src/controls/input.ts` is a compatibility facade; actual input responsibilities live in `src/controls/input/{keybindings,router,programmatic,contract}.ts`. `input/router.ts` owns host keyboard routing, `input/keybindings.ts` owns keybinding registry/config, `input/programmatic.ts` owns programmatic PTY input, and `input/contract.ts` owns input contract/predicates.
- **Panel runtime**: `src/controls/panels.ts` owns lower-pane panel API, overlays, sections, theme/key helpers, and desired-height adapters.
- **Render coordination**: `src/controls/render.ts` owns host render scheduling, cursor policy sync, and viewport adapter.
- **Shared controls types**: `src/controls/types.ts` owns PTY/input/panel/render types used by this host.
- **Controls barrel**: `src/controls/index.ts` is an explicit package-local barrel; it is not a public workspace surface.
- **Process runtime**: `src/process/` owns cross-subsystem binary resolution and Windows shim wrapping; shared by update and agent-cli subsystems.
- **Native-terminal exception**: `fleet --native` / internal `nativeTerminal` starts with Mission Control only, stops the Fleet TUI during launch, then runs the selected child inside a dedicated node-pty raw byte passthrough. The child owns the PTY while Fleet stays on the master side to relay stdin/stdout bytes directly and inject mid-session carrier result reminders through programmatic input. After child exit, Fleet resumes Mission Control. This path creates no lower Fleet PTY, Mission Bridge, Job Bar, xterm-backed selected-child viewport, or encoded `PtyHost` for the selected child.

## Input Ownership

- The old Fleet input mode system is retired. There is no mode toggle and no Fleet-owned global `Ctrl+C`, `Ctrl+Q`, or `Ctrl+T` shortcut.
- Before launch, operator keyboard input belongs to Mission Control launcher and panel controls.
- After launch in the default two-pane path, operator keyboard input belongs to the active embedded Agent CLI PTY.
- After launch in `fleet --native`, operator keyboard input is relayed as raw bytes to the foreground child process that owns the dedicated native PTY.
- Fleet process exit is driven by launcher Exit selection, child process/PTY lifecycle, or process lifecycle cleanup signals; do not add a Fleet global exit shortcut.
- **Mouse forwarding (Option C)**: Outer terminal motion is enabled via `?1000h?1002h?1006h`. When the active child is in app-mouse mode, press/motion/release/wheel events are forwarded as raw SGR sequences in local coordinates. Non-app-mouse events fall back to viewport scrollback or alt-buffer arrow navigation.
- **Native terminology**: CLI `--native` / `nativeTerminal` means terminal-exclusive boot. It is unrelated to Fleet persona injection — dedicated CLIs now always launch with the persona injected, since the former `SessionOptions.native` / `FLEET_NATIVE` injection-skip mode was removed in #46. It is also unrelated to console observation: `--headless` is the separate opt-in that registers the session with Fleet Console, and the two flags can be used together (for example, console terminal sessions launch `fleet --headless --native`).

## Host Cursor Policy

Outer-terminal cursor sync policy is owned here; `src/tui/` supplies the local renderer and generic anchor primitives (`getCursorAnchor`, `setCursorAnchorTarget`, `cursorSyncEnabled`, post-flush `requestRender` callback).

- **Policy sync**: `createCursorPolicySync()` in `src/controls/render.ts` runs before each scheduled render and sets `LocalTui.setCursorAnchorTarget(...)`. Active target is the Agent CLI PTY view when cursor sync is on, the Fleet PTY has no active overlay, and Mission Control has no active panel; otherwise the target is cleared.
- **Windows Claude Code compatibility**: Native Windows (`process.platform === "win32"`) auto-clears the cursor anchor target for Claude-family Agent CLI profiles unless cursor sync was explicitly enabled with `FLEET_CURSOR_SYNC=1`/`true`/`yes`/`on`.
- **Off-switch** (read-only env; do not mutate `process.env`): `RunAppOptions.cursorSync` (default on), CLI `--disable-cursor-sync`, and `FLEET_CURSOR_SYNC=0` or `false` parsed in `cli-args.ts` and passed through `index.ts`.
- **Boundary**: IME/terminal compatibility decisions and overlay gating stay in this package; do not push host policy into generic `src/tui` renderer or anchor types.

## Development & Execution

- Use the root `pnpm fleet` script.
- Installed or linked `fleet` commands enter through `runtime/fleet-cli/bin/fleet`.

## Operational Standards

- ESM-only with TypeScript `NodeNext`.
- Local imports use `.js` specifiers.
- Do not mutate `process.env`.
