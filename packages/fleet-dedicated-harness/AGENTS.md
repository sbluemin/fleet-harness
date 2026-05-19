# Fleet Dedicated Harness Doctrine

`packages/fleet-dedicated-harness` is a standalone Fleet host PoC for embedding one first-class local CLI process inside a permanent vertical two-pane Fleet TUI.

## Package Identity & Boundary

This package owns the local host assembly for the Dedicated CLI PTY and Fleet PTY lower pane.

- **Must Own**: `PtyHost` adapter, generic `tui/**` engine candidate, host `controls/**`, host `sections/**`, layout composition, Fleet PTY region API, and CLI process lifecycle.
- **Must Not Own**: Fleet domain logic, carrier persona definitions, Pi-specific extensions, or engine packages.
- **Dependencies**: Restricted to `@sbluemin/fleet-core`, `@sbluemin/fleet-carriers`, `@sbluemin/fleet-wiki`, `@sbluemin/fleet-wiki-web`, `@xterm/headless`, and `node-pty`.

`@sbluemin/fleet-tui`, `@sbluemin/fleet-harness`, and `engines/*` are permanently forbidden dependencies.

## Canonical Layout

Only the permanent vertical two-pane layout is allowed:

- **Dedicated CLI PTY**: Upper pane, backed by `PtyView`, `PtyHost`, and `node-pty` under `src/tui/pty/dedicated/**`.
- **Fleet PTY**: Lower pane, backed by generic `src/tui/pty/fleet/api.ts` and host-composed default content from `src/sections/default-sections.ts`.
- **Shared PTY negotiation**: `src/tui/pty/{types.ts,manager.ts}` owns desired-height layout and synchronized resize propagation.
- **Generic input core**: `src/tui/input/**` owns keyboard routing, shortcut registry, conflict checks, and programmatic PTY input.
- **Host control policy**: `src/controls/modes.ts` owns MIRROR/DEDICATED mode semantics.
- **Host sections**: `src/sections/**` owns the default Fleet PTY blue wireframe content.

Horizontal layouts, tabs, multi-pane layouts, and layout engines are out of scope.

## Fleet PTY API

`src/tui/pty/fleet/api.ts` is the only external Fleet PTY API for overlays and region replacement.

External domains must not import `src/tui/pty/fleet/region-stack.ts`, `overlay-manager.ts`, `sections.ts`, `types.ts`, or other Fleet PTY internals directly.

Fleet PTY components may expose `desiredHeight(maxRows)` for vertical two-pane negotiation. `MIN_DEDICATED_ROWS` is preserved by the split manager.

`carrier-status/` is the first top-level implemented Option Y overlay domain and is a full domain-parity implementation of the fleet-harness carrier-status overlay. Do not simplify it back to text drafts, flat rendering, or partial key handling. It must consume only `src/tui/pty/fleet/api.ts` from outside Fleet PTY internals.

## Input & Mode Logic

- `MIRROR` mode forwards Fleet PTY keystrokes to the Dedicated CLI PTY.
- `DEDICATED` mode gives exclusive control to the Dedicated CLI PTY.
- `Ctrl+T` toggles between modes.
- The Fleet PTY owns no visible text input.

## Slot Rules

Tier-2/3 slots are README-only until later plans open them.

Do not create `bridge/`, `grand-fleet/`, or `components/`.

Host-specific domain content must live outside `src/tui/**`, in top-level first-class directories such as `carrier-status/`, `controls/`, `sections/`, `runtime/`, or `dedicated-cli/`.

## Development & Execution

- Use the root `pnpm fleetd` script for development.
- Installed or linked `fleetd` commands enter through `bin/fleetd.mjs`.

## Operational Standards

- ESM-only with TypeScript `NodeNext`.
- Local imports use `.js` specifiers.
- Do not mutate `process.env`; child process env overlays use copies.
- Raw ANSI flow is allowed for this trusted PoC.
