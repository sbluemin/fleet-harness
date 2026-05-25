# Controls

Host-specific controls for the Fleet CLI runtime.

- `types.ts` centralizes host-local PTY, input, panel, resize, mouse, and render types.
- `input.ts` owns keyboard routing, keybinding helpers, SGR mouse parsing/encoding, input contract checks, and programmatic PTY input.
- `pty.ts` owns PTY process lifecycle, shell wrappers, keyboard/mouse protocol runtime, key encoding, and resize negotiation.
- `terminal-view.ts` owns the xterm-backed Agent CLI viewport, scrollback rendering, alternate-buffer detection, ANSI style reconstruction, and logical cursor projection.
- `panels.ts` owns lower-pane sections, overlays, theme/key helpers, desired-height adapters, and the panel API.
- `render.ts` owns render scheduling, cursor policy sync, viewport adaptation, and mouse-to-PTY routing.
- `index.ts` is a package-local barrel for `runtime/fleet-cli` consumers.

Do not introduce MVC directories, state-machine frameworks, ports layers, service locators, DI containers, or new workspace packages for this controls layer.
