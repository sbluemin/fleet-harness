# Codex Plugin

Codex owns Wiki storage, retrieval, schemas, patch approval, UI, and Admiral Wiki MCP registration. Wiki implementation lives in `server/wiki/`; its `CLAUDE.md` owns storage and tool trust boundaries. The standalone Fleet CLI does not register Codex Wiki tools.

## Boundaries

- Codex runs no agent session of its own. A reader comment or question attaches as a quote chip to a commander's or the Commodore's composer through the host composer capability; attaching never sends.
- Every Wiki entry write, including a commander's revision, goes through the human-approved patch queue with stale-base checks and an audit trail.
