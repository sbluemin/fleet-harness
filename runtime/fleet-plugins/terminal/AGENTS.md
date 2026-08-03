# Terminal Plugin

The built-in Terminal plugin owns Shell and Agent Operations, including PTY sessions, tickets, WebSocket transport, and terminal rendering.

## Directory index

| Directory | Responsibility |
|---|---|
| `client/agent/`, `client/shell/` | Agent and shell Operation bodies |
| `client/global-shell/`, `client/shared/` | Theater-wide Global Shell and shared terminal client runtime |
| `server/agent-api/` | Agent launch and observation runtime |
| `server/shared/` | PTY, ticket, transport, and shared server capabilities |
| `tests/` | Plugin lifecycle, security, settings, and stream contracts |

## Constraints

- Console owns Operation chrome and path selection; Terminal owns its bodies, session lifecycle, preferences, and terminal-only assets.
- Agent prompt and metaphor settings use Fleet global settings. Terminal font is server-durable plugin state; renderer choice is browser-local. Console core must not own either terminal preference.
- System-font choices are host-classified and consumed through the shared Font Picker boundary.
- Global Shell starts at the active Theater root and uses one deterministic reserved PTY identity per Theater. It remains browser-Origin and terminal-authorization gated, and Theater resolution must finish before capacity checks or ticket issuance.
- Closing or collapsing its panel, or switching Theaters, must not destroy a Global Shell PTY; returning to a Theater reattaches its existing session and replays only that Theater's server-owned scrollback.
- Agent text and thought frames are deltas. Replay and live frames share monotonic event semantics, and thought content must not become the public output tail.
- Agent activity has one authority per axis: the agent CLI's OSC terminal title decides whether the model is working, input-waiting hooks decide the awaiting state that titles cannot distinguish from idle, hook turn state is only the fallback for an unrecognized title, and subagent spawn/stop hooks are the sole authority for background-pending work that outlives the turn. Background-pending must never claim the working axis; it only prevents a false idle, blocks idle dormancy while set, and decays after a bounded TTL because hook delivery is best-effort — a lost stop hook must never wedge the badge on forever. An unrecognized title must stay opinionless so title-vocabulary drift degrades to hook-only behavior instead of a false idle.
- Before spawning shell or agent children, strip Desktop/Console ownership, protocol, and resource hints while preserving the Console directory and session identifiers required by capture hooks.
