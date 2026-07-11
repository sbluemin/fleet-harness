# Terminal Plugin

The built-in Terminal plugin owns Shell and Agent Operations, including PTY sessions, tickets, WebSocket transport, and terminal rendering.

## Directory index

| Directory | Responsibility |
|---|---|
| `client/agent/`, `client/shell/` | Agent and shell Operation bodies |
| `client/global-shell/`, `client/shared/` | Theater-independent shell and shared terminal client runtime |
| `server/agent-api/` | Agent launch and observation runtime |
| `server/shared/` | PTY, ticket, transport, and shared server capabilities |
| `tests/` | Plugin lifecycle, security, settings, and stream contracts |

## Constraints

- Console owns Operation chrome and path selection; Terminal owns its bodies, session lifecycle, preferences, and terminal-only assets.
- Agent prompt and metaphor settings use Fleet global settings. Terminal font is server-durable plugin state; renderer choice is browser-local. Console core must not own either terminal preference.
- System-font choices are host-classified and consumed through the shared Font Picker boundary.
- Global Shell is Theater-independent and starts at the operator home directory. It is browser-Origin gated and must not resolve Theater paths.
- Closing or collapsing its panel must not destroy the Global Shell PTY; session lifecycle and scrollback replay remain server-owned.
- Agent text and thought frames are deltas. Replay and live frames share monotonic event semantics, and thought content must not become the public output tail.
- Before spawning shell or agent children, strip Desktop/Console ownership, protocol, and resource hints while preserving the Console directory and session identifiers required by capture hooks.
