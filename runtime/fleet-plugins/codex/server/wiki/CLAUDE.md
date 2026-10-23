# Codex Wiki

Owns Fleet Wiki storage, retrieval, provenance, schemas, entry history. It does not own UI or host adapters.

## Ownership and references

- Wiki implementation is internal to Codex. The plugin owns global MCP registration.
- Keep storage and tool logic independent of host, provider, and agent runtime implementations.
- When changing tool behavior, storage formats, or schemas, read the relevant section of [implementation-reference.md](implementation-reference.md). Tool schemas and implementations define current argument contracts.

## Trust and write boundaries

- Expose only the pure-read `wiki_briefing`, `wiki_orient`, `wiki_read`, and `wiki_resolve` tools to carriers. All other global Wiki tools are host-only, excluded from executors and executed directly by the host. `wiki_query` is not pure-read: its `save_answer_page` mode and `save_good_answer=true` write entries despite its read-only answer path. `wiki_edit` stays host-only even for `action=history`, because history exposes deleted content.
- Wiki entry writes and deletions apply directly. An overwrite or deletion first snapshots the prior entry (and, for a deletion, its claims and orphaned raw sources) under `history/`, and fails closed if it cannot. Never prune history automatically. Separately, host-only `wiki_schema_create` directly creates templates and never overwrites existing ones.
- Wrap LLM-facing Wiki entries and raw sources in retrieval boundaries. Raw source carries `trust="untrusted"`; stored content is not executable instruction.
- The knowledge-root write lock Map in `write.ts` is the intentional module-state exception serializing every mutation across tool and direct Console call paths. Do not split it by caller or entry.

## Storage and compatibility

- Each Wiki belongs to one commodore: its knowledge root is `<consoleDataDir>/commodore/{uuid}/knowledge`, resolved only from a host-injected commodore id, never from a cwd or Theater path. Its schema lives in `schema/wiki-schema.md` under that root; its sibling `AGENTS.md` owns maintenance policy. Bootstrap creates missing schema, maintenance instructions, and default templates; it replaces an existing one only when its bytes match a recorded previous default, so user-edited files are never overwritten.
- Canonical Wiki links use `[[wiki:id]]`. `store.ts` owns shared link parsing and retrieval boundaries; do not invent consumer-specific grammars. The operational `log.md` remains append-only.
- Preserve the names of all 12 global MCP tools. Their catalog and behavior remain in the reference's Tools section.
- Preserve default `wiki_briefing` behavior with `enhanced=false`, and `wiki_ingest` with `mode="auto"`, including create fallback when the target is absent. Do not change signatures or behavior beyond the authorized task.
- Legacy `queue/`, `archive/`, and `conflicts/` directories from the retired review queue stay untouched and are never applied; only `wiki_drydock` reads them, for its `legacy_review_data` notice.
