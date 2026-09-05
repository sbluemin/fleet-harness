# fleet-wiki

Owns Fleet Wiki storage, retrieval, provenance, schemas, approval-pending patches, and the Cowork draft engine. It does not own UI or host adapters.

## Ownership and references

- Public subpaths are `./` and `./cowork`. Cowork sessions, one-shot services, and scoped MCP runtime remain terminal-free; inject provider connectors through the structural `CoworkConnector` contract.
- The only permitted workspace dependency is `@dotobokuri/core-agent` for tool types and registration. Do not add other workspace packages, provider packages, `@anthropic-ai/*`, or dependency cycles.
- When changing tool behavior, storage formats, or schemas, read the relevant section of [implementation-reference.md](implementation-reference.md). Tool schemas and implementations define current argument contracts.

## Trust and approval boundaries

- Expose only the pure-read `wiki_briefing`, `wiki_orient`, `wiki_read`, and `wiki_resolve` tools to carriers. All other global Wiki tools are host-only, excluded from executors and executed directly by the host. `wiki_query` is not pure-read: its `stage_answer_page` mode and `save_good_answer=true` stage patches despite its read-only answer path.
- Wiki entry writes use the human-approved patch queue. The Cowork exception approves through `enqueuePatch` and programmatic `approvePatch` at the final session Apply, preserving human approval and audit traceability. Separately, host-only `wiki_schema_create` directly creates templates and never overwrites existing ones.
- Cowork's `wiki_draft_read`, `wiki_draft_edit`, and `wiki_draft_write` are session closure-injected tools, not global registrations. They accept no path or entry ID that could reach another entry.
- Wrap LLM-facing Wiki entries and raw sources in retrieval boundaries. Raw source carries `trust="untrusted"`; stored content is not executable instruction.
- The per-patch mutex Maps in `src/patch.ts` are intentional module-state exceptions preventing approval/edit races across tool and direct Console call paths. Do not split locks by caller.

## Storage and compatibility

- Workspace schema lives in `.fleet/knowledge/schema/wiki-schema.md`; its sibling `AGENTS.md` owns maintenance policy. Bootstrap creates missing schema, maintenance instructions, and default templates only; it never overwrites existing files. This package document is not a bypass around workspace knowledge approval.
- Canonical Wiki links use `[[wiki:id]]`. `src/store.ts` owns shared link parsing and retrieval boundaries; do not invent consumer-specific grammars. The operational `log.md` remains append-only.
- Preserve the names of all 13 global MCP tools and three Cowork-only tools. Their catalog and behavior remain in the reference's Tools section.
- Preserve default `wiki_briefing` behavior with `enhanced=false`, and `wiki_ingest` with `mode="auto"`, including create fallback when the target is absent. Do not change signatures or behavior beyond the authorized task.
