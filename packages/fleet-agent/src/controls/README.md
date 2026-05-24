# Controls

Host-specific control policy over the generic TUI engine.

`modes.ts` owns the MIRROR/DEDICATED mode names and toggle behavior. Generic `@dotobokuri/fleet-tui/input` code receives these operations through options and must not import this directory.
