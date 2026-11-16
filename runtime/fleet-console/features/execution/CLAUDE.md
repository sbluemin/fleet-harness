# Execution

Agent and Terminal are one execution feature, not plugins. AI Gateway is a separate Console feature.

## Constraints

- Console owns Agent and Terminal bodies, session lifecycle, preferences, and terminal assets.
- Agent prompt settings live in the Console slot's settings file (`agent` section), injected as a port; execution never resolves that path itself. Terminal font is server-durable Console state; renderer choice is browser-local.
- System-font choices are host-classified and consumed through the shared Font Picker boundary.
- Agent text and thought frames are deltas. Replay and live frames share monotonic event semantics, and thought content must not become the public output tail.
- Objective activity comes from SDK turn boundaries, pending approvals, and the Chat live job ledger. Background-pending prevents false idle without claiming working. Keep one authority for each activity field.
- All Objective sessions are chats and remain live even while no SDK child runs. Do not reintroduce terminal surfaces, surface-conversion markers, or legacy adoption branches. When changing activity, job ledgers, or session lifecycle, read `host/agent/activity-reference.md` for resident-task exclusion, event ordering, and writer-ownership constraints.
- Before spawning shell or agent children, strip Desktop/Console ownership, protocol, and resource hints; preserve only the host context that the child route explicitly needs. An Objective SDK child must not inherit another session's Console identity: its events belong to its own SDK session, never the parent's activity fields.
