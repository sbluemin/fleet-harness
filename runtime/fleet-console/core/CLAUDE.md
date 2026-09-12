# Console Execution

Agent, Terminal, and AI Gateway are Console-owned runtime capabilities, not plugins. Shell is a non-durable global surface, not an Operation.

## Constraints

- Console owns Agent and Terminal bodies, session lifecycle, preferences, and terminal assets.
- Agent prompt settings use Fleet global settings. Terminal font is server-durable Console state; renderer choice is browser-local.
- System-font choices are host-classified and consumed through the shared Font Picker boundary.
- Agent text and thought frames are deltas. Replay and live frames share monotonic event semantics, and thought content must not become the public output tail.
- Activity has one authority per axis: OSC titles own PTY working, with hook turn state as the fallback for an unrecognized title; input-waiting hooks own awaiting, and PTY hook lists or the Chat live job ledger own background-pending. Pending prevents false idle and idle dormancy without claiming working. Unknown PTY titles or unreadable lists remain opinionless, never idle.
- PTY and Chat are two adapters of the same activity fields. `chatActive` selects ownership; Chat must not reuse the dormant PTY `status` guard. Clear prior values when switching adapters. When changing OSC, hooks, job ledgers, or adapter transitions, read `host/agent/activity-reference.md` for TTL, resident-task exclusion, and event-ordering rationale.
- Before spawning shell or agent children, strip Desktop/Console ownership, protocol, and resource hints while preserving the Console directory and session identifiers required by capture hooks. A Chat Mode SDK child additionally drops the inherited session identifier — it has none of its own, so an inherited one makes its hooks report into another session's axis.
