# Fleet Dedicated Harness Doctrine

`packages/fleet-dedicated-harness` is a standalone Fleet host PoC for embedding one first-class local CLI process inside a permanent vertical two-pane Fleet TUI.

## Package Identity & Boundary

This package owns the local host assembly for the Dedicated CLI PTY and Fleet PTY lower pane.

- **Must Own**: `PtyHost` adapter, local `tui/**`, layout composition, input routing, Fleet PTY region API, and CLI process lifecycle.
- **Must Not Own**: Fleet domain logic, carrier persona definitions, Pi-specific extensions, or engine packages.
- **Dependencies**: Restricted to `@sbluemin/fleet-core`, `@sbluemin/fleet-carriers`, `@sbluemin/fleet-wiki`, `@sbluemin/fleet-wiki-web`, `@xterm/headless`, and `node-pty`.

`@sbluemin/fleet-tui`, `@sbluemin/fleet-harness`, and `engines/*` are permanently forbidden dependencies.

## Canonical Layout

Only the permanent vertical two-pane layout is allowed:

- **Dedicated CLI PTY**: Upper pane, backed by `PtyView`, `PtyHost`, and `node-pty`.
- **Fleet PTY**: Lower pane, backed by default Fleet sections and `fleet-pty/api.ts`.

Horizontal layouts, tabs, multi-pane layouts, and layout engines are out of scope.

## Fleet PTY API

`fleet-pty/api.ts` is the only external Fleet PTY API for overlays and region replacement.

External domains must not import `fleet-pty/region-stack.ts`, `fleet-pty/overlay-manager.ts`, `fleet-pty/sections.ts`, or `fleet-pty/types.ts` directly.

## Input & Mode Logic

- `MIRROR` mode forwards Fleet PTY keystrokes to the Dedicated CLI PTY.
- `DEDICATED` mode gives exclusive control to the Dedicated CLI PTY.
- `Ctrl+T` toggles between modes.
- The Fleet PTY owns no visible text input.

## Slot Rules

Tier-2/3 slots are README-only until later plans open them.

Do not create `bridge/`, `carrier-status/`, or `grand-fleet/`. Future carrier status UI expands under `jobs/status.ts` or `jobs/status/` only when Tier-3 opens.

## Development & Execution

- Use the root `pnpm fleetd` script for development.
- Installed or linked `fleetd` commands enter through `bin/fleetd.mjs`.

## Operational Standards

- ESM-only with TypeScript `NodeNext`.
- Local imports use `.js` specifiers.
- Do not mutate `process.env`; child process env overlays use copies.
- Raw ANSI flow is allowed for this trusted PoC.
