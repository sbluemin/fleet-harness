# Fleet Wiki 구현 참조

Wiki 도구 동작·저장 형식·스키마를 변경할 때 해당 절을 읽는다. 승인·노출 경계는 이 디렉터리의 `CLAUDE.md`가 소유한다.

## Tools

- `wiki_briefing` — Targeted wiki entry lookup and context pack generation. `enhanced=true` opt-in adds alias/type/status/freshness boost, snippet around match, and graph boost via canonical link/backlink count (inline BM25-style). Default `enhanced=false` keeps deterministic substring ranking.
- `wiki_drydock` — Deterministic lint gate covering frontmatter, links, queue integrity, safety, schema health, conflicts, claim sidecars, and semantic issues (orphan/stale/deprecated/superseded/duplicate-alias/contradiction/duplicate-frontmatter). Accepts optional `fix` parameter (default dry-run, opt-in auto-cleanup).
- `wiki_ingest` — Captures immutable raw source and stages a patch. `mode` parameter (`auto` / `create` / `update`) plus optional `base_version`, `base_hash`, `duplicate_policy`. `duplicate_policy="append_evidence"` enqueues a warning for raw-source contradictions while preserving existing body. Conflicts persisted to `.fleet/knowledge/conflicts/` for inspection.
- `wiki_patch_edit` — Precisely edits an already-pending queue proposal in place before approval. Preserves `patch_id`, utilizes in-process mutex to prevent races, and does not write new raw sources.
- `wiki_patch_queue` — Lists, approves, or rejects pending patches through human approval. Employs per-patch mutex to block concurrent edits or decision interleaving during the approval flow. `action="approve_set"` accepts a `patch_set_id` for batch approval of patches staged together by `wiki_compile_source`.
- `wiki_orient` — Workspace orientation snapshot (schema summary, index catalog, recent log entries, pending queue count, drydock status, four-rule trust boundary array, deterministic `max_tokens` truncation).
- `wiki_read` — Multi-entry full-content read with `mode` (`full` / `summary` / `facts` / `diffable`), `include_raw_source`, `include_related`, deterministic `max_tokens` truncation. All output is boundary-wrapped; raw source uses `trust="untrusted"`.
- `wiki_resolve` — Context-pack synthesizer combining briefing + read into compact JSON or `markdown_pack` output. Honors `freshness` (`prefer_recent` / `strict_current` / `any`), pulls claim provenance from `.claims/` sidecars when present, and reports `missing_or_uncertain`.
- `wiki_compile_source` — Multi-page batch ingest from a single source. `mode="preview"` returns proposed patches without mutation; `mode="stage"` enqueues correlated patches under one `patch_set_id` (`queue/_sets/{id}/meta.json`).
- `wiki_query` — Citation-aware query interface. `mode="answer"` returns context_pack + citations with no mutation; `mode="stage_answer_page"` (or `save_good_answer=true`) stages a wiki page patch under `wiki/queries/` or `wiki/synthesis/`. Claim sidecar auto-staging is deferred until queue auxiliary-file support is introduced; for now sidecars must be written manually via `writeClaims()`.
- `wiki_schema_list` — Host-only catalog of the workspace schema and available templates.
- `wiki_schema_read` — Host-only read of `schema/wiki-schema.md` or one named template.
- `wiki_schema_create` — Host-only direct creation of a new custom schema template; never updates or overwrites an existing template.
- `wiki_draft_read` — Cowork session-scoped draft snapshot reader; not globally registered and accepts no path or entry ID.
- `wiki_draft_edit` — Cowork session-scoped CAS draft editor; not globally registered and accepts no path or entry ID.
- `wiki_draft_write` — Cowork session-scoped draft replacement writer; not globally registered and accepts no path or entry ID.

Wiki entry writes normally use the patch queue; the Cowork exception moves the approval gate to one final session Apply (`enqueuePatch` plus programmatic `approvePatch`) while retaining human approval and audit traceability. Schema template creation is separate: host-only `wiki_schema_create` is direct and create-only.

## Key Modules

- `src/log.ts` — Append-only operational log helpers. Exports `appendLog()`, `parseLog()`, `formatLogEntry()` for `.fleet/knowledge/log.md`. Payload values are escaped (newlines → `\n`, backticks → `` \` ``) so multiline user input cannot break the single-bullet line invariant.
- `src/schema.ts` — Workspace schema bootstrap, catalog, read, and create-only template validation. Exports `ensureWorkspaceSchema()`, `readWorkspaceSchemaSummary()`, `readSchemaCatalog()`, `readSchemaDocument()`, `createSchemaTemplate()`, default schema constants, and required section definitions.
- `src/store.ts` — Wiki entry storage, `index.json` + `wiki/index.md` generation, raw source management with content-hash filename suffix. `readWikiEntry()` falls back to recursive scan when `index.json` is stale. `writeWikiEntry()` automatically strips duplicate leading frontmatter from the body before serialization. Also the canonical wiki-link SSoT (`WIKI_LINK_PATTERN`, `extractWikiLinks()`, `extractLegacyMarkdownWikiLinks()`, `replaceWikiLinksWithMarkdown()`) and the retrieval boundary SSoT (`wrapWikiEntryBoundary()`, `wrapWikiRawSourceBoundary()`, `FLEET_WIKI_BOUNDARY_GUIDELINES` four-rule array) used by every LLM-facing tool.
- `src/patch.ts` — Patch queuing, validation (`create_wiki` overwrite prevention, target/body collision detection), approval/rejection. `buildPatchId()` hashes timestamp + summary + target + body to prevent compile_source ID collisions. The module-level lock Maps (`approvalLocks` / `patchEditLocks`) are an intended exception to the no-module-level-singleton rule: they implement the in-process per-patch mutex shared by tool and direct (console Codex) call paths. Also owns `PatchSet` metadata (`buildPatchSetId()`, `writePatchSet()`, `readPatchSet()`) stored at `queue/_sets/{patch_set_id}/meta.json`.
- `src/conflicts.ts` — Conflict persistence under `.fleet/knowledge/conflicts/{id}/`. Exports `createConflict()`, `listConflicts()`, `readConflict()`, `resolveConflict()`. Triggered by ingest auto-mode, base_version mismatch, duplicate alias, raw source contradiction, or patch body/target id mismatch.
- `src/claims.ts` — Claim provenance sidecar at `wiki/.claims/{id}.json` with `ClaimSet`/`Claim`/`ClaimSourceRef` types. Exports `readClaims()`, `writeClaims()`, `listClaims()`. Optional — `wiki_resolve` falls back to summary if absent.
- `src/search.ts` — Optional enhanced ranker for `wiki_briefing`. Inline BM25-style scoring with alias/type/status/freshness/graph boost, no new dependency. Default ranker remains the deterministic substring scorer in `briefing.ts`.
- `src/drydock.ts` — Lint rules including canonical/legacy link checks, frontmatter validation, duplicate frontmatter detection with optional auto-cleanup, schema health, conflict surfacing, and Wave 13 semantic issues (orphan/stale/deprecated/superseded/duplicate alias/contradiction marker/claim orphan/claim malformed).
- `src/tools/draft.ts` — Private Cowork draft-tool factory; closure-scoped to one session and intentionally absent from the global registry.
- `src/prompts.ts` — Tool prompt snippets, guidelines, and TypeBox schemas. References `schema/wiki-schema.md` for workspace conventions.
- `src/paths.ts` — Memory path resolution, `ensureMemoryRoot()` bootstraps schema files via `ensureWorkspaceSchema()`.

## Schema & Documentation

- Workspace conventions live in `.fleet/knowledge/schema/wiki-schema.md` (auto-generated with `ensureWorkspaceSchema()`).
- Maintainer guide in `.fleet/knowledge/schema/AGENTS.md` defines schema ownership and edit-preservation policy.
- Canonical wiki link syntax is `[[wiki:id]]` (cross-layer standard used by leaf package and web surface).
- `index.md` at `.fleet/knowledge/wiki/index.md` provides deterministic markdown catalog with id ordering and tag grouping.
- `log.md` at `.fleet/knowledge/log.md` append-only operational chronicle of ingest, patch, rebuild, drydock, and conflict events.
- `conflicts/{id}/` stores `meta.json` + `current.md` + `proposed.md` + `raw-source.md` (when applicable). Surfaced via `wiki_drydock` `conflict_unresolved` warnings and the web `/conflicts` route (the `unresolved_conflict` code is reserved for corrupted conflict entries).
- `wiki/.claims/{id}.json` claim sidecars are optional but enable provenance-tracked `wiki_resolve` facts. Schema: `{ entryId, claims: [{ id, text, sourceRefs: [{ ref, quote, span }], confidence }] }`.
