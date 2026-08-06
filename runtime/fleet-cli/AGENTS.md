# Fleet CLI

`runtime/fleet-cli` is the `fleet` terminal host and CLI runtime composition root. It launches gateway-doctrine Claude Code as a native child process.

## Directory index

| Directory | Responsibility |
|---|---|
| `src/runtime/` | Fleet MCP, settings, quota, and wire-log composition |
| `src/gateway/` | Loopback AI-gateway server and Claude Code child lifecycle |
| `src/auth/`, `src/update/` | CLI subcommands |
| `src/styles/` | Help output formatting |
| `tests/` | Host composition, launch, auth, update, and release contracts |

## Constraints

- The host composes a thin native launch: one in-process Fleet MCP runtime (host-session tools only), one loopback AI-gateway HTTP server, and one Claude Code child spawned with inherited stdio. No PTY, no TUI, and no terminal input/output interception belong in this host.
- Reusable behavior enters through declared package exports (fleet-admiral launch/runtime policy; core-ai-gateway serving, quota, and settings). This host owns only composition, argv dispatch, and process lifecycle.
- Fleet Console is a peer host; Fleet CLI must not embed Console lifecycle or depend on the Console package for CLI commands.
