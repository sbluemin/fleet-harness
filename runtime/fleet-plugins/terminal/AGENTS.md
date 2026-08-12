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
- Agent prompt settings use Fleet global settings. Terminal font is server-durable plugin state; renderer choice is browser-local. Console core must not own either terminal preference.
- System-font choices are host-classified and consumed through the shared Font Picker boundary.
- Global Shell starts at the active Theater root and uses one deterministic reserved PTY identity per Theater. It remains browser-Origin and terminal-authorization gated, and Theater resolution must finish before capacity checks or ticket issuance.
- Closing or collapsing its panel, or switching Theaters, must not destroy a Global Shell PTY; returning to a Theater reattaches its existing session and replays only that Theater's server-owned scrollback.
- Agent text and thought frames are deltas. Replay and live frames share monotonic event semantics, and thought content must not become the public output tail.
- Agent activity has one authority per axis: the agent CLI's OSC terminal title decides whether the model is working, input-waiting hooks decide the awaiting state that titles cannot distinguish from idle, hook turn state is only the fallback for an unrecognized title, and the live background-task list carried on the turn-stop and subagent-stop hook payloads is the sole authority for background-pending work that outlives the turn. That list is applied as an absolute value, never as a spawn/stop tally: one workflow tool call fires a single spawn but one stop per workflow agent, so any counter drains while the workflow is still running. A stopping subagent is still listed as live in its own payload and must be excluded by its agent id, and that exclusion has to be remembered for the rest of the session: a named agent stays resident and listed as running after its work is done, so a payload alone can never tell resident from busy, and re-reading it as live work would wedge the operation out of idle and awaiting. The remembered ids are pruned by the next fully readable list that no longer carries them, and shell background tasks stay out of this axis. Turn end carries its own report inside the turn-state signal rather than through a second hook on the same event, because hooks sharing an event run in parallel and a turn end that lands alone reads as a false idle for that frame — a spurious turn-ended notification and an idle arrival. Background-pending must never claim the working axis; it only prevents a false idle, blocks idle dormancy while set, and decays after a bounded TTL because hook delivery is best-effort — a lost stop hook must never wedge the badge on forever. The title says that something is working, never whose work it is, so a title still working after turn end is read as the pending background work rather than as a running turn, and running wins only while a turn is in flight. Its working vocabulary is a glyph alphabet the CLI restyles between releases, so it is matched by family and several families stay matched at once. An unrecognized title, and a background report whose task list cannot be read, must stay opinionless so vocabulary drift degrades to the prior state instead of a false idle.
- Before spawning shell or agent children, strip Desktop/Console ownership, protocol, and resource hints while preserving the Console directory and session identifiers required by capture hooks.
