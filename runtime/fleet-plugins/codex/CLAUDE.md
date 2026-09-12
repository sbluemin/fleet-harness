# Codex Plugin

Codex owns the Wiki UI, Admiral Wiki MCP registration, and the Cowork session, draft, and session-scoped tool definitions. Shared Wiki storage, retrieval, schemas, and patch approval remain in `@dotobokuri/fleet-wiki`.

## Boundaries

- Cowork remains terminal-free; the structural `CoworkConnector` consumes the Console Agent SDK. Console owns execution and MCP resources; Codex owns draft tool closures and Apply approval.
- `wiki_draft_read`, `wiki_draft_edit`, and `wiki_draft_write` are session closure-injected tools, never global registrations. They accept no path or entry ID that could reach another entry.
- Cowork exposes only those three draft tools and the pure-read `wiki_briefing`, `wiki_orient`, `wiki_read`, and `wiki_resolve` tools. Global Admiral tools remain separate.
- Applying a draft requires the user's final Apply action and uses the Wiki patch queue with stale-base checks and an audit trail. Moving the engine does not grant automatic approval.
