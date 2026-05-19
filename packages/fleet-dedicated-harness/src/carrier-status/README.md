# Carrier Status

Top-level Option Y overlay domain for Dedicated Harness with full fleet-harness carrier-status domain parity.

This domain uses public `@sbluemin/fleet-core` runtime services through the local runtime context and consumes Fleet PTY only through `src/tui/pty/fleet/api.ts`. It does not implement `renderer.ts`; Dedicated Harness has no HUD footer.

Infrastructure substitutions are intentionally narrow: Pi `ctx.ui.custom` becomes `fleetPty.custom`, fleet-tui component/key/width helpers become local `tui/pty/fleet`, and `pi.registerShortcut` becomes local `tui/input/keybindings.register`.

Keys: `Esc`, `Up`, `Down`, `Enter`, `Tab`, `t`, `d`, `S`, `c`, `N`, `C`, `R`.

Edit modes: model dropdown, effort dropdown, CLI type dropdown, batch CLI FROM/TO, rename editor, sortie toggle, Squadron toggle, reset CLI, and TaskForce backend model/effort/reset.

Smoke path: `Alt+O -> Enter -> Enter -> Enter -> c -> C -> N -> d -> S -> t -> Enter -> Enter -> r -> Esc`.
