# Execution

Agent and Terminal are one execution feature, not plugins. AI Gateway is a separate Console feature. Shell is a non-durable per-conversation surface, not an Operation: one PTY per conversation key, with a Console default key for keyless callers; closing a conversation's Shell ends only that PTY.

## Constraints

- Console owns Agent and Terminal bodies, session lifecycle, preferences, and terminal assets.
- Agent prompt settings live in the Console slot's settings file (`agent` section), injected as a port; execution never resolves that path itself. Terminal font is server-durable Console state; renderer choice is browser-local.
- System-font choices are host-classified and consumed through the shared Font Picker boundary.
- Agent text and thought frames are deltas. Replay and live frames share monotonic event semantics, and thought content must not become the public output tail.
- Activity has one authority per axis: OSC titles own PTY working, with hook turn state as the fallback for an unrecognized title; input-waiting hooks own awaiting, and PTY hook lists or the Chat live job ledger own background-pending. Pending prevents false idle and idle dormancy without claiming working. Unknown PTY titles or unreadable lists remain opinionless, never idle.
- PTY and Chat are two adapters of the same activity fields. `chatActive` selects ownership and holds even while no SDK child runs; dormancy, its `status` guard, and sleep/resume belong to the PTY adapter only, and Chat never reports dormant. Clear prior values when switching adapters. When changing OSC, hooks, job ledgers, or adapter transitions, read `host/agent/activity-reference.md` for TTL, resident-task exclusion, and event-ordering rationale.
- Before spawning shell or agent children, strip Desktop/Console ownership, protocol, and resource hints while preserving the Console directory and session identifiers required by capture hooks. A Chat Mode SDK child additionally drops the inherited session identifier — it has none of its own, so an inherited one makes its hooks report into another session's axis.
