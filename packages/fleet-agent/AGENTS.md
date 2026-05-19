# Fleet CLI Doctrine

`packages/fleet-agent` is the primary Fleet CLI entry point (`fleetd`) that embeds a local CLI process inside a permanent vertical two-pane Fleet TUI.

## Package Identity & Boundary

This package owns the local host assembly for the Dedicated CLI PTY and Fleet PTY lower pane.

- **Must Own**: local host assembly, host `controls/**`, host `sections/**`, carrier-status domain wiring, dedicated CLI profile resolution, CLI process lifecycle, and programmatic PTY input bridge.
- **Must Not Own**: Fleet domain logic, carrier persona definitions, or generic engine logic.
- **Dependencies**: Restricted to `@sbluemin/fleet-core`, `@sbluemin/fleet-carriers`, `@sbluemin/fleet-tui`, `@sbluemin/fleet-wiki`, and `@sbluemin/fleet-wiki-web`.

Dependencies on `engines/*` are generally forbidden, with the sole exception of `@sbluemin/unified-agent`. The Job Bar functionality is fully absorbed into `fleet-agent`.

## Canonical Layout

Only the permanent vertical two-pane layout is allowed:

- **Dedicated CLI PTY**: Upper pane.
- **Fleet PTY**: Lower pane.
- **Shared PTY negotiation**: `@sbluemin/fleet-tui/pty` owns desired-height layout.
- **Generic input core**: `@sbluemin/fleet-tui/input` owns keyboard routing.
- **Host control policy**: `src/controls/modes.ts` owns MIRROR/DEDICATED mode semantics.

## Input & Mode Logic

- `MIRROR` mode forwards Fleet PTY keystrokes to the Dedicated CLI PTY.
- `DEDICATED` mode gives exclusive control to the Dedicated CLI PTY.
- `Ctrl+T` toggles between modes.
- The Fleet PTY owns no visible text input.

## Development & Execution

- Use the root `pnpm fleet` or `fleetd` script.
- Installed or linked `fleet` commands enter through `packages/fleet-agent/fleetd`.

## Operational Standards

- ESM-only with TypeScript `NodeNext`.
- Local imports use `.js` specifiers.
- Do not mutate `process.env`.

