# Fleet Dedicated Harness

Standalone Tier-1 Dedicated Harness PoC for running one of five local CLIs inside a permanent vertical two-pane Fleet terminal.

## What This Package Owns

- Boots Fleet runtime state through the public `@sbluemin/fleet-core` root barrel.
- Hosts `claude`, `codex`, `gemini`, `opencode`, or `cursor-agent` through a `node-pty` backed Dedicated CLI PTY.
- Renders the upper Dedicated CLI PTY and lower Fleet PTY through the generic `src/tui/**` engine candidate.
- Keeps host control policy in `src/controls/**` and default Fleet PTY blue wireframe content in `src/sections/**`.
- Exposes `src/tui/pty/fleet/api.ts` as the generic lower-pane replacement for Pi `ctx.ui.custom`, `setHeader`, and coding-agent `EditorReplace` patterns.
- Opens the full parity carrier-status overlay with `Alt+O`; it restores grouped carrier rendering, model/effort editing, CLI migration, rename, sortie, Squadron, reset, and TaskForce backend editing.

## Boundary

Allowed runtime dependencies are:

- `@sbluemin/fleet-core`
- `@sbluemin/fleet-carriers`
- `@sbluemin/fleet-wiki`
- `@sbluemin/fleet-wiki-web`
- `@xterm/headless`
- `node-pty`

`@sbluemin/fleet-tui`, `@sbluemin/fleet-harness`, `@sbluemin/fleet-ai`, `@sbluemin/fleet-agent`, `@sbluemin/fleet-coding-agent`, and `engines/*` are permanently forbidden dependencies.

## CLI Selection

Selection priority is:

1. `--cli <id>` or `--cli=<id>`
2. `FLEET_DEDICATED_CLI`
3. `claude`

Supported ids are `claude`, `codex`, `gemini`, `opencode`, and `cursor-agent`.

Each CLI also supports an uppercase binary override: `CLAUDE_BIN`, `CODEX_BIN`, `GEMINI_BIN`, `OPENCODE_BIN`, and `CURSOR_AGENT_BIN`.

## Commands

```sh
pnpm --filter @sbluemin/fleet-dedicated-harness build
pnpm fleetd
```

The package is ESM-only and builds with TypeScript NodeNext.

## Tier-2/3 Slots

Tier-2/3 slots are README-only covers in this plan. No implementation code, imports, or exports may be added under those slots until a later plan opens them.

`carrier-status/` is a top-level implemented Option Y overlay domain. `bridge/`, `grand-fleet/`, and `components/` are not valid Dedicated Harness slots. Host-specific domain content lives outside `src/tui/**`; `src/tui/**` stays the generic engine candidate.

## V3 Tree

- `src/tui/input/**`: generic input router, keybinding registry, conflict checks, and programmatic input API.
- `src/tui/pty/fleet/api.ts`: generic Fleet PTY API and the only external Fleet PTY entrypoint.
- `src/controls/modes.ts`: host MIRROR/DEDICATED mode policy.
- `src/sections/default-sections.ts`: host-composed default lower-pane content.
- `src/carrier-status/**`: full parity carrier-status overlay domain.

## Fleet PTY Overlay Lifecycle

`fleetPty.custom<T>()` mounts a focused lower-pane component, routes Fleet PTY input to it, resolves when the component calls `done(result)`, disposes the component if needed, and returns to the host-composed default Fleet PTY section composite.

Fleet PTY components may expose `desiredHeight(maxRows)`. `src/tui/pty/manager.ts` reads that value, asks `split-pane.ts` for the permanent vertical two-pane split, preserves `MIN_DEDICATED_ROWS`, and resizes both the Dedicated CLI PTY view and child `PtyHost` through one path.

Carrier status parity smoke path:

```text
Alt+O -> Enter -> model -> effort -> c -> C -> N -> d -> S -> R -> t -> Enter -> effort -> r -> Esc
```

If `Alt+O` is pressed while an overlay is active, the active overlay is dismissed and carrier status is reopened.

## Security Assumptions

- PoC scope, trusted environment only. Raw ANSI output from the selected CLI is rendered directly.
- Child PTY environments are built from a copy of `process.env` plus CLI overlays. The host `process.env` is not mutated.

## Known Operational Notes

Some macOS `pnpm install` paths drop the executable bit on `node-pty`'s `spawn-helper`, causing `posix_spawnp failed.` at runtime. Fix once after install:

```sh
chmod +x node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/$(node -p "process.platform + '-' + process.arch")/spawn-helper
```
