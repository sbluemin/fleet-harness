# Carrier Roster

Mission Control-owned carrier configuration panel.

Carrier Roster opens from the Mission Control idle/control surface with uppercase `C`. It uses the Mission Control panel-stack chrome path, keeps lowercase `c` scoped to choose-CLI at the Mission Control level, and keeps in-panel lowercase `c` scoped to CLI type editing.

The TaskForce configuration surface is a Carrier Roster sub-panel pushed onto the same panel stack with `t`; `Esc` returns to the roster before closing the stack at the root.

The in-panel `s` shortcut toggles per-carrier Native(SubAgent) startup state. The saved state applies to the next Claude-family dedicated CLI spawn and does not restart or mutate the currently running child process.

The Job Bar remains in `../../mission-bridge/job-bar/` and is intentionally not imported from this directory.
