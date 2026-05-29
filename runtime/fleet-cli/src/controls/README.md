# Controls

Host-specific controls for the Fleet CLI runtime.

- `types.ts` centralizes shared host-local PTY, panel, resize, and render types that forbidden consumers still import.
- `mouse/parser.ts` owns SGR mouse parse/encode and mouse event/layout types.
- `mouse/protocol.ts` owns child DEC private mouse protocol state.
- `mouse/router.ts` owns pane hit-testing, dedicated child mouse forwarding, and scroll fallback.
- `pty/shell.ts`, `pty/keyboard.ts`, `pty/csi-u.ts`, `pty/host.ts`, and `pty/resize.ts` split shell lifecycle, keyboard negotiation, CSI-u normalization, PTY host assembly, and resize negotiation.
- `input/keybindings.ts`, `input/router.ts`, `input/programmatic.ts`, and `input/contract.ts` split keybinding registry, token routing, programmatic PTY input, and input contract checks.
- `terminal-view.ts` owns the xterm-backed Agent CLI viewport, scrollback rendering, alternate-buffer detection, ANSI style reconstruction, and logical cursor projection.
- `panels.ts` owns lower-pane sections, overlays, theme/key helpers, desired-height adapters, and the panel API.
- `render.ts` owns render scheduling, cursor policy sync, and Fleet PTY viewport adaptation.
- `input.ts` and `pty.ts` are compatibility facades for existing package-local imports.
- `index.ts` is an explicit package-local barrel for `runtime/fleet-cli` consumers.

Do not introduce MVC directories, state-machine frameworks, ports layers, service locators, DI containers, or new workspace packages for this controls layer.
