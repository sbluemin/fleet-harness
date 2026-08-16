# fleet-wiki Doctrine

`packages/fleet-wiki` is a workspace package dedicated to the LLM-Wiki domain. It depends on `@dotobokuri/core-agent` for agent tool types/registration and owns the memory store, briefing, dry-dock, patch queue/ingest tool builder, safety policy, path resolution, and Fleet Wiki agent tool self-registration.

## Owns

- Pure LLM-Wiki domain logic and types under `src/`
- Public subpaths `./` and `./cowork` — the cowork subpath owns the terminal-free AI draft-editing engine (in-memory session store, one-shot session service, scoped MCP runtime, session DTOs). Provider connectors are structural (`CoworkConnector`) and MUST be injected by hosts; the engine never imports provider packages.
- LLM-Wiki package-specific validation under `tests/`
- `@dotobokuri/core-agent` agent registry self-registration via `agent-specs.ts` (13종 wiki 도구를 doctrine으로 노출; 순수 읽기 4종 `briefing` / `orient` / `read` / `resolve`은 글로벌로 등록되어 모든 캐리어에 공개, 그 외 모든 도구 — 쓰기·stage·lint 5종 `drydock` / `ingest` / `patch_edit` / `compile_source` / `query`, schema 3종 `schema_list` / `schema_read` / `schema_create`, 승인 게이트 `patch_queue` — 는 executor에 비노출된 host-only 도구로 어떤 캐리어도 받지 않으며 호스트가 Fleet Wiki 작업을 직접 수행한다 (`wiki_query`는 `mode="stage_answer_page"` / `save_good_answer=true`에서 패치 큐에 stage하므로 read-only가 아님)). Cowork의 `wiki_draft_read` / `wiki_draft_edit` / `wiki_draft_write`는 전역 레지스트리에 등록하지 않는 세션 전용 closure-injected 도구이며, 경로 또는 엔트리 ID 인자를 받지 않는다.

## Must Not Own

- Imports of other workspace packages (except `@dotobokuri/core-agent` as noted below)
- Imports of `@anthropic-ai/*`
- UI registration or host-specific adapter code

## Dependency Rules

- `@dotobokuri/core-agent`에 한해 도구 타입/등록 의존이 허용됨.
- 다른 워크스페이스 패키지(`@dotobokuri/fleet-*` 엔진 포함) 및 `@anthropic-ai/*` 의존은 여전히 금지.
- 순환 의존성은 금지.

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

## Compatibility Doctrine

- Do not change MCP tool names: `wiki_briefing`, `wiki_drydock`, `wiki_ingest`, `wiki_patch_edit`, `wiki_patch_queue`, `wiki_orient`, `wiki_read`, `wiki_resolve`, `wiki_compile_source`, `wiki_query`, `wiki_schema_list`, `wiki_schema_read`, `wiki_schema_create`.
- Do not change Cowork-only tool names: `wiki_draft_read`, `wiki_draft_edit`, `wiki_draft_write`.
- Existing `wiki_briefing` callers must remain working with `enhanced=false` (default).
- Existing `wiki_ingest` callers must remain working with `mode="auto"` (default), which falls back to create when the target is absent.
- Forbid refactoring or signature changes beyond what these waves require.
