# Execution

Agent and Terminal are one execution feature, not plugins. AI Gateway is a separate Console feature.

## Constraints

- Console owns Agent and Terminal bodies, session lifecycle, preferences, and terminal assets.
- Agent prompt settings live in the Console slot's settings file (`agent` section), injected as a port; execution never resolves that path itself. Terminal font is server-durable Console state; renderer choice is browser-local.
- System-font choices are host-classified and consumed through the shared Font Picker boundary.
- Agent text and thought frames are deltas. Replay and live frames share monotonic event semantics, and thought content must not become the public output tail.
- Objective activity comes from SDK turn boundaries, pending approvals, and the Chat live job ledger. Background-pending prevents false idle without claiming working. Legacy PTY activity adapters remain compatibility readers only: unknown titles or unreadable lists stay opinionless, never idle.
- `chatActive` owns the activity fields even while no SDK child runs; Chat never reports dormant. Legacy non-chat records retain their ended/resume surface, and explicit resume adopts them into Chat, clearing prior adapter values. They never launch an Objective PTY. When changing activity, hooks, job ledgers, or legacy adoption, read `host/agent/activity-reference.md` for TTL, resident-task exclusion, and event-ordering constraints.
- Before spawning shell or agent children, strip Desktop/Console ownership, protocol, and resource hints while preserving the Console directory and session identifiers required by capture hooks. A Chat Mode SDK child additionally drops the inherited session identifier — it has none of its own, so an inherited one makes its hooks report into another session's axis.
