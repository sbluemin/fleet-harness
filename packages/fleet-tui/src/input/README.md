# TUI Input

Generic input engine surface for Fleet TUI.

This directory owns keyboard chunk splitting, generic keybinding config, conflict checks, and programmatic PTY input. It does not own host shortcut definitions or MIRROR/DEDICATED mode policy; hosts inject those into the router.
