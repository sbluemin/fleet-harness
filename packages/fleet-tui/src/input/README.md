# TUI Input

Generic input engine surface for Fleet TUI.

This directory owns keyboard chunk splitting, host shortcut registration, conflict checks, and programmatic PTY input. It does not own MIRROR/DEDICATED mode policy; host mode semantics are injected into the router.
