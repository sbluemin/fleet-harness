# @dotobokuri/fleet-tui

Fleet-specific generic TUI engine for terminal rendering, input routing, PTY infrastructure, Fleet PTY overlays, and permanent vertical two-pane negotiation.

## Public API

Use the documented subpath exports:

- `@dotobokuri/fleet-tui/core`
- `@dotobokuri/fleet-tui/layout`
- `@dotobokuri/fleet-tui/primitives`
- `@dotobokuri/fleet-tui/input`
- `@dotobokuri/fleet-tui/pty`

The root package export is intentionally narrow and reserved for shared types/constants. Do not import from package `/src/*`, package `/dist/*`, or undocumented file-level subpaths.

## Scope

This package contains generic Fleet TUI infrastructure only. Host policy, default Fleet PTY content, carrier-status domain logic, Pi host adapters, and Fleet domain services live in their owning packages.

Runtime dependencies are limited to `@xterm/headless` and `node-pty`.
