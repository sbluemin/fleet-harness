# @dotobokuri/fleet-tui

Fleet-owned TUI primitives for terminal rendering, component contracts, layout math, text helpers, cursor anchors, and terminal-size helpers.

## Public API

Use the documented subpath exports:

- `@dotobokuri/fleet-tui/core`
- `@dotobokuri/fleet-tui/components`
- `@dotobokuri/fleet-tui/layout`
- `@dotobokuri/fleet-tui/primitives`

The root package export is intentionally narrow and reserved for shared types/constants. Do not import from package `/src/*`, package `/dist/*`, or undocumented file-level subpaths.

## Scope

This package contains generic TUI primitives only. Host policy, input routing, PTY process lifecycle, lower-pane panel runtime, default content, host-specific domain logic, Pi host adapters, and Fleet domain services live in their owning packages.

Runtime dependencies should not include xterm or PTY host code unless a future primitive scope is explicitly approved.
