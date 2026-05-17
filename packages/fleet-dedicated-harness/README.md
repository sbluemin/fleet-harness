# Fleet Dedicated Harness

Dedicated Fleet harness PoC for embedding a local Claude CLI process inside the Fleet TUI shell.

## What This Package Owns

- Boots the Fleet core runtime through `src/runtime.ts`.
- Loads the Fleet TUI and editor shell directly from `@sbluemin/fleet-tui`.
- Hosts the Claude CLI through the `node-pty`-backed `PtyHost` adapter.
- Renders the dedicated PoC layout with the Dedicated CLI PTY, active PTY divider, carrier roster, Fleet Action Protocol editor, and jobs line.

## Boundary

This package intentionally depends only on:

- `@sbluemin/fleet-tui`
- `@sbluemin/fleet-core`
- `@sbluemin/fleet-carriers`
- `@xterm/headless`
- `node-pty`

It must not depend on Fleet Pi harness, Fleet coding-agent, Fleet AI, Fleet agent, or `@anthropic-ai/*` packages.

## Commands

```sh
pnpm --filter @sbluemin/fleet-dedicated-harness build
pnpm --filter @sbluemin/fleet-dedicated-harness dev
```

The package is ESM-only and builds with TypeScript NodeNext.

## Security Assumptions

- **PoC scope, trusted environment only.** This PoC hosts the local `claude` CLI through a PTY and renders its raw output (ANSI escape sequences included) directly into the TUI. There is no sanitization of OSC/CSI control sequences. Do not point `CLAUDE_BIN` at an untrusted binary and do not feed untrusted output into the PTY.
- **`process.env` is forwarded to the PTY child as-is.** This is intentional so that the embedded `claude` CLI sees the same environment as the host shell.

## Known Operational Notes

- **`node-pty` `spawn-helper` executable bit on macOS.** Some `pnpm install` paths drop the executable bit on `node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/<plat-arch>/spawn-helper`, causing `posix_spawnp failed.` at runtime. Fix once after install:
  ```sh
  chmod +x node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/$(node -p "process.platform + '-' + process.arch")/spawn-helper
  ```
