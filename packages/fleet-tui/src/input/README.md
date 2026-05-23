# TUI Input

Generic input engine surface for Fleet TUI.

This directory owns keyboard chunk splitting, SGR mouse token parsing/routing, generic keybinding config, conflict checks, and programmatic PTY input. It does not own host shortcut definitions, pane geometry policy, or MIRROR/DEDICATED mode policy; hosts inject those into the router.
