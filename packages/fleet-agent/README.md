# Fleet Agent

Primary CLI host for running local CLIs inside a permanent vertical two-pane Fleet terminal.

## What This Package Owns

- Boots Fleet runtime state as the sole Composition Root through direct leaf service registration.
- Owns absorbed Admiral prompt/protocol/tool/MCP policy in `src/admiral/**` and Grand Fleet helpers in `src/grand-fleet/**`.
- Hosts `claude` or `codex` through a `node-pty` backed CLI PTY.
- Renders the upper CLI PTY and lower Fleet PTY through `@dotobokuri/fleet-tui`.
- Keeps host control policy in `src/controls/**` and default Fleet PTY wireframe content in `src/sections/**`.
- Manages CLI launch and environment injection through `src/dedicated-cli/**`.
- Uses `@dotobokuri/fleet-tui/pty` as the generic lower-pane replacement for legacy TUI patterns.
- Opens the carrier-status overlay with `Alt+O`; it handles carrier rendering, model/effort editing, reset, and TaskForce backend editing.

## Boundary

Allowed workspace dependencies are:

- `@dotobokuri/fleet-carriers`
- `@dotobokuri/fleet-infra`
- `@dotobokuri/fleet-mcp-server`
- `@dotobokuri/fleet-tui`
- `@dotobokuri/fleet-wiki`
- `@dotobokuri/fleet-wiki-web`

Execution-engine packages such as `@dotobokuri/fleet-unified-agent` are permanently forbidden direct dependencies.

## CLI Selection

Selection priority is:

1. `--cli <id>` or `--cli=<id>`
2. `FLEET_DEDICATED_CLI`
3. `claude`

Supported ids are `claude`, `claude-zai`, `claude-kimi`, and `codex`.

Each CLI also supports an uppercase binary override: `CLAUDE_BIN` and `CODEX_BIN`.

## Options

`--help` prints options in two categories:

- **Fleet Agent Options** — flags that control Fleet behavior (`--cli`, `--native`, `--disable-cursor-sync`, `--replace-system-prompt`, `--enable-metaphor`).
- **Underlying CLI Options** — flags forwarded verbatim to the selected dedicated CLI.

### `--model <name>`

Forward a model name to the selected dedicated CLI. The value is passed as `--model <value>` to the underlying CLI without validation by Fleet.

Example:

```sh
fleet --cli claude --model claude-opus-4-7
fleet --cli codex --model o4-mini
```

## Commands

```sh
pnpm --filter @dotobokuri/fleet-agent build
pnpm fleet
```

The package is ESM-only and builds with TypeScript NodeNext.

## V4 Tree

- `@dotobokuri/fleet-tui/input`: generic input router, keybinding registry, conflict checks, and programmatic input API.
- `@dotobokuri/fleet-tui/pty`: generic Fleet PTY API, CLI PTY infrastructure, and shared resize negotiation.
- `src/controls/modes.ts`: host mode policy.
- `src/sections/default-sections.ts`: host-composed default lower-pane content.
- `src/carrier-status/**`: carrier-status overlay domain.

## Fleet PTY Overlay Lifecycle

`fleetPty.custom<T>()` mounts a focused lower-pane component, routes Fleet PTY input to it, resolves when the component calls `done(result)`, disposes the component if needed, and returns to the host-composed default Fleet PTY section composite.

Fleet PTY components may expose `desiredHeight(maxRows)`. `@dotobokuri/fleet-tui/pty` reads that value, asks the permanent vertical two-pane split helper for sizing, preserves `MIN_DEDICATED_ROWS`, and resizes both the CLI PTY view and child `PtyHost` through one path.

## Security Assumptions

- Trusted environment only. Raw ANSI output from the selected CLI is rendered directly.
- Child PTY environments are built from a copy of `process.env` plus CLI overlays. The host `process.env` is not mutated.
