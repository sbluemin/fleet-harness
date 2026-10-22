# Codex Plugin

Codex owns Wiki storage, retrieval, schemas, entry history, UI, and Admiral Wiki MCP registration. Wiki implementation lives in `server/wiki/`; its `CLAUDE.md` owns storage and tool trust boundaries. The standalone Fleet CLI does not register Codex Wiki tools.

## Boundaries

- Codex runs no agent session of its own. A reader comment or question attaches as a quote chip to a commander's or the Commodore's composer through the host composer capability; attaching never sends.
- Every Wiki entry write, including a commander's revision, applies directly through host-only Wiki tools or the Console's confirmed delete and undo. Each write is serialized by the knowledge-root write lock, honors optional base checks, snapshots any overwritten or deleted entry into history, and appends a `log.md` audit line. There is no review queue.
