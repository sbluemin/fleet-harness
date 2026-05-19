# Fleet Dedicated Harness Doctrine

`packages/fleet-agent` is a standalone Fleet host PoC for embedding one first-class local CLI process inside a permanent vertical two-pane Fleet TUI.

## Package Identity & Boundary

This package owns the local host assembly for the Dedicated CLI PTY and Fleet PTY lower pane.

- **Must Own**: local host assembly, host `controls/**`, host `sections/**` (including dynamic section registry), carrier-status domain wiring (including Job Bar strip + detail Fleet PTY sections, Pattern B active-only frame ticker), dedicated CLI profile resolution, CLI process lifecycle, and programmatic PTY input bridge.
- **Must Not Own**: Fleet domain logic, carrier persona definitions, Pi-specific extensions, or engine packages.
- **Dependencies**: Restricted to `@sbluemin/fleet-core`, `@sbluemin/fleet-carriers`, `@sbluemin/fleet-tui`, `@sbluemin/fleet-wiki`, and `@sbluemin/fleet-wiki-web`.

`@sbluemin/fleet-harness` and `engines/*` are permanently forbidden dependencies. The Job Bar functionality formerly in `fleet-harness` is now fully absorbed into `fleet-agent`. The allowed `@sbluemin/fleet-tui` package is the first-party package under `packages/fleet-tui`, not the engines-era workspace dependency.

## Canonical Layout

Only the permanent vertical two-pane layout is allowed:

- **Dedicated CLI PTY**: Upper pane, backed by `PtyView`, `PtyHost`, and `node-pty` infrastructure from `@sbluemin/fleet-tui/pty`.
- **Fleet PTY**: Lower pane, backed by generic `@sbluemin/fleet-tui/pty`.
  Host-composed content lives in `src/sections/default-sections.ts` (static wireframes) and `src/carrier-status/job-bar-section.ts` (dynamic job status).
- **Shared PTY negotiation**: `@sbluemin/fleet-tui/pty` owns desired-height layout and synchronized resize propagation.
- **Generic input core**: `@sbluemin/fleet-tui/input` owns keyboard routing, shortcut registry, conflict checks, and programmatic PTY input.
- **Host control policy**: `src/controls/modes.ts` owns MIRROR/DEDICATED mode semantics.
- **Host sections**: `src/sections/**` owns the default Fleet PTY blue wireframe content. Dynamic Job Bar sections are managed via `src/carrier-status/job-bar-register.ts`.

## Fleet PTY API

`@sbluemin/fleet-tui/pty` is the only external Fleet PTY API for overlays and region replacement.

External domains must not import Fleet PTY internals such as `region-stack.ts`, `overlay-manager.ts`, `types.ts`, or package deep paths directly.

Fleet PTY components may expose `desiredHeight(maxRows)` for vertical two-pane negotiation. `MIN_DEDICATED_ROWS` is preserved by the split manager.

`carrier-status/` is the first top-level implemented Option Y overlay domain and is a full domain-parity implementation of the fleet-harness carrier-status overlay. It now fully owns the Job Bar implementation (view-model, renderer, state, and registration). Do not simplify it back to text drafts, flat rendering, or partial key handling. It must consume only `@sbluemin/fleet-tui/pty` from outside Fleet PTY internals.

## Input & Mode Logic

- `MIRROR` mode forwards Fleet PTY keystrokes to the Dedicated CLI PTY.
- `DEDICATED` mode gives exclusive control to the Dedicated CLI PTY.
- `Ctrl+T` toggles between modes.
- The Fleet PTY owns no visible text input.
- `dedicated-cli/bridge.ts` provides a bridge for exposing `ProgrammaticInput` to external domains.

- `Ctrl+T` toggles between modes.
- The Fleet PTY owns no visible text input.

## Slot Rules

Tier-2/3 slots are README-only until later plans open them.

Do not create `bridge/`, `grand-fleet/`, or `components/`.

Host-specific domain content must live in top-level first-class directories such as `carrier-status/`, `controls/`, `sections/`, `runtime/`, or `dedicated-cli/`. Reusable TUI infrastructure belongs in `packages/fleet-tui`.

## Development & Execution

- Use the root `pnpm fleetd` script for development.
- Installed or linked `fleetd` commands enter through `bin/fleetd.mjs`.

## Operational Standards

- ESM-only with TypeScript `NodeNext`.
- Local imports use `.js` specifiers.
- Do not mutate `process.env`; child process env overlays use copies.
- Raw ANSI flow is allowed for this trusted PoC.
