# Carrier Status

Carrier status overlay domain for Fleet Agent.

This domain imports public Fleet package facades directly and consumes Fleet PTY only through `@dotobokuri/fleet-tui/pty`.

Infrastructure substitutions are intentionally narrow: legacy UI components become `fleetPty.custom`, Fleet TUI component/key/width helpers come from `@dotobokuri/fleet-tui/pty`.

Keybindings are registered via `@dotobokuri/fleet-tui/input`.

Keys: `Esc`, `Up`, `Down`, `Enter`, `Tab`, `t`, `c`, `N`, `C`, `R`.

Edit modes: model dropdown, effort dropdown, CLI type dropdown, batch CLI FROM/TO, rename editor, reset CLI, and TaskForce backend model/effort/reset.

Smoke path: `Alt+O -> Enter -> Enter -> Enter -> c -> C -> N -> t -> Enter -> Enter -> r -> Esc`.
