# fleet-wiki Doctrine

`packages/fleet-wiki` is a workspace package dedicated to the LLM-Wiki domain. It depends on `@sbluemin/fleet-mcp-server` for agent tool types/registration and owns the memory store, briefing, dry-dock, patch queue/ingest tool builder, safety policy, path resolution, and Fleet Wiki agent tool self-registration.

## Owns

- Pure LLM-Wiki domain logic and types under `src/`
- Single public subpath `./`
- LLM-Wiki package-specific validation under `tests/`
- `@sbluemin/fleet-mcp-server` agent registry self-registration via `agent-specs.ts` (10종 wiki 도구를 doctrine으로 노출; 순수 읽기 4종 `briefing` / `orient` / `read` / `resolve`은 글로벌로 등록되어 모든 캐리어에 공개, 쓰기·stage 가능 4종 `drydock` / `ingest` / `patch_edit` / `query`는 chronicle 전용으로 제한 — `wiki_query`는 `mode="stage_answer_page"` / `save_good_answer=true`에서 패치 큐에 stage하므로 read-only가 아님)

## Must Not Own

- Imports of other workspace packages (except `@sbluemin/fleet-mcp-server` as noted below)
- Imports of `@anthropic-ai/*`
- UI registration or host-specific adapter code

## Dependency Rules

- `@sbluemin/fleet-mcp-server`에 한해 도구 타입/등록 의존이 허용됨.
- 다른 워크스페이스 패키지(`@sbluemin/fleet-*` 엔진 포함) 및 `@anthropic-ai/*` 의존은 여전히 금지.
- 순환 의존성은 금지.

## Tools

- `wiki_briefing` — Targeted wiki entry lookup and context pack generation. `enhanced=true` opt-in adds alias/type/status/freshness boost, snippet around match, and graph boost via canonical link/backlink count (inline BM25-style). Default `enhanced=false` keeps deterministic substring ranking.
- `wiki_drydock` — Deterministic lint gate covering frontmatter, links, queue integrity, safety, schema health, conflicts, claim sidecars, and semantic issues (orphan/stale/deprecated/superseded/duplicate-alias/contradiction).
- `wiki_ingest` — Captures immutable raw source and stages a patch. `mode` parameter (`auto` / `create` / `update`) plus optional `base_version`, `base_hash`, `duplicate_policy`. `duplicate_policy="append_evidence"` enqueues a warning for raw-source contradictions while preserving existing body. Conflicts persisted to `.fleet/knowledge/conflicts/` for inspection.
- `wiki_patch_edit` — Precisely edits an already-pending queue proposal in place before approval. Preserves `patch_id`, utilizes in-process mutex to prevent races, and does not write new raw sources.
- `wiki_patch_queue` — Lists, approves, or rejects pending patches through human approval. Employs per-patch mutex to block concurrent edits or decision interleaving during the approval flow. `action="approve_set"` accepts a `patch_set_id` for batch approval of patches staged together by `wiki_compile_source`.
- `wiki_orient` — Workspace orientation snapshot (schema summary, index catalog, recent log entries, pending queue count, drydock status, four-rule trust boundary array, deterministic `max_tokens` truncation).
- `wiki_read` — Multi-entry full-content read with `mode` (`full` / `summary` / `facts` / `diffable`), `include_raw_source`, `include_related`, deterministic `max_tokens` truncation. All output is boundary-wrapped; raw source uses `trust="untrusted"`.
- `wiki_resolve` — Context-pack synthesizer combining briefing + read into compact JSON or `markdown_pack` output. Honors `freshness` (`prefer_recent` / `strict_current` / `any`), pulls claim provenance from `.claims/` sidecars when present, and reports `missing_or_uncertain`.
- `wiki_compile_source` — Multi-page batch ingest from a single source. `mode="preview"` returns proposed patches without mutation; `mode="stage"` enqueues correlated patches under one `patch_set_id` (`queue/_sets/{id}/meta.json`).
- `wiki_query` — Citation-aware query interface. `mode="answer"` returns context_pack + citations with no mutation; `mode="stage_answer_page"` (or `save_good_answer=true`) stages a wiki page patch under `wiki/queries/` or `wiki/synthesis/`. Claim sidecar auto-staging is deferred until queue auxiliary-file support is introduced; for now sidecars must be written manually via `writeClaims()`.

## Key Modules

- `src/links.ts` — Canonical wiki link helper SSoT. Exports `WIKI_LINK_PATTERN`, `extractWikiLinks()`, `extractLegacyMarkdownWikiLinks()`, `replaceWikiLinksWithMarkdown()`.
- `src/log.ts` — Append-only operational log helpers. Exports `appendLog()`, `parseLog()`, `formatLogEntry()` for `.fleet/knowledge/log.md`. Payload values are escaped (newlines → `\n`, backticks → `` \` ``) so multiline user input cannot break the single-bullet line invariant.
- `src/schema.ts` — Workspace schema bootstrap and summary. Exports `ensureWorkspaceSchema()`, `readWorkspaceSchemaSummary()`, default schema constants, required section definitions.
- `src/boundaries.ts` — Retrieval boundary helper SSoT. Exports `wrapEntry()`, `wrapRawSource()`, `TRUST_BOUNDARY_RULES` (four-rule array). Used by every LLM-facing tool (briefing/orient/read/resolve/query).
- `src/store.ts` — Wiki entry storage, `index.json` + `wiki/index.md` generation, raw source management with content-hash filename suffix. `readWikiEntry()` falls back to recursive scan when `index.json` is stale.
- `src/patch.ts` — Patch queuing, validation (`create_wiki` overwrite prevention, target/body collision detection), approval/rejection. `buildPatchId()` hashes timestamp + summary + target + body to prevent compile_source ID collisions.
- `src/patch-set.ts` — `PatchSet` metadata helpers. `buildPatchSetId()`, `writePatchSet()`, `readPatchSet()`, `listPatchSets()`. Stored at `queue/_sets/{patch_set_id}/meta.json`.
- `src/conflicts.ts` — Conflict persistence under `.fleet/knowledge/conflicts/{id}/`. Exports `createConflict()`, `listConflicts()`, `readConflict()`, `resolveConflict()`. Triggered by ingest auto-mode, base_version mismatch, duplicate alias, raw source contradiction, or patch body/target id mismatch.
- `src/claims.ts` — Claim provenance sidecar at `wiki/.claims/{id}.json` with `ClaimSet`/`Claim`/`ClaimSourceRef` types. Exports `readClaims()`, `writeClaims()`, `listClaims()`. Optional — `wiki_resolve` falls back to summary if absent.
- `src/search.ts` — Optional enhanced ranker for `wiki_briefing`. Inline BM25-style scoring with alias/type/status/freshness/graph boost, no new dependency. Default ranker remains the deterministic substring scorer in `briefing.ts`.
- `src/drydock.ts` — Lint rules including canonical/legacy link checks, frontmatter validation, schema health, conflict surfacing, and Wave 13 semantic issues (orphan/stale/deprecated/superseded/duplicate alias/contradiction marker/claim orphan/claim malformed).
- `src/prompts.ts` — Tool prompt snippets, guidelines, and TypeBox schemas. References `schema/wiki-schema.md` for workspace conventions.
- `src/paths.ts` — Memory path resolution, `ensureMemoryRoot()` bootstraps schema files via `ensureWorkspaceSchema()`.

## Schema & Documentation

- Workspace conventions live in `.fleet/knowledge/schema/wiki-schema.md` (auto-generated with `ensureWorkspaceSchema()`).
- Maintainer guide in `.fleet/knowledge/schema/AGENTS.md` defines schema ownership and edit-preservation policy.
- Canonical wiki link syntax is `[[wiki:id]]` (cross-layer standard used by leaf package and web surface).
- `index.md` at `.fleet/knowledge/wiki/index.md` provides deterministic markdown catalog with id ordering and tag grouping.
- `log.md` at `.fleet/knowledge/log.md` append-only operational chronicle of ingest, patch, rebuild, drydock, and conflict events.
- `conflicts/{id}/` stores `meta.json` + `current.md` + `proposed.md` + `raw-source.md` (when applicable). Surfaced via `wiki_drydock` `unresolved_conflict` warnings and the web `/conflicts` route.
- `wiki/.claims/{id}.json` claim sidecars are optional but enable provenance-tracked `wiki_resolve` facts. Schema: `{ entryId, claims: [{ id, text, sourceRefs: [{ ref, quote, span }], confidence }] }`.

## Compatibility Doctrine

- Preserve the `experimentalWiki` symbol key name for downstream compatibility.
- Do not change MCP tool names: `wiki_briefing`, `wiki_drydock`, `wiki_ingest`, `wiki_patch_edit`, `wiki_patch_queue`, `wiki_orient`, `wiki_read`, `wiki_resolve`, `wiki_compile_source`, `wiki_query`.
- Existing `wiki_briefing` callers must remain working with `enhanced=false` (default).
- Existing `wiki_ingest` callers must remain working with `mode="auto"` (default), which falls back to create when the target is absent.
- Forbid refactoring or signature changes beyond what these waves require.
