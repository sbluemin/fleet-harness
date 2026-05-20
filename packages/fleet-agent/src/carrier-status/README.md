# Carrier Status

Carrier status overlay domain for Fleet Agent.

This domain imports public `@sbluemin/fleet-core` root-barrel facades directly and consumes Fleet PTY only through `@sbluemin/fleet-tui/pty`.

Infrastructure substitutions are intentionally narrow: legacy UI components become `fleetPty.custom`, Fleet TUI component/key/width helpers come from `@sbluemin/fleet-tui/pty`.

Keybindings are registered via `@sbluemin/fleet-tui/input`.

Keys: `Esc`, `Up`, `Down`, `Enter`, `Tab`, `t`, `d`, `c`, `N`, `C`, `R`.

Edit modes: model dropdown, effort dropdown, CLI type dropdown, batch CLI FROM/TO, rename editor, sortie toggle, reset CLI, and TaskForce backend model/effort/reset.

Smoke path: `Alt+O -> Enter -> Enter -> Enter -> c -> C -> N -> d -> t -> Enter -> Enter -> r -> Esc`.
