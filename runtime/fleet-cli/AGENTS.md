# Fleet CLI

`runtime/fleet-cli` is the `fleet` terminal host and CLI runtime composition root. It embeds an Agent CLI process in the Fleet TUI.

## Directory index

| Directory | Responsibility |
|---|---|
| `src/runtime/` | Host assembly and lifecycle |
| `src/mission-control/` | Upper interaction layer, launcher, options, and panels |
| `src/mission-bridge/` | Lower Fleet status and Job Bar domain |
| `src/controls/` | Input, PTY, panel, mouse, resize, and render adapters |
| `src/tui/`, `src/styles/` | Host-owned terminal renderer and visual vocabulary |
| `src/agent-cli/`, `src/update/` | Child integration and CLI-specific update lifecycle |
| `tests/` | Host, terminal, and composition contracts |

## Constraints

- Assembly flows one way through public Admiral and core capabilities. Carrier personas, generic execution, infrastructure, and launch policy remain in their owning packages.
- Service construction is explicit; lower layers must not reach into CLI state or receive host UI objects as domain dependencies.
- A Fleet CLI process has one in-process Fleet MCP runtime; main and executor isolation is session- and token-based, not server-per-session.
- The host embeds an upper Agent CLI PTY over a lower Fleet pane.
- After launch, input belongs to the active child PTY. Do not introduce Fleet-owned global mode or exit shortcuts.
- Fleet Console is a peer host; the Console subcommand delegates to its CLI rather than embedding Console lifecycle here.
- Treat `process.env` as read-only; derive child-specific environment copies instead of mutating process-global state.
