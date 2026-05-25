# Carrier Status

Carrier Status panel domain for Fleet Agent.

Carrier Status opens from `Alt+O` as a Mission Control-hosted panel in the upper interaction layer. The lower Fleet PTY keeps the Job Bar HUD and non-interactive sections.

This domain imports public Fleet package facades directly and consumes Fleet TUI component/key/width helpers through `../controls/index.js`.

Keybindings are registered via `../controls/index.js`.

Keys: `Esc`, `Up`, `Down`, `Enter`, `Tab`, `t`, `c`, `N`, `C`, `R`.

Edit modes: model dropdown, effort dropdown, CLI type dropdown, batch CLI FROM/TO, rename editor, reset CLI, and TaskForce backend model/effort/reset.

Smoke path: `Alt+O -> Enter -> Enter -> Enter -> c -> C -> N -> t -> Enter -> Enter -> r -> Esc`.
