# Carrier Status

Top-level Option Y overlay domain for Dedicated Harness with full fleet-harness carrier-status domain parity.

This domain uses public `@sbluemin/fleet-core` runtime services through the local runtime context and consumes Fleet PTY only through `@sbluemin/fleet-tui/pty`. It does not implement `renderer.ts`; Dedicated Harness has no HUD footer.

Infrastructure substitutions are intentionally narrow: Pi `ctx.ui.custom` becomes `fleetPty.custom`, Fleet TUI component/key/width helpers come from `@sbluemin/fleet-tui/pty`.

`pi.registerShortcut` becomes `@sbluemin/fleet-tui/input` keybinding registration.

Keys: `Esc`, `Up`, `Down`, `Enter`, `Tab`, `t`, `d`, `c`, `N`, `C`, `R`.

Edit modes: model dropdown, effort dropdown, CLI type dropdown, batch CLI FROM/TO, rename editor, sortie toggle, reset CLI, and TaskForce backend model/effort/reset.

Smoke path: `Alt+O -> Enter -> Enter -> Enter -> c -> C -> N -> d -> t -> Enter -> Enter -> r -> Esc`.
