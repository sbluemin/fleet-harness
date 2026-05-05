# fleet-wiki Doctrine

`packages/fleet-wiki` is a leaf workspace package dedicated to the LLM-Wiki domain. It owns the memory store, briefing, dry-dock, patch queue/ingest tool builder, safety policy, and path resolution.

## Owns

- Pure LLM-Wiki domain logic and types under `src/`
- Single public subpath `./`
- LLM-Wiki package-specific validation under `tests/`

## Must Not Own

- Imports of `@sbluemin/fleet-core` or other workspace packages
- Imports of `@mariozechner/pi-*` or `@anthropic-ai/*`
- Pi runtime wiring, UI registration, or host-specific adapter code

## Dependency Rules

- The only allowed runtime dependency is `@sinclair/typebox`.
- Workspace package imports are strictly forbidden.
- Maintain leaf package doctrine and avoid circular dependencies.

## Tools

- `wiki_briefing` — Targeted wiki entry lookup and context pack generation.
- `wiki_drydock` — Deterministic lint gate for frontmatter, links, queue integrity, safety, and workspace schema health.
- `wiki_ingest` — Captures immutable raw source and stages a pending patch.
- `wiki_patch_queue` — Lists, approves, or rejects pending patches through human approval workflow.
- `wiki_orient` — Workspace orientation snapshot providing schema summary, index catalog, recent log entries, pending queue count, and drydock status in a single call.

## Key Modules

- `src/links.ts` — Canonical wiki link helper SSoT. Exports `WIKI_LINK_PATTERN`, `extractWikiLinks()`, `extractLegacyMarkdownWikiLinks()`, `replaceWikiLinksWithMarkdown()`.
- `src/log.ts` — Append-only operational log helpers. Exports `appendLog()`, `parseLog()`, `formatLogEntry()` for `.fleet/knowledge/log.md`.
- `src/schema.ts` — Workspace schema bootstrap and summary. Exports `ensureWorkspaceSchema()`, `readWorkspaceSchemaSummary()`, default schema constants, and required section definitions.
- `src/store.ts` — Wiki entry storage, `index.json` and `index.md` generation, raw source management.
- `src/patch.ts` — Patch queuing, validation (`create_wiki` overwrite prevention), approval/rejection workflow.
- `src/drydock.ts` — Lint rules including canonical/legacy link checks, frontmatter validation, schema health diagnostics.
- `src/prompts.ts` — Tool prompt snippets, guidelines, and schemas. References `schema/wiki-schema.md` for workspace conventions.
- `src/paths.ts` — Memory path resolution, `ensureMemoryRoot()` bootstraps schema files via `ensureWorkspaceSchema()`.

## Schema & Documentation

- Workspace conventions live in `.fleet/knowledge/schema/wiki-schema.md` (auto-generated with `ensureWorkspaceSchema()`).
- Maintainer guide in `.fleet/knowledge/schema/AGENTS.md` defines schema ownership and edit-preservation policy.
- Canonical wiki link syntax is `[[wiki:id]]` (cross-layer standard used by leaf package and web surface).
- `index.md` at `.fleet/knowledge/wiki/index.md` provides deterministic markdown catalog with id ordering and tag grouping.
- `log.md` at `.fleet/knowledge/log.md` append-only operational chronicle of ingest, patch, rebuild, and drydock events.

## Compatibility Doctrine

- Preserve the `experimentalWiki` symbol key name for downstream compatibility.
- Do not change MCP tool names: `wiki_briefing`, `wiki_drydock`, `wiki_ingest`, `wiki_patch_queue`, and `wiki_orient`.
- Forbid refactoring, signature changes, or adding new interfaces beyond the extraction objective.
