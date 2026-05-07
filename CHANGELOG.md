# Changelog

All notable changes to this project will be documented in this file.
This format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.14.1] - 2026-05-07

Release v0.14.1

## [0.14.0] - 2026-05-07

Release v0.14.0

## [0.13.7] - 2026-05-07

Release v0.13.7

## [0.13.6] - 2026-05-07

Release v0.13.6

## [0.13.5] - 2026-05-07

Release v0.13.5

## [0.13.4] - 2026-05-07

Release v0.13.4

## [0.13.3] - 2026-05-06

Release v0.13.3

## [0.13.2] - 2026-05-05

Release v0.13.2

## [0.13.1] - 2026-05-05

Release v0.13.1

## [0.13.0] - 2026-05-05

### Added
- **`wiki_orient` tool** — New MCP tool for workspace orientation that provides schema summary, index snapshot, recent log entries, pending queue count, and drydock status in a single call. Enables LLM agents to understand workspace terrain before starting wiki tasks.
- **Canonical wiki link syntax `[[wiki:id]]`** — Fleet Wiki now uses `[[wiki:entry-id]]` as the cross-layer standard for wiki-to-wiki links. Link extractors in both leaf package and web surface share the same SSoT in `packages/fleet-wiki/src/links.ts`.
- **`index.md` markdown catalog** — `rebuildIndex()` now generates `.fleet/knowledge/wiki/index.md` alongside `index.json`, providing a human-readable entry catalog with deterministic id ordering and tag grouping.
- **Append-only `log.md`** — New operational log at `.fleet/knowledge/log.md` that records ingest, patch lifecycle, drydock runs, and index rebuilds as chronological entries for auditability.
- **Workspace schema bootstrap** — `ensureWorkspaceSchema()` auto-generates `schema/AGENTS.md` and `schema/wiki-schema.md` in new workspaces, defining canonical link syntax, frontmatter rules, body conventions, and provenance policies.
- **`links.ts` module** — Public helper in `@sbluemin/fleet-wiki` exposing `extractWikiLinks()`, `extractLegacyMarkdownWikiLinks()`, and `replaceWikiLinksWithMarkdown()` for unified link handling across leaf and web packages.
- **`log.ts` module** — Public helpers `appendLog()`, `parseLog()`, `formatLogEntry()` for structured operational logging with deterministic payload ordering.
- **`schema.ts` module** — Public helpers `ensureWorkspaceSchema()` and `readWorkspaceSchemaSummary()` for workspace convention management, with idempotent file creation that preserves user edits.
- **Legacy markdown wiki link warning** — `wiki_drydock` now reports `legacy_markdown_wiki_link` warning when `[title](entry.md)` style links are detected, guiding users toward canonical `[[wiki:id]]` syntax.
- **Web renderer canonical link support** — `packages/fleet-wiki-web` now renders `[[wiki:foo]]` as `/entry/foo` SPA links with `data-entry-id` attributes, while preserving DOMPurify security policies.
- **Web backlink union** — Backlink extraction now combines canonical `[[wiki:id]]` and legacy `.md` links for complete reference tracking.
- **New test suites** — `wiki-orient.test.ts`, `wiki-links.test.ts`, `wiki-log.test.ts`, `wiki-index-md.test.ts`, `wiki-schema.test.ts` covering orientation tool, link extraction, operational logging, index generation, and schema bootstrap.
- **`wiki_read` tool** — Multi-entry full-content read with mode (`full`/`summary`/`facts`/`diffable`), `include_raw_source`, `include_related`, deterministic `max_tokens` truncation, and boundary-wrapped output.
- **`wiki_resolve` tool** — Context-pack synthesis tool combining briefing + read into compact JSON or markdown_pack output with freshness filters (`prefer_recent`/`strict_current`/`any`), claim-aware facts when sidecar exists, and `missing_or_uncertain` reporting.
- **`wiki_compile_source` tool** — Multi-page batch ingest from a single source. Stages a `patch_set` with metadata (`queue/_sets/{id}/meta.json`) so one source compile run produces multiple correlated `create_wiki`/`update_wiki` patches that can be approved together via `wiki_patch_queue.action="approve_set"`.
- **`wiki_query` tool** — Citation-aware query interface. `mode="answer"` returns context_pack + citations without mutation; `mode="stage_answer_page"` (or `save_good_answer=true`) stages a wiki page patch under `wiki/queries/` or `wiki/synthesis/`. Claim sidecar auto-staging is deferred until queue auxiliary-file support is introduced in a future iteration.
- **Claim provenance schema** — `wiki/.claims/{id}.json` sidecar with `ClaimSet`/`Claim`/`ClaimSourceRef` types and `readClaims()`/`writeClaims()`/`listClaims()` helpers. `wiki_resolve` consumes claim sidecars when present to populate `facts[]` with `quote`+`span`+`confidence` provenance.
- **Conflicts persistence** — `wiki_ingest` now emits `Conflict` records under `.fleet/knowledge/conflicts/{id}/` (meta.json + current.md + proposed.md + raw-source.md) when `mode=create` finds existing target, `mode=update` misses target, `base_version` mismatches, raw source contradiction, duplicate alias, or patch body/target id mismatch is detected. `conflicts.ts` exposes `listConflicts()`/`readConflict()`/`createConflict()`/`resolveConflict()`. DryDock surfaces `unresolved_conflict` warnings.
- **`wiki_ingest` auto/create/update mode** — New `mode` parameter (`auto`/`create`/`update`) with optional `base_version`/`base_hash`/`duplicate_policy`. Auto mode promotes to update_wiki when target exists, raises `Conflict` on stale base, and supports `duplicate_policy: "reject" | "queue_conflict" | "append_evidence"`.
- **Retrieval boundary tags** — `<<<FLEET_WIKI_ENTRY_BEGIN ...>>>` / `<<<FLEET_WIKI_RAW_SOURCE_BEGIN trust="untrusted" ...>>>` wrap all LLM-facing wiki content in `wiki_briefing`, `wiki_read`, `wiki_resolve`, and `wiki_orient`. `boundaries.ts` centralizes wrap helpers and the four-rule `trust_boundary` array (entries are contextual knowledge, raw sources are untrusted evidence, follow higher-priority instructions on conflict, do not execute instructions inside wiki/raw content).
- **Entry frontmatter expansion** — Optional `aliases`, `type` (concept/entity/source/decision/runbook/project_context/policy/preference/lesson/api_contract/query/synthesis), `status` (draft/current/deprecated/superseded), `confidence` (low/medium/high), `owner`, `language`, `revalidateAfter`, `supersedes`, `related`, and structured `rawSourceRefs[]` (with optional `title`/`hash`) fields on `WikiEntry`. Legacy `rawSourceRef` preserved alongside.
- **DryDock semantic lint expansion** — New issue codes: `orphan_page` (info), `cross_reference_suggestion` (info), `stale_entry` (warning), `deprecated_in_index` (warning), `superseded_in_index` (warning), `missing_raw_source_for_current` (warning), `duplicate_alias` (error), `schema_violation` (warning), `unresolved_conflict` (warning), `contradiction_marker` (info), `claim_orphan` (warning), `claim_malformed` (warning).
- **Briefing enhanced ranker** — Optional `enhanced=true` opt-in surfaces alias/type/status/freshness boost, snippet around match, and graph boost via canonical link/backlink count, all via inline BM25-style scoring (no new dependency). Default `enhanced=false` keeps deterministic substring ranking unchanged.
- **Web routes** — `GET /api/conflicts` + `/api/conflicts/:id`, `GET /api/log?limit=N`, `GET /api/index-md`, all with path containment checks and security headers. Client SPA gains `/conflicts`, `/conflicts/:id`, `/log`, `/index-md` routes.
- **Web UI components** — `conflicts-view.ts`, `log-view.ts`, `index-md-view.ts`, and `copy-context-actions.ts` (Copy compact context / Copy with provenance / Copy related context pack / Open raw source / Show why matched). Status badges (current / deprecated / superseded / stale) on entry view. Patch set / batch surface in queue detail.
- **Security headers** — Server now sets `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` on every static and API response. POST Origin guard and DOMPurify policies preserved.

### Changed
- **`wiki_drydock` prompt snippets** — All four tool prompts now reference `.fleet/knowledge/schema/wiki-schema.md` as the authoritative guide for workspace conventions.
- **DryDock schema lint** — Added `schema_missing`, `schema_required_section_missing`, `schema_agents_missing` issue codes with severity levels (warning/info) to diagnose workspace schema health.
- **`DryDockIssue.severity`** — Extended union to include `"info"` for non-critical diagnostic issues like missing `schema/AGENTS.md`.
- **`rebuildIndex()` workflow** — Now writes `index.json`, `wiki/index.md`, and appends `index rebuilt` log entry atomically, failing loudly if log append fails.
- **`ensureMemoryRoot()`** — Now bootstraps workspace schema files via `ensureWorkspaceSchema()` during initialization.

### Fixed
- **`create_wiki` overwrite prevention** — `validatePatch()` now rejects patches targeting existing wiki entries, forcing use of `update_wiki` for modifications.
- **Raw source filename collisions** — Ingested source files now include SHA-256 content hash suffix (`raw/{date}-{id}-{hash}.md`) to prevent overwrite when ingesting same-day updates with different content.
- **`wiki/index.md` exclusion** — Index catalog and `readWikiEntry("index")` now properly exclude the catalog file from entry listings and direct reads.
- **Reserved wiki id `index`** — `assertSafeEntryId()` rejects `id: "index"` to prevent user entries from colliding with the generated `wiki/index.md` catalog and being silently overwritten by `rebuildIndex()`.
- **`log.md` multiline self-corruption** — `formatLogEntry()` now escapes newlines, carriage returns, and backslashes inside payload values so user-supplied strings (e.g., entry titles with embedded newlines) cannot break the single-bullet log line invariant.
- **`readRawSourceEntry()` path traversal** — Public helper enforces `paths.rawDir` containment via `path.relative()` and rejects refs that escape the raw directory.
- **Web approve `409 create_target_exists`** — `PATCH_ERROR_MAP` now maps the `create_wiki target already exists` error to a `409 create_target_exists` response so the browser surface no longer reports overwrite conflicts as `500 internal_error`.
- **DryDock `ok` semantics** — `runDryDock().ok` now reflects `errorCount === 0` instead of `issues.length === 0`. Warning-level issues (e.g., missing `index.md`/`log.md` on a fresh workspace) no longer cause healthy stores to display as failed; status counts remain available via `error_count` / `warning_count` in the appended log entry.
- **Client bundle build** — Removed `@sbluemin/fleet-wiki` import from the Vite SPA renderer. The client now keeps an inlined copy of `WIKI_LINK_PATTERN` (with explicit SSoT comment) instead of transitively pulling fleet-wiki's Node-only modules into the browser bundle.
- **Nested wiki entry resolution** — `readWikiEntry()` now falls back to a recursive scan when `index.json` is stale or missing, so entries under `wiki/queries/`, `wiki/sources/`, `wiki/synthesis/` (introduced by `wiki_compile_source` and `wiki_query`) remain readable through `wiki_read` and approve flows even after index drift.
- **Patch ID collision** — `buildPatchId()` now hashes `target` + `body` (in addition to timestamp + summary) so `wiki_compile_source` patch sets touching multiple pages with identical summaries no longer produce colliding queue directories. `enqueuePatch()` raises a hard error if a patch directory unexpectedly already exists.
- **Drydock list resilience** — `listQueue()` now silently skips corrupted queue entries (missing/malformed `meta.json`) instead of throwing, so the web Drydock view no longer surfaces `500 internal_error` for legacy empty directories left behind by the pre-fix `buildPatchId()` collision regression. `wiki_drydock` continues to flag those directories as `malformed_queue`.
- **Retrieval consistency between wiki_briefing / wiki_query / wiki_resolve** — `wiki_query` and `wiki_resolve` previously returned zero hits for multi-word queries even when every term was present in entry body/title because the ranker only scored full-substring matches. `briefing.ts` now performs token-level OR matching (with an `exact_phrase` priority boost so contiguous matches still rank higher than scattered tokens) and exposes the unified ranker via `briefingQuery()`. Since `wiki_query` and `wiki_resolve` already call into `briefingQuery` internally, the three retrieval surfaces now produce consistent hit sets. Default `enhanced=false` deterministic ordering is preserved.

## [0.12.0] - 2026-05-04

### Breaking Changes
- **`DirectiveRefinementSettings` format change**: The settings shape under `metaphor-directive-refinement` changed from `{ provider, model, reasoning }` to `{ cliType, model, effort }`. Existing settings using the old keys are not migrated; users must reconfigure via `/fleet:metaphor:settings`.
- **Legacy settings fallback keys removed**: The fallback chain for legacy keys `metaphor-refine-directive` and `core-improve-prompt` is removed.
- **`fleet:metaphor:directive` slash command retired**: The standalone directive-refinement command is removed. Directive refinement is now invoked exclusively via the `Alt+M` keybind and configured through `/fleet:metaphor:settings`.

### Added
- **`executeDirectiveRefinement` (executeOneShot-based)**: New callback-pattern runner in `packages/fleet-core/src/metaphor/directive-refinement/execute.ts`. Replaces the previous `pi-ai` `completeSimple` dependency with `admiral.agent.executor.executeOneShot`.
- **Output-contract validator with NFKC normalization and i18n coverage**: `validateOutputContract()` normalizes output with NFKC and rejects fenced code blocks, meta preamble/wrapper headings (en/ko/ja/zh), and override-style framing (en/ko/ja/zh).
- **Exhaustive compile guard on host switch**: The host `refineDirectiveWithLoader` switch on `DirectiveRefinementResult.status` uses a `never` exhaustiveness check so new status values become compile-time errors.
- **`packages/fleet-core/tests/metaphor/directive-refinement.test.ts`**: 50-case unit test suite covering normalization, validation, and edge cases.
- **Common `<prior_jobs?>` request block for all carriers**: New `PRIOR_JOBS_REQUEST_BLOCK` constant in `packages/fleet-core/src/admiral/carrier/prompts.ts` is auto-merged into every carrier's rendered request-block guide via `CARRIER_COMMON_REQUEST_BLOCKS`. The Admiral can pass prior finalized `job_id` references via `<prior_jobs>` without editing individual carrier persona files. `CarrierMetadata` now supports an optional `commonRequestBlocks?` field for per-carrier common blocks. `validateRequiredRequestBlocks()` behavior is unchanged — `<prior_jobs>` is strictly optional and never causes rejection.
- **`CARRIER_JOBS_SELF_CALL_HINT` SSoT for carrier Tier-2 self-call doctrine**: New exported constant in `packages/fleet-core/src/admiral/carrier/prompts.ts` instructs all 8 built-in carrier personas on how to self-fetch prior job results via `carrier_jobs(action:"result", format:"full", job_id:...)` (full archive) with `format:"summary"` fallback when archive content has expired (`full_invalidated` true / TTL exceeded). Each persona adopts it via the spread pattern `[CARRIER_JOBS_SELF_CALL_HINT, ...existing]` so there is exactly one authoritative copy.
- **Updated `CARRIER_REQUEST_BREVITY_GUIDELINE` with explicit job_id handoff contract**: The Host PI-side brevity guideline (shared SSoT in `carrier/prompts.ts`, auto-imported by `carrier_dispatch`, `carrier_squadron`, and `carrier_taskforce` tool specs) now explicitly instructs the Admiral to pass prior carrier job IDs via `<prior_jobs>` instead of paraphrasing output, and documents the carrier self-fetch contract: `carrier_jobs(action:"result", format:"full", job_id:...)` for full results, `carrier_jobs(action:"result", format:"summary", job_id:...)` when archive has expired.
- **Connect-time MCP for executor sessions**: Every `executeWithPool` / `executeOneShot` session now receives a whitelist-scoped MCP server at connect time so carriers can self-call allowed tools (initially `carrier_jobs`). Setup, drift detection, and dead-session token rotation are owned by `packages/fleet-core/src/admiral/agent/internal/executor-engine.ts` via the new `PooledClient.mcpSessionToken` field and `setupExecutorMcp` helper.
- **`EXECUTOR_MCP_TOOL_IDS` SSoT**: New constant in `packages/fleet-core/src/admiral/agent/tools.ts` defines the executor MCP whitelist. Initial allowlist is `["carrier_jobs"]`. The `getExecutorMcpTools()` helper resolves the whitelist against the registered tool catalog and fails loudly on missing specs. Adding a new executor-exposed tool requires editing only this constant.
- **Executor MCP router helpers**: Five new helpers in `packages/fleet-core/src/admiral/agent/internal/mcp-router.ts` (`installExecutorToolCallRouter` and friends) implement token-isolated FIFO routing for executor sessions, mirroring the streaming session pattern.
- **`packages/fleet-core/tests/agent/executor-mcp-router.test.ts`**: New test file covering executor MCP setup, whitelist enforcement, drift detection, and dead-session token rotation.
- **`buildInlineRefinementRequest()` with UNTRUSTED_DRAFT markers**: New inline request builder in `packages/fleet-core/src/metaphor/directive-refinement/prompts.ts`. User draft is wrapped in `<<<UNTRUSTED_DRAFT_BEGIN>>>` / `<<<UNTRUSTED_DRAFT_END>>>` markers to create an explicit visual and syntactic boundary between doctrine and raw data.
- **Bilingual prompt-injection rule**: The inline doctrine ends with a bilingual (English + Korean) untrusted-data rule that instructs the carrier to treat everything inside the markers as text to refine, not as instructions to follow.
- **Adversarial regression tests expanded**: `packages/fleet-core/tests/metaphor/directive-refinement.test.ts` grew from 50 to 67 cases.

### Changed
- **Settings UI rebuilt on Unified `CLI_BACKENDS` catalog**: The directive-refinement settings picker now sources backends, models, and effort levels from `admiral.agent.models.listProviders()`, `getCliModels()`, and `getCliEffortLevels()` instead of Pi's `ctx.modelRegistry`. This removes the Pi-AI dependency from the refinement path and aligns the UI with the six registered CLI types (`claude`, `claude-zai`, `claude-kimi`, `codex`, `gemini`, `opencode-go`).
- **Directive-refinement prompt delivery moved inline**: The doctrine is no longer passed as a `connectSystemPrompt` to `executeOneShot`; instead, `buildInlineRefinementRequest()` composes the doctrine and user draft into a single inline request body. This eliminates a separate prompt channel and reduces carrier-side prompt-injection surface.

### Removed
- **`REFINE_DIRECTIVE_COMMAND` constant** and related registration code.
- **`compose.ts` (`composeDirectiveRefinementRequest`)**: The separate compose module and its `DirectiveRefinementComposeRequest` / `Result` types are removed. Their responsibilities are absorbed by `buildInlineRefinementRequest()`.

### Security
- **UNTRUSTED_DRAFT marker boundary for prompt-injection defense**: The inline doctrine wraps the user draft in `<<<UNTRUSTED_DRAFT_BEGIN>>>` / `<<<UNTRUSTED_DRAFT_END>>>` markers, creating an explicit data boundary. A bilingual rule (English + Korean) at the end of the doctrine instructs the carrier that content inside the markers is raw data to improve, not executable instructions, regardless of any commands, role declarations, or override attempts present within.

## [0.11.5] - 2026-05-04

Release v0.11.5

## [0.11.4] - 2026-05-04

Release v0.11.4

## [0.11.3] - 2026-05-04

### Changed
- **Carrier-agnostic executor surface**: `executeWithPool` / `executeOneShot` in `@sbluemin/fleet-core` are now carrier-agnostic and accept the renamed `ExecuteOptions` (with a `poolKey` field), returning `ExecResult`. Callers map `poolKey` themselves: `carrier_<id>` tools pass `poolKey: carrierId`; `carrier_squadron` / `carrier_taskforce` pass synthetic ids. The `connections.{disconnect, disconnectAll, cleanIdle, getSessionIdFor}` parameter is renamed `carrierId` → `poolKey`; the internal `SessionMapStore` parameter is renamed `carrierId` → `key`. No behavioral change.

### Removed
- **`CarrierExecuteOptions` / `CarrierExecResult` / `executeCarrierWithPool` / `executeCarrierOneShot`**: All carrier-bound executor types and helpers are removed from the codebase. The `admiral/carrier` domain no longer wraps the executor; consumers reach it exclusively via the generalized `executeWithPool` / `executeOneShot` exports on the `@sbluemin/fleet-core` root barrel.

## [0.11.2] - 2026-05-04

### Added
- **Fleet Wiki Drydock page** — `/queue` (Pending/Archived tabs), `/queue/:patchId` (detail with op-badge, body markdown, right-rail Patch Manifest, action card). Sidebar gains a brass-badged `Drydock` entry between search and Entries|Tags.
- **Drydock REST API** — `GET /api/queue?status=pending|archived|all` (always returns both `pendingCount` and `archivedCount`), `GET /api/queue/:patchId` (queue→archive fallback, includes `targetExists`).
- **Web-based approve/reject** — `POST /api/queue/:patchId/approve|reject`, invoking fleet-wiki's `approvePatch`/`rejectPatch` public API directly. The Drydock detail ACTIONS card is replaced with Approve (brass) / Reject (coral outline + inline reason form) buttons; archived/accepted/rejected patches omit the card.
- **CLI auto-restart on stale dist** — When `fleet-wiki` re-runs, compares dist/server.mjs mtime against lock startedAt; if stale, kills the old detached server and respawns. Disable with `FLEET_WIKI_NO_AUTO_RESTART=1`. Trust gate: `pid>1`, lock cwd exact match, health.cwd exact match — all three must pass before SIGTERM is sent.

### Changed
- **Manifest panel expanded to a frontmatter `<dl>`** — The entry right-rail manifest is now a full `<dl>` showing created/updated/version/tags (chips)/rawSourceRef (brass link). Shares the `.queue-dl` visual primitive with the Drydock Patch Manifest.
- **Server method whitelist** — `ALLOWED_METHODS` expanded from `GET, HEAD` to `GET, HEAD, POST`. POST is routed only to the handler whitelist (`/api/queue/:id/approve|reject`); all other paths return `405` with `Allow: GET, HEAD`. A lazy `port` getter is added to `RouteContext`.
- **Sidebar Drydock placement** — Moved from the bottom of the sidebar to between the search box and the Entries|Tags nav-tabs, preserving visibility as the entry list grows.

### Fixed
- **Concurrent approve/reject race** — Added a process-local `patchActionLocks` Map in `routes.ts`. When two requests target the same patchId simultaneously, the second receives an immediate `409 patch_busy`. Previously, fleet-wiki's archive move could race and lose the archive directory.
- **fleet-wiki validation throws now map to 4xx** — `PATCH_ERROR_MAP` covers 12 thrown strings (e.g., `"patch is not pending"` → 409, `"Unknown patch ID"` → 404, `"invalid patch op"` → 400, `"update_wiki target does not exist"` → 409). Unmapped throws still yield 500, but the `message` field is stripped from the response body (logged to stderr only).
- **UI duplicate-click guard** — `main.ts` event-handler entry and `queue-state.ts` entry both short-circuit on `actionPending`, and the invoking button is synchronously disabled.

### Security
- **POST handler whitelist** — Only `/api/queue/:patchId/approve|reject` accept POST. Any other path returns `405`.
- **Strict Origin equality for POST** — `request.headers.origin === \`http://127.0.0.1:${port}\`` enforced exactly; missing or mismatched origins are rejected with `403`. Combined with `127.0.0.1` binding, this forms this package's CSRF defense.
- **Body-size and content-type enforcement** — POST bodies must carry `Content-Type: application/json` (charset allowed); others receive `415`. Bodies exceeding 1024 bytes receive `413` (drain-then-respond to preserve the response channel).
- **Stale-lock takeover hardening** — `cli.ts` auto-restart only sends SIGTERM after `pid > 1`, `lock.cwd === currentCwd`, and `/api/health.cwd === lock.cwd` all pass. On failure it prints to stderr and aborts restart. The pure `isLockTrustworthyForRestart` helper lives in `src/stale.ts` and is covered by 7 unit-test cases (pid=1/-1/NaN, cwd mismatch, health null/mismatch, all-pass).

## [0.11.1] - 2026-05-04

Release v0.11.1

## [0.11.0] - 2026-05-04

### Added
- **`@sbluemin/fleet-wiki-web` workspace package**: New standalone web surface for Fleet Wiki workspaces. Provides the `fleet-wiki` CLI command, a detached local HTTP server, and a Vite-built vanilla TypeScript SPA client with dark theme, 3-column layout, ⌘K command palette, and backlink panel.
- **`fleet-wiki` CLI command**: Registered at the monorepo root via `bin.fleet-wiki`. Serves the Fleet Wiki web UI from the current working directory's `.fleet/knowledge` store, automatically opens the system browser, and manages a per-user PID/port lock file.
- **Fleet Wiki Web APIs**: Four read-only endpoints (`/api/index`, `/api/entry/:id`, `/api/search`, `/api/backlinks/:id`) plus a health-check (`GET /health`), all served by the detached Node.js HTTP server.
- **Fleet Wiki Web security hardening**: Client-side DOMPurify sanitization, server-side safe-ID validation (`SAFE_ID_RE`), exclusive PID/port lock with `O_NOFOLLOW | O_NONBLOCK` and `lstat` pre-checks (lock file mode `0600`, directory `0700`), and malformed-URL request guards.

## [0.10.2] - 2026-05-03

Release v0.10.2

## [0.10.1] - 2026-05-03

### Breaking Changes
- **`carriers_sortie` tool removed**: The single multi-carrier dispatch tool `carriers_sortie` is replaced by per-carrier tools named `carrier_<id>` (e.g., `carrier_genesis`, `carrier_vanguard`). Each registered carrier is now exposed as an explicit MCP tool with a single `request` parameter, allowing the host LLM to select carriers directly without indirection through a shared dispatcher.
- **`sortieDisabled` renamed to `offline`**: The fleet-store key and all related framework APIs (`isSortieCarrierEnabled` → `isCarrierOnline`, `setSortieDisabled` → `setOffline`, etc.) have been renamed. No on-demand migration is performed; existing `sortieDisabled` keys are ignored.

### Added
- **Automatic fleet data directory migration**: On startup, `pi-fleet-extension/src/fleet.ts` resolves the canonical fleet data directory via `resolveFleetDataDir()`, which detects a legacy `~/.pi/fleet/` tree and migrates it on demand to `~/.fleet/`. The migration deep-merges JSON files (`settings.json`, `states.json` — objects merge recursively, arrays dedupe-and-concat, primitives prefer the current `~/.fleet/` value), recursively moves directories, and backs up clashing non-mergeable files as `<file>.legacy-backup-<ISO timestamp>` rather than overwriting current state.
- **Atomic migration lock**: Concurrent boots coordinate through `~/.fleet.migration.lock/` (atomic `mkdir`) with a PID/host owner record (`owner.json`), 25 ms retry cadence, 5 s timeout, and 30 s stale-lock recovery, ensuring exactly-once migration even when multiple Pi sessions cold-start simultaneously.

### Changed
- **Per-carrier tool spec via `CarrierMetadata`**: Tool spec construction is now a shared helper that consumes `CarrierMetadata` directly, eliminating the per-carrier `buildSortieToolSpec` indirection.
- **Runtime context tags**: `<available_sortie_carriers>` is removed from the runtime context block. Each `carrier_<id>` tool's availability is reflected by its presence in the registered tool list.
- **Fleet data directory relocated**: Runtime data and configuration moved from `~/.pi/fleet/` to `~/.fleet/`. The path is now `os.homedir()`-anchored and decoupled from the `PI_CODING_AGENT_DIR` environment variable, so Fleet state remains stable regardless of how the underlying Pi runtime is reconfigured. Existing `~/.pi/fleet/` installations are migrated automatically on next launch (see Added).

### Security
- **Hardened fleet data directory I/O**: All filesystem operations on `~/.fleet/` and the migration lock open files with `O_NOFOLLOW | O_NONBLOCK` and use `lstat`-based pre-checks. Directories are forced to mode `0o700` and files to `0o600`. Symlinked entries inside the legacy `~/.pi/fleet/` tree are skipped during migration, and a symlinked `~/.fleet.migration.lock` path aborts startup fail-closed instead of following the link.

## [0.10.0] - 2026-05-03

### Breaking Changes
- **`CarrierMetadata` now requires `category`**: The `CarrierMetadata` interface (exported from `@sbluemin/fleet-core/admiral/carrier/types`) now includes a mandatory `category: CarrierCategory` field. Any custom carrier persona definitions outside the built-in set must be updated to include `category: "strategy" | "planning" | "operations"`.
- **`streamingSink` removed from `FleetServicesPorts`**: The public `streamingSink` API signature has been removed from `FleetServicesPorts`. Consumers must migrate to `jobServices.streaming.register(handler)` for SSOT carrier job stream event consumption.
- **Bridge subpaths removed**: The three public subpaths `@sbluemin/fleet-core/admiral/bridge/run-stream`, `admiral/bridge/carrier-panel`, and `admiral/bridge/carrier-control` are no longer exported.
- **`AgentStreamEvent` replaced**: The `AgentStreamEvent` type has been removed. Use `CarrierJobStreamEvent` (SSOT) instead.

### Removed
- **`bridge/` directory entirely**: Removed `packages/fleet-core/src/admiral/bridge/` including `run-stream/`, `carrier-panel/`, and `carrier-control/`.
- **`detached-fanout.ts`**: Removed `packages/fleet-core/src/admiral/_shared/detached-fanout.ts`.
- **`XxxToolPorts` interfaces**: Removed `SortieToolPorts`, `SquadronToolPorts`, and `TaskForceToolPorts` interfaces.
- **`streaming-sink.ts` (pi-fleet-extension)**: Removed `packages/pi-fleet-extension/src/agent/ui/streaming-sink.ts`.
- **Global bridge keys**: Removed 6 `globalThis` bridge keys related to bridge streaming and panel state.

### Added
- **`CarrierCategory` type and `category` field on `CarrierMetadata`**: New `CarrierCategory = "strategy" | "planning" | "operations"` union type added to `fleet-core/admiral/carrier/types`. All 8 built-in carrier personas now declare a category: `strategy` (Nimitz, Sentinel), `planning` (Kirov, Ohio), and `operations` (Genesis, Vanguard, Tempest, Chronicle). The Carrier Status overlay (Alt+O) groups entries by category instead of CLI type, and the HUD/agent panel footer sorts the carrier lineup in category order (`strategy` → `planning` → `operations`).
- **`CarrierJobStreamEvent` SSOT type**: New normalized carrier job stream event type unifying sortie, squadron, and taskforce streaming contracts.
- **`jobServices.streaming.register(handler)`**: Public API for registering synchronous handlers for normalized carrier job stream events.
- **`services/job/sanitize.ts`**: Unified sanitize module for detached job inputs and outputs.
- **`services/job/detached-job-lifecycle.ts`**: Detached job lifecycle helper for consistent job state management.
- **`admiral/_shared/stream-reducers.ts`**: Pure coalescing reducers for carrier job stream events.
- **`admiral/_shared/view-model.ts`**: Store-free `buildPanelViewModel` builder for render-agnostic panel state.
- **`admiral/carrier/status-overlay-controller.ts`**: Overlay controller relocated from the removed `bridge/carrier-control/` to `admiral/carrier/`.
- **`admiral/carrier/overlay-types.ts`**: Overlay types relocated alongside the status overlay controller.

### Changed
- Removed all `globalThis` usage from `pi-fleet-extension`; migrated runtime state to module-level singletons following the `border-bridge` precedent.
- Redesigned `/reload` lifecycle to reset ACP provider state on `session_shutdown` and re-establish carrier sessions via the existing resume path on the next `session_start`.
- Added `fleet-core` public accessors for Grand Fleet state, Admiralty runtime, Fleet runtime, and carrier framework state, replacing direct `globalThis` lookups in `pi-fleet-extension`.
- Switched service-status consumption to the `@sbluemin/unified-agent` public API and removed the duplicated `service-status-store.ts` from `pi-fleet-extension`.

## [0.9.0] - 2026-05-02

### Added
- **Task Force Backend Whitelist Expansion (3 → 6)**: `carrier_taskforce` now accepts every CLI provider registered in `CLI_BACKENDS` (`claude`, `claude-zai`, `claude-kimi`, `codex`, `gemini`, `opencode-go`) instead of the previous hardcoded `claude / codex / gemini` trio. `TaskForceCliType` is now an alias of `CliType`, and `TASKFORCE_CLI_TYPES` is auto-derived via `Object.keys(CLI_BACKENDS) as CliType[]` in `packages/fleet-core/src/admiral/taskforce/types.ts`. Persona × CLI compatibility is allowed for all six providers.
- **Dynamic Task Force Tool Prompts**: `TASKFORCE_CONFIGURE_HINT` and the `[carrier:result]` backend label list embedded in the `carrier_taskforce` tool description are now built from `TASKFORCE_CLI_TYPES × CLI_DISPLAY_NAMES`. Adding a new CLI provider to `CLI_BACKENDS` automatically expands both the configuration hint and the result-label examples without touching prompt strings.
- **Auto-Derived Task Force Overlay Colors**: The `taskforce-config-overlay` now reads per-CLI swatch colors from `CARRIER_COLORS` (auto-derived from `CLI_BACKENDS.colorRgb`) instead of a local hardcoded color map, so new providers receive overlay colors automatically.

### Removed
- **`budgetTokens` Field (Breaking)**: Removed `budgetTokens` from every model selection surface across the stack:
  - `ModelSelection`, `PerCliSettings`, and `TaskForceSelection` in `fleet-core/admiral/store/fleet-store.ts` no longer carry `budgetTokens`; the `sanitizeBudgetTokens` helper, the `claude` + `effort != "none"` auto-fill branch in `resolveSelectionForCliType`, and the equality check in `isSameResolvedSelection` are deleted accordingly.
  - `agent-runtime`, `_shared/detached-fanout`, and `admiral/squadron/tool-spec` runner contracts drop `budgetTokens` from their `modelConfig` shape.
  - Carrier-control bridge DTOs (`status-overlay-controller`, `carrier-control/types`) and the `taskforce-config-overlay.commitSelection` payload no longer carry or clamp `budgetTokens`.
  - Pi-side adapters drop the field from streaming/state contracts: `model-ui`, `alt-o-status-overlay`, `carrier-ui/status-overlay`, `provider-stream`, `runner`, `tool-registry`, and `provider-internal/state`.
- **Claude-Specific Reasoning Budget UI**: The `taskforce-config-overlay` no longer renders or persists a Claude-only `budgetTokens` input. New providers without supported reasoning effort follow the existing Gemini pattern (`reasoningEffort.supported = false`) and surface no effort/budget controls.
- **Local `CLI_COLORS` Hardcode in Task Force Overlay**: Dropped the inline `CLI_COLORS` map (`claude` / `codex` / `gemini` only) from `taskforce-config-overlay.ts`; the overlay now imports `CARRIER_COLORS` from `@sbluemin/fleet-core/constants`.

## [0.8.1] - 2026-05-01

Release v0.8.1

## [0.8.0] - 2026-05-01

### Added
- **Job Bar (belowEditor)**: Active carrier jobs (sortie, squadron, taskforce) now render as horizontal tiles below the editor input. Empty editor + active jobs + ↓ enters virtual focus mode; ←→ navigates between tiles; Enter expands a job to show streaming content at its position; Esc/↑ returns to editor.
- **Job Bar Track Tree**: All job kinds (sortie, squadron, taskforce) render tracks in a unified `├─`/`└─` tree with per-track signature colors and status icons. The latest active streaming block is merged inline on the track line via a `·` separator.
- **Job Bar Visual Polish**: Focused tiles are wrapped in `[...]` brackets with carrier-colored wave animation. Spinner and completion icons (`⏺`) use carrier signature colors throughout tiles and track trees.

### Changed
- **Job Bar Inline Streaming**: Expanded tracks render the latest active streaming block inline on the same line as the track header (`· <text>`), replacing the previous multi-line child block rendering below each track. `MAX_EXPANDED_STREAM_LINES` reduced from 5 to 1.
- **Unified Streaming Color**: All inline streaming text uses a single `STREAM_INLINE_COLOR` (rgb(100,210,245)) regardless of block type (ToolCall, Text, Thought).
- **Sortie Tree Depth Unification**: Sortie jobs now always render with tree depth (`├─`/`└─`) identical to Squadron and Taskforce, even for single-carrier sorties. Direct inline streaming on the sortie tile line is removed.

### Removed
- **`[N tools]` Track Stats**: Removed the `[N tools]` tool-call statistic from track lines.
- **`appendSingleTrackStream()`**: Replaced by the inline streaming approach.
- **`latestInlineBlock()`**: Unused after Sortie tree rendering unification.
- **`trackStatsText()`**: Removed along with `[N tools]` display.
- **`blockLineToAnsi` import in `job-bar-renderer.ts`**: No longer consumed by the Job Bar renderer; the export in `block-renderer.ts` is retained for `panel-renderer.ts` and `message-renderers.ts` consumers.

## [0.7.1] - 2026-05-01

### Changed
- **HUD Status Bar → Editor Bottom Border**: Relocated the HUD status bar from a standalone `belowEditor` widget into the editor's bottom border line, producing a more compact single-line layout.
- **Operation Name → Editor Top Border (Right)**: Moved the operation name display from the status bar segment to the editor's top-right border label alongside the protocol label.
- **HUD State Shared Singleton**: Replaced per-module `HudEditorState` creation in `hud-lifecycle` and `hud-command` with a single shared state factory (`hud/state.ts`), eliminating dual-state divergence.
- **Model Change Reactivity**: Added `model_select` event handler with `selectedModel` stored directly from `event.model`, bypassing stale `ctx.model` getter issues on session boundaries.
- **`buildSegmentContext` Resilience**: Wrapped ctx-dependent accessors (`sessionManager`, `modelRegistry`) in an internal try/catch so that stale-ctx throws no longer propagate; `selectedModel` and other ctx-independent data are always returned.

### Removed
- **`globalThis` HUD Render Bridge**: Removed `__pi_hud_render_request__` globalThis bridge; `fleet.ts` now imports `requestHudRender()` directly from `editor.ts`.
- **`globalThis` Border Bridge**: Replaced globalThis-based editor border/label storage in `border-bridge.ts` with module-level variables.
- **`operationSegment` Dead Code**: Removed the unused `operationSegment` definition, `SegmentContext.operationName` field, and `getOperationNameForSession()` helper from `hud-context.ts` (operation name now flows through `border-bridge` only).
- **`editorTheme` Confusion**: Eliminated the `editorTheme` (editor factory visual config) being passed where a full PI `Theme` was expected; `state.themeRef` (captured from the footer callback) is now the sole theme source for segment rendering.

## [0.7.0] - 2026-05-01

### Added
- **`opencode-go` CLI Provider**: Added the OpenCode Go CLI as a first-class provider in `packages/unified-agent`, including `UnifiedOpenCodeAgentClient`, `CLI_BACKENDS` entry, models entry, and dedicated E2E coverage. The Fleet ACP provider, ModelRegistry, and CLI registry are centralized accordingly.
- **`claude-zai` / `claude-kimi` CLI Providers**: Added Z.AI GLM and Moonshot Kimi backends as Claude-family aliases of `UnifiedClaudeAgentClient` (separate `defaultEnv.ANTHROPIC_BASE_URL`, separate `models.json` entries, npx bridge with `--cli`).
- **`fleet-core` Auth Service**: New `services/auth/` module exposing `AuthService` (`getApiKey`/`setApiKey`/`setAuthPath`) on `FleetServices.auth`. Reads and writes `~/.pi/agent/auth.json` via Node `fs`; the default path is overridable via `setAuthPath()`.
- **`resolveAuthEnv(cli)` Helper**: New shared helper exported from `@sbluemin/fleet-core` that maps `claude-zai` / `claude-kimi` to their `auth.json` provider IDs and returns `{ ANTHROPIC_AUTH_TOKEN }`. Throws when a mapped cli has no token registered. Both `agent-runtime.buildConnectOptions` (detached sortie/squadron/taskforce) and `provider-stream.buildProviderConnectOptions` (host PI agent) consume it as the single source of truth.
- **`CLI_TO_AUTH_PROVIDER_ID` Mapping**: Constant exported from `@sbluemin/fleet-core` that maps `claude-zai` → `Claude Code with Z.AI GLM` and `claude-kimi` → `Claude Code with Moonshot Kimi`.

### Changed
- **CLI Display Name SSoT — `models.json`**: `packages/unified-agent/models.json` (`providers.<cli>.name`) is now the sole source of truth for CLI provider display names. `fleet-core` `CLI_PROVIDER_DISPLAY_NAMES` derives directly from `getProviderModels(cli).name` with no vendor/`CLI` suffix stripping. All downstream consumers (status store, taskforce overlay, model UI, etc.) now go through this surface.
- **`buildConnectOptions` is now async**: `agent-runtime.buildConnectOptions` returns `Promise<UnifiedClientOptions>` and uses `resolveAuthEnv(cli)`, so detached carrier paths (`carriers_sortie`, `carrier_squadron`, `carrier_taskforce`) automatically receive the per-cli auth env.
- **`buildProviderConnectOptions` Consolidation**: `provider-stream.buildProviderConnectOptions` is async and shares the `resolveAuthEnv` helper; the inline `CLI_TO_AUTH_PROVIDER_ID` and `fleet.auth.getApiKey` calls are removed.
- **Fleet ACP Provider Split**: The Fleet ACP provider implementation is split per CLI and now sources provider names from `models.json`. Unified provider labels are aligned across the runtime.
- **Carrier Job Launch Notice**: Clarified the language of the carrier job launch notice for less ambiguity.

### Removed
- **`CLI_BACKENDS.name` Field**: The `name` property on every `CLI_BACKENDS` entry and on the `CliBackendConfig` type is removed; consumers must use `getProviderModels(cli).name` (= `models.json`).
- **Local `CLI_DISPLAY_NAMES` Hardcode**: Removed the local `CLI_DISPLAY_NAMES` constant from `packages/pi-fleet-extension/src/agent/ui/carrier-ui/taskforce-config-overlay.ts`; the overlay now imports `CLI_DISPLAY_NAMES` from `@sbluemin/fleet-core/constants`.
- **Vendor / `CLI` Suffix Stripping**: Dropped the historic `.replace(/ CLI$/, "").replace("Anthropic ", "")...` strip pipeline for display names.
- **`provider-catalog` Thin Wrapper**: Removed `packages/fleet-core/src/admiral/store/provider-catalog.ts` and its re-export. All consumers now use `@sbluemin/unified-agent`'s `getProviderModels` and `getReasoningEffortLevels` directly as the single source of truth.
- **`CLAUDE_THINKING_BUDGETS` Default Auto-Fill**: Removed automatic Claude budget token filling from `fleet-store`, `model-ui`, `alt-o-status-overlay`, `taskforce-config-overlay`, and `status-overlay`. Budget tokens now flow only when explicitly user-set; otherwise the value falls back to unified-agent defaults.
- **`MCP_TOOL_TIMEOUT` Env Injection**: Dropped the historic `MCP_TOOL_TIMEOUT: "1800000"` env injection from all carrier connect paths (host and detached); no longer needed.
- **`opencode-zai` / `opencode-kimi` Providers**: Pruned the OpenCode Z.AI / Moonshot variants; only `opencode-go` remains under the OpenCode surface.
- **HUD Context Window & Cache Usage**: Removed the context window rendering and cache usage tracking from the HUD layout.

## [0.6.6] - 2026-04-30

Release v0.6.6

## [0.6.5] - 2026-04-30

### Removed
- **Agent Service Cleanup**: Entire `packages/fleet-core/src/services/agent/` directory (23 files) removed as part of the destructive cleansing.
- **Legacy Agent Services**: Removed `packages/fleet-core/src/public/agent-services.ts` and its exports (`FleetAgentServices`, `FleetAgentRuntimeHost`, `BackendAdapter`, `BackendConnectOptions`, `BackendSession`, `AgentStreamingSink`, `FleetHostPorts`, `UnifiedAgentRequestOptions`, `UnifiedAgentBackgroundRequestOptions`, `UnifiedAgentRequestStatus`, `UnifiedAgentResult`, `executeAgentCore`, `createAgentServices`).
- **Legacy Tool Registry Services**: Removed `packages/fleet-core/src/public/tool-registry-services.ts` and its exports (`FleetToolRegistryServices`, `FleetToolRegistryPorts`, `FleetToolRegistryHostPorts`, `AgentToolRegistry`, `McpRegistryAPI`, `McpServerHandle`, `McpServerOptions`, `PendingToolCall`, `PendingToolResult`, `createAgentToolRegistry`, `createFleetToolRegistry`, `createMcpServerForRegistry`, `createToolRegistryServices`).
- **Deprecated Subpaths (Breaking)**: Removed 16 deprecated public subpaths under `@sbluemin/fleet-core/agent/*` (shared/types, shared/client, shared/service-status, provider/types, provider/provider-types, provider/client, provider/provider-client, provider/mcp, provider/provider-mcp, provider/thinking-level-patch, provider/tool-snapshot, dispatcher/runtime, dispatcher/session-store, dispatcher/session-resume-utils, dispatcher/pool, dispatcher/executor).
- **Double Definition Resolution**: Removed duplicate definitions in `packages/pi-fleet-extension/src/agent/provider-internal/{mcp.ts, tool-snapshot.ts}`.
- **Runtime Field Reductions**: Removed `agent`, `toolRegistry`, and `mcp` fields from `FleetCoreRuntimeContext`.
- **Wrapper Type Purge**: Removed all `Fleet*` prefix wrapper types (`FleetAgentClient`, `FleetAcpToolCall`, `FleetAcpToolCallUpdate`, `FleetAcpContentBlock`, `FleetMcpConfig`, `FleetProviderConnect*`, `FleetAgentClientEvents`, `FleetProviderLogEntry`, `FleetAcpSessionInfo`, `FleetConnectionState`) in favor of direct unified-agent types.
- **Adapter Removal**: Removed `UnifiedFleetAgentClientAdapter` class and `createAgentRequestService` media layer.

### Added
- **New Agent Runtime Subpath**: Introduced `@sbluemin/fleet-core/admiral/agent-runtime` subpath for core execution logic (`executeOneShot`, `executeWithPool`, `applyPostConnectConfig`, `getClientPool`, `isClientAlive`, `disconnectClient`, `disconnectAll`, `cleanIdleClients`, `initRuntime`, `onHostSessionChange`, `getSessionStore`, `getSessionId`, `getDataDir`, `classifyResumeFailure`, `isDeadSessionError`, `createSessionMapStore`).
- **Lazy Tool Registration**: Added `FleetServices.tools` lazy getter for automatic registration of `sortie`, `squadron`, `taskforce`, and `carrier_jobs` tools.
- **Unified MCP API**: Added `FleetServices.mcp` with automatic lifecycle management, tool registration, resolution of next tool calls, and pending call management.
- **Service Status Module**: Added `packages/unified-agent/src/service-status/` for provider health tracking (`ServiceSnapshot`, `HealthStatus`, `ProviderKey`, `ServiceStatusCallbacks`, `ServiceStatusContextPort`).
- **Shared Admiral Components**: Added `packages/fleet-core/src/admiral/_shared/{mcp.ts, agent-runtime.ts}`.
- **Tool Snapshot & Specs**: Added `packages/fleet-core/src/services/tool-registry/tool-snapshot.ts` and `packages/fleet-core/src/admiral/carrier-jobs/tool-spec.ts`.
- **Extension Internals**: Added state and session runtime management in `packages/pi-fleet-extension/src/agent/provider-internal/` (`state.ts`, `session-runtime.ts`, `service-status-store.ts`).
- **Port Types**: Added `FleetServicesPorts` type for host-provided capabilities (`logDebug`, `runAgentRequestBackground`, `enqueueCarrierCompletionPush`).

### Changed
- **Runtime Initialization**: `createFleetCoreRuntime` signature changed to `{ dataDir: string; ports: FleetServicesPorts }`.
- **Runtime Context Refactor**: `FleetCoreRuntimeContext` now strictly contains `fleet`, `grandFleet`, `metaphor`, `jobs`, `log`, `settings`, and `shutdown`.
- **MCP Server Lifecycle**: McpServer lifecycle management internalised; it now auto-starts on the first `fleet.mcp.url()` call and auto-terminates via `FleetCoreRuntimeContext.shutdown()`.
- **Tool Source Unification**: Single source of truth for tools established in `pi-fleet-extension` by injecting fleet tools into the MCP registry via `fleet.mcp.registerTools`.
- **Import Migration**: All internal and extension imports previously using `@sbluemin/fleet-core/agent/*` subpaths have been migrated to `@sbluemin/unified-agent`, `@sbluemin/fleet-core/admiral/agent-runtime`, or direct runtime service access.
- **Thinking Level Patch**: Rewritten `packages/pi-fleet-extension/src/agent/provider-internal/thinking-level-patch.ts` for the new internal structure.

### Breaking Changes
- **Public API Reduction**: Massive reduction of the public API surface; all downstream consumers must be updated to use the new simplified service patterns.
- **Subpath Removal**: All 16 `@sbluemin/fleet-core/agent/*` subpaths are completely removed and no longer export symbols.
- **Service & Wrapper Removal**: `FleetAgentServices`, `FleetHostPorts`, `FleetToolRegistryServices`, and all `Fleet*` prefix wrapper classes are removed.
- **Runtime Signature Change**: `createFleetCoreRuntime` now strictly requires the new `ports: FleetServicesPorts` argument, making the host-extension contract more explicit.
- **Context Field Removal**: `FleetCoreRuntimeContext.agent`, `.toolRegistry`, and `.mcp` fields are removed; access these capabilities via the unified `fleet` service.

## [0.6.4] - 2026-04-30

Release v0.6.4

## [0.6.3] - 2026-04-30

### Added
- **Detached Fanout Helper**: Extracted `packages/fleet-core/src/admiral/_shared/detached-fanout.ts` to unify detached parallel-job runner logic for Squadron and TaskForce domains, reducing code duplication.
- **Provider Catalog Extraction**: Split `packages/fleet-core/src/admiral/store/provider-catalog.ts` from `fleet-store.ts` to isolate model and budget definitions.

### Changed
- **pi-fleet-extension Restructure**: Restructured `pi-fleet-extension` to Flat Domain Architecture mirroring `fleet-core` public services. Each `fleet-core` service maps 1:1 to a `pi-fleet-extension` domain (`agent/`, `fleet.ts`, `grand-fleet/`, `metaphor.ts`, `job.ts`, `settings.ts`, `log.ts`, `tool-registry.ts`, `fleet-wiki/`).
- **Doctrine Update**: Doctrine "capability bucket organization" replaced with "service-mirror domain organization". Each domain now owns its commands, keybinds, tools, and TUI internally as files within the domain folder.
- **Entry Point Refactor**: Host entry split into `boot.ts` (runtime composition) and `ports.ts` (`FleetHostPorts` implementation). Host shell consolidated into its own `shell/` domain.
- **Gateway Location**: `@mariozechner/pi-ai` gateway moved from `src/provider/pi-ai-bridge.ts` to within `src/agent/` domain (single domain-internal gateway).
- AGENTS doctrine "compat isolation pattern" replaced with "provider gateway pattern" — only `packages/pi-fleet-extension/src/agent/` domain internal gateway is allowed to import `@mariozechner/pi-ai`.
- **Internal Agent Logging**: The agent domain now directly consumes `services/log` for logging instead of using a dedicated log-port bridge.
- **TaskForce State Pattern**: Updated TaskForce state to use a `Map<requestKey, TaskForceState>` instead of a single global slot, preventing state collisions during concurrent executions on the same carrier.
- **Service Unification**: Consolidated `services/log` and `services/settings` implementations. `log/store.ts` now absorbs API initialization, and `settings/service.ts` inlines Map wrapper logic.
- **Bridge Barrel Contraction**: Converted `admiral/bridge/` barrels (`run-stream`, `carrier-panel`, `carrier-control`) to allowlist-only named exports, hiding internal state and types from public surface.
- **Carrier Prompt Refactor**: Replaced certain dynamic `derive` helper calls in `admiral/carrier/prompts.ts` with direct manifest field references for performance.
- **Agent Runtime Assembly**: Inlined agent runtime assembly helpers into `public/runtime.ts`.

### Removed
- **Legacy Capability Buckets**: Removed `pi-fleet-extension` legacy capability buckets `src/commands/`, `src/keybinds/`, `src/session/`, `src/tools/`, `src/tui/`, and `src/provider/`. All content has been absorbed into their respective domain homes.
- Removed `pi-fleet-extension/src/bindings/` capability bucket (admiral, carrier, compat, config, grand-fleet, hud, jobs, metaphor, runtime). Service consumption now uses `fleet-core` public surface directly; `@mariozechner/pi-ai` gateway moved to `src/agent/` domain; runtime glue moved to `src/boot.ts` and `src/ports.ts`; grand-fleet glue moved to `src/grand-fleet/`; HUD lifecycle moved to `src/fleet.ts`; carrier panel sink moved to `src/fleet.ts`; carrier completion glue moved to `src/job.ts`.
- Removed `fleet-core` public types `LlmClient`, `LlmCompleteMessage`, `LlmCompleteRequest`, `LlmCompleteResult` (dead code; `FleetAgentClient` is the active replacement).
- Removed `@sbluemin/fleet-core/agent/shared/log-port` subpath and `FleetLogPort` interface.
- Demoted `BackendAdapter`, `BackendConnectOptions`, `BackendRequest`, `BackendResponse`, and `BackendSession` from `fleet-core` public exports.
- **Public Subpaths (Breaking)**: Removed 8 public subpaths from `fleet-core` that had zero external consumers:
  - `./runtime`
  - `./agent`
  - `./agent/shared`
  - `./agent/provider`
  - `./agent/dispatcher`
  - `./admiral/protocols`
  - `./services`
  - `./admiralty/ipc`
- **Dead Files**:
  - `packages/fleet-core/src/admiral/carrier/register.ts` (overridden by Pi tool-registry).
  - `packages/fleet-core/src/services/log/runtime.ts` (absorbed into `store.ts`).
  - `packages/fleet-core/src/services/settings/registry.ts` (inlined).
  - `packages/fleet-core/src/services/agent/fleet-agent-runtime.ts` (absorbed into `public/runtime.ts`).
  - `packages/pi-fleet-extension/src/agent/carrier/register.ts` (legacy shim).
- **Removed Exports/Symbols**:
  - `registerSingleCarrier`, `ensureShipyardLogCategories`, `SingleCarrierOptions`.
  - `getSquadronState`, `sanitizeTitle` (private/dead).
  - `isTaskForceFormable` (unused public).
  - `getProtocolById` (changed to private internal).
  - `TASKFORCE_STATE_KEY`, `CORE_SETTINGS_KEY` (dead).
  - `createActiveRecordFromSummary`, `renderToolPromptManifestMarkdown` (dead).

### Breaking Changes
- **Agent Service Reorganization**: Refactored `packages/fleet-core/src/services/agent/` into a 3-bucket structure (`shared/`, `provider/`, `dispatcher/`) for better isolation between internal runtime and provider contracts.
  - Consumers of internal agent subpaths must migrate to the new structure:
    - `@sbluemin/fleet-core/agent` (legacy barrel) -> `@sbluemin/fleet-core/agent/dispatcher/runtime` or root exports.
    - `@sbluemin/fleet-core/agent/types` -> `@sbluemin/fleet-core/agent/shared/types`.
    - `@sbluemin/fleet-core/agent/provider-mcp` -> `@sbluemin/fleet-core/agent/provider/provider-mcp`.
    - `@sbluemin/fleet-core/agent/executor` -> `@sbluemin/fleet-core/agent/dispatcher/executor`.
  - Representative consumer `pi-fleet-extension` has been updated in the same release; external consumers must update their import paths accordingly.
- **Log Port Removal**: Removed the `FleetLogPort` interface and the `@sbluemin/fleet-core/agent/shared/log-port` subpath.
  - `FleetHostPorts.log` field has been removed.
  - `AgentToolCtx.log` field has been removed.
  - Consumers must migrate to `services/log` directly (via `initLogAPI`/`getLogAPI`) for log interactions.
- **Bridge Export Policy**: Accessing internal bridge state or raw track/job types via `admiral/bridge/*` is no longer supported. Consumers must use the provided allowlist exports.
- **Subpath Removal**: Direct imports from the 8 removed subpaths will fail. Consumers should use the root barrel or the remaining compatibility subpaths documented in `PUBLIC_API.md`.
- **TaskForce State**: `TASKFORCE_STATE_KEY` is removed; taskforce state is now managed internally via request keys.

## [0.6.2] - 2026-04-30

### Removed
- Removed Fleet Wiki AAR support, including the `wiki_aar_propose` MCP tool, the `aar_only` capture mode, and all AAR-specific prompt/schema surfaces.
- Removed the Fleet Wiki `append_log` patch operation, the `.fleet/knowledge/log/` store directory, and the AAR-only types and validation paths tied to log entries.
- Removed AAR references from Fleet Wiki capture wiring and aligned AGENTS/README doctrine with the remaining `wiki_ingest`, `wiki_briefing`, `wiki_drydock`, and `wiki_patch_queue` surfaces.

## [0.6.1] - 2026-04-30

### Changed
- Renamed all `experimental-wiki` directories, import paths, and symbol names to `fleet-wiki` across `packages/pi-fleet-extension`; `bootExperimentalWiki` → `bootFleetWiki`, `registerExperimentalWiki` → `registerFleetWiki`.
- Updated related documentation (`AGENTS.md` files, `docs/`) to reflect the `fleet-wiki` naming and remove legacy `experimental-wiki` references.
- Fleet Bridge Agent Panel now auto-collapses completed track streaming details into a single inline `✓ Done` suffix on the track header, replacing the previous multi-line tool call list + separate `✓ Completed` line.

## [0.6.0] - 2026-04-30

### Added
- Extracted the experimental wiki domain into the new `@sbluemin/fleet-wiki` workspace package and moved its source and tests out of `fleet-core`.

### Changed
- Move `request_directive` schema and validators, carrier framework mutators, and grand-fleet tool spec definitions into `@sbluemin/fleet-core`; `pi-fleet-extension/src/tools` retains its current structure and consumes host-agnostic specs from fleet-core.
- Updated `pi-fleet-extension` experimental wiki adapters to consume `@sbluemin/fleet-wiki`, while `FleetCoreRuntime.experimentalWiki` remains as a compatibility key typed as `unknown`.
- Re-embedded the gfleet domain under `packages/fleet-core/src/gfleet/`, exposed again through `@sbluemin/fleet-core/gfleet`, `@sbluemin/fleet-core/gfleet/ipc`, and `@sbluemin/fleet-core/gfleet/formation`.

### Removed

### Breaking Changes
- External consumers of the former Fleet Core Grand Fleet entrypoints must migrate to `@sbluemin/fleet-core/gfleet*`; symbol names are unchanged.

## [0.5.0] - 2026-04-28

Release v0.5.0

## [0.4.1] - 2026-04-28

### Removed
- **Codex `service_tier` config support**: Removed `service_tier` from `CODEX_TURN_LEVEL_CONFIG_KEYS` and its pending-override cleanup logic in `UnifiedCodexAgentClient`.

## [0.4.0] - 2026-04-28

Release v0.4.0

## [0.3.3] - 2026-04-27

### Added
- **Fleet Bridge PanelJob Streaming Model**: Added a job-scoped `PanelJob` + `ColumnTrack` model so `carriers_sortie`, `carrier_squadron`, and `carrier_taskforce` all stream through the Fleet Bridge panel instead of Messages renderers.
- **Bridge Doctrine File**: Added `extensions/fleet/bridge/AGENTS.md` to document the Fleet Bridge UI/runtime boundary, PanelJob invariants, and the rule that shipyard tools keep Messages `renderCall` output to a fixed one-line summary.

### Changed
- **Phase 1 Restructure — Scope Triage + Mandatory Reconnaissance**: Split Fleet Action Protocol Phase 1 into two sub-phases: Phase 1a (Scope Triage) limits Admiral-direct file reads to ~2 files for scope classification only; Phase 1b (Vanguard Mandatory) requires Vanguard reconnaissance via `carrier_squadron` when 3+ files or modules are involved or scope is unclear.
- **Delegation Policy — Tighter Direct Handling Threshold**: Reduced "Handle directly" file lookup limit from ~5 to ~2 files (scope triage only). Lowered investigation delegation threshold from 6+ to 3+ files. Vanguard reconnaissance is now mandatory when scope remains unclear after triage.
- **Anti-pattern Addition**: Added "Reading 3+ files directly to gather context instead of sortieing Vanguard/Tempest" to the Delegation Policy anti-patterns list.
- **JobStreamArchive Read-Many Policy**: Full archived results via `carrier_jobs` are no longer invalidated after the first read. Both summary cache and full archive now share the same read-many semantics with a 3-hour TTL. `getAndInvalidate()` renamed to `getFinalized()`.
- **Fleet Bridge Rendering**: Reworked the expanded Fleet Bridge panel into job-scoped columns, where each active sortie, squadron, or taskforce appears as its own column with a tree of tracks and the latest five streaming lines.
- **Shipyard Tool Rendering**: Replaced dynamic streaming `renderCall` components for sortie, squadron, and taskforce tools with fixed-height one-line summaries to avoid PI TUI scroll jumps while preserving live output in Fleet Bridge.
- **Shipyard Tool Summary Colors**: Applied tool-kind colors to Sortie, Taskforce, and Squadron `renderCall` labels and payload text, reusing the Status Bar TF/SQ badge colors for taskforce and squadron summaries.
- **Carrier Status Animation**: Limited the carrier status spinner animation to sortie-style carrier streaming; squadron and taskforce jobs now keep the status bar stable while their detailed progress streams in Fleet Bridge.

### Fixed
- **Thought Block Test Alignment**: Two `carrier-job-shared` tests that expected thought blocks in the archive now correctly reflect the thought-exclusion policy introduced in v0.3.2.
- **Sortie Panel Streaming**: Fixed sortie tracks staying idle in Fleet Bridge by binding PanelJob tracks to the actual stream-store run after the background run is created, instead of prebinding stale visible run IDs.
- **Panel Runtime Stability**: Removed a panel state/jobs circular import and foreground active-job side effects that could break Fleet Bridge rendering or leave PI unable to send follow-up chat messages after a reload.
- **Carrier Jobs Verbose Rendering**: Wrapped verbose `carrier_jobs` JSON output by terminal width so large `full_result` payloads cannot produce extremely long TUI lines.

### Removed
- **Legacy Fleet Bridge Switching UI**: Removed job-bar switching state and obsolete job navigation shortcuts now that all active jobs render simultaneously as panel columns.
- **Shipyard Streaming Components**: Removed the old dynamic Messages streaming components and related dead code from sortie, squadron, and taskforce tool renderers.

## [0.3.2] - 2026-04-27

Release v0.3.2

## [0.3.1] - 2026-04-26

### Changed
- **Dev Mode RISEN Prompt**: Boot extension now injects a RISEN (Role-Instructions-Steps-EndGoal-Narrowing) prompt for pi-fleet development via `before_agent_start` when running `fleet-dev`. Fleet persona/role/tone sections are skipped in dev mode.
- **System Prompt Registration via `before_agent_start`**: Removed `setCliSystemPrompt`/`getCliSystemPrompt` globalThis bridge entirely. All system prompt registration now uses pi's `before_agent_start` Append pattern (boot → fleet → grand-fleet order).
- **Function Renames**: `buildAcpSystemPrompt` → `buildSystemPrompt`, `buildAcpRuntimeContext` → `buildRuntimeContextPrompt`.
- **Prompt Section Tags**: Unified individual XML tags (`<fleet_role>`, `<fleet_persona>`, etc.) into `<fleet-system section="...">` tag format.

### Added
- **Log Category Registry**: Introduced pre-registration system for log categories. Unregistered category logs are silently ignored. Categories can be toggled on/off via `fleet:log:settings` and `fleet:log:category` slash commands.
- **System Prompt Logging**: Full system prompt is now logged under the `acp-system-prompt` category on each ACP request (`hideFromFooter` applied).
- **Documentation Links**: Added `docs/` directory links to README.

## [0.3.0] - 2026-04-26

### Changed
- **`<system-reminder>` Doctrine Realignment**: Restricted `<system-reminder>` wrapping to `pi.sendMessage`-delivered carrier completion pushes only.
    - Synchronous tool responses — launch acceptance text and `carrier_jobs` `notice` field — are now returned as plain text without any XML wrapping.
    - Completion pushes now carry a `source="carrier-completion"` attribute on `<system-reminder>` so the Admiral can identify framework-delivered carrier completion events.
    - `LAUNCH_REMINDER_TEXT` renamed to `JOB_LAUNCH_NOTICE` and compressed to a 2-sentence plain-text guidance referencing the new push attribute.
    - `wrapSystemReminder(text, attrs?)` signature extended to accept optional XML attributes; sole production caller is now `_shared/push.ts`.

## [0.2.0] - 2026-04-26

### Added
- **Carrier Jobs In-band Guidance**: Added a `notice` field to `carrier_jobs` responses for active jobs to deter LLMs from unnecessary polling.
    - Notices are now written in imperative form (e.g., "Stop calling tools now") and wrapped with `wrapSystemReminder` (`<system-reminder>` tag) to ensure LLM compliance.
    - `ACTIVE_STATUS_NOTICE`: Mode-agnostic guidance to wait for the `[carrier:result]` push; reinforces that the push wakes the agent even after the current response ends.
    - `ACTIVE_CANCEL_NOTICE`: Guidance when cancellation fails, clarifying that long-running jobs are expected and the job is not hung.
- **Push Delivery Mode Configuration**:
    - New slash command `/fleet:jobs:mode` to switch between `followUp` (default) and `steer` (advanced) push delivery modes.
    - SettingsOverlay (Alt+/) integration for "Push Mode" selection.
    - Persistent configuration in `~/.pi/fleet/settings.json` under the `fleet-push-mode` section.

### Changed
- **Improved Retry Guidance**: Updated the `retry_after` message for active job results to explicitly instruct against manual retries, reinforcing reliance on the automatic push mechanism.
- **Dynamic Push Delivery**: The `carrier-result` push delivery mode is now dynamic and respects the user-configured setting (defaulting to `followUp`).

## [0.1.3] - 2026-04-26

Tactical Steel rebranding + Ohio commission.

### Added
- **Asynchronous Carrier Operations**: `carriers_sortie`, `carrier_taskforce`, and `carrier_squadron` now operate in fire-and-forget mode.
- **New `carrier_jobs` Meta Tool**: Introduced for managing detached carrier jobs with actions: `status`, `result`, `cancel`, and `list`.
- **Job Stream Archive**: Centralized storage for detached job outputs with 3-hour TTL and 8MB/2000-block capacity limits.
- **Result Push Mechanism**: Framework now pushes `[carrier:result]` signals to notify the Admiral of job completion.
- New `Ohio` carrier (CVN-10, Codex CLI) — sole receiver of `plan_file` (under `.fleet/plans/*.md`), executes WBS waves end-to-end.
- Global executable commands (`fleet`, `gfleet`, `fleet-dev`, `gfleet-dev`).
- CI workflow to auto-tag main pushes with CHANGELOG section as annotated message.
- Pull request template (`.github/PULL_REQUEST_TEMPLATE.md`).
- Admiral workflow reference documentation (`docs/admiral-workflow-reference.md`).

### Changed
- **Worldview-aware `<fleet_role>`**: When the `metaphor.worldview` toggle is OFF, `buildAcpSystemPrompt()` now injects a neutral role prompt (`FLEET_ROLE_PROMPT_NEUTRAL`) that drops naval honorifics, report-form enforcement, and Bridge/Helm metaphors while preserving functional contracts (carrier delegation, pi-tools lazy-loading awareness, Korean-only responses). Persona/tone overlays remain gated by the same toggle.
- **Worldview-aware Grand Fleet role prompts**: When the `metaphor.worldview` toggle is OFF, `extensions/grand-fleet/prompts.ts` now switches Admiralty/Fleet/Fleet ACP role variants to neutral prompts, neutralizes Admiralty designation guidance, and only injects Fleet persona/tone into ACP base prompts when Grand Fleet context is omitted so metaphor tone no longer leaks through worldview-disabled paths.
- **Metaphor Domain Integration**: Unified `improve-prompt` into `directive-refinement` and migrated it to the `metaphor` extension domain.
    - New Settings Path: `metaphor.directiveRefinement` (replaces legacy `core-improve-prompt`).
    - New Slash Command: `fleet:metaphor:directive`.
    - Integrated **3-section (3섹션)** Output Format: Refined directives now follow a structured "Directive / Rationale / Residual Risks" markdown schema.
    - Updated documentation (`AGENTS.md`, `SETUP.md`) to reflect the new naval hierarchy domain boundaries.
- **Tool Contract Refactoring**: Carrier tools now return a `job_id` immediately instead of waiting for full execution.
- **Read-Once Result Policy**: Full archived results via `carrier_jobs` are now invalidated after the first successful retrieval to manage memory footprint.
- Renamed `Oracle` → `Nimitz` (CVN-09, Strategic Command & Judgment, read-only).
- Renamed `Athena` → `Kirov` (CVN-02, Operational Planning Bridge, plan_file author).
- Renamed `Echelon` → `Tempest` (CVN-07, Forward External Intelligence Strike).
- Genesis reverted to single-shot implementation; `plan_file` request block and related principles removed.
- Admiral delegation doctrine replaced "Oracle vs Athena Decision Flow" with "Nimitz → Kirov → Ohio 3-Step Strike Pipeline".
- Reorganized keybind overlay categories for better clarity:
    - `Alt+M` (metaphor-directive-refinement `refine-directive`): `Meta Prompt` → `Metaphor`.
    - `Alt+T` (bridge `launch`): `Bridge` → `Fleet Bridge`.
    - `Alt+O` (fleet `carrier-status`): `Fleet` → `Fleet Bridge`.
- Updated Fleet Bridge status bar hints (`PANEL_MULTI_COL_HINT` and `PANEL_DETAIL_HINT`) by removing retired `alt+x cancel` and `alt+shift+m model` references.
- Refreshed README structure and renamed Agent Panel to Fleet Bridge.
- Split grand fleet role pipelines and fleet wiring, and tightened Kirov planning contract.

### Fixed
- Restored ACP session resume.
- Serialized fleet state writes to prevent race conditions.

### Removed
- `Alt+S` (core-hud `stash`): Removed editor text stashing/restoration and associated session/agent lifecycle management.
- `Alt+Shift+M` (fleet `model-change`): Removed shortcut for changing carrier models. Operators should use the `fleet:agent:models` slash command or the `Alt+O` settings overlay instead.
- `Alt+R` (core-improve-prompt `reasoning-cycle`): Removed meta-prompt reasoning level cycle shortcut. Reasoning levels can still be adjusted via `fleet:prompt:settings`.
- `Alt+X` (fleet `carrier-cancel`): Removed operation cancellation shortcut and retired the underlying abort controller infrastructure (`abortCarrierRun`, `RunnerState`).
- Removed the obsolete root-level `models.json`; model registry data remains in `packages/unified-agent/models.json`.
- `oracle.ts`, `athena.ts`, `echelon.ts` carrier definitions (replaced by `nimitz.ts`, `kirov.ts`, `tempest.ts`).

### Notes
- `states.json` entries keyed by retired carrier IDs are dropped at next boot (no migration code added).

## [0.1.2] - 2026-04-24

### Added
- `PI_EXPERIMENTAL` environment flag to opt into experimental extensions during boot.
- GPT-5.5 Codex model entry in `packages/unified-agent/models.json`.
- Provider-specific unified-agent clients for Claude, Codex, and Gemini.
- Codex app-server connection path with dedicated event and lifecycle coverage.
- Unified-agent provider contract E2E coverage.
- `/fleet:update` slash command in the welcome extension that instructs the active PI agent to pull the local `pi-fleet` checkout and apply the `SETUP.md` update steps.
- Prominent full-width update alert banner rendered above the welcome box when the local branch is behind its remote; replaces the duplicate right-column `Update available` block while active, and is fully hidden when up-to-date or no upstream is configured.

### Changed
- Split the monolithic `UnifiedAgentClient` implementation into provider-specific clients.
- Reworked ACP provider execution and stream handling around the new client contracts.
- Updated unified-agent examples, README, and AGENTS guidance for the provider-client architecture.
- Added `@anthropic-ai/claude-agent-sdk` as a root dependency.

### Fixed
- Echelon repo cloning now uses the OS-native temporary directory.
- Admiral prompts now explicitly require the `pi-tools` MCP availability check.
- Codex commentary events are routed as message chunks.
- Fleet bridge panel widget synchronization now detaches stale panel contexts.
- Welcome extension now renders the current branch name and Fleet version even when the local branch has no upstream configured.

### Removed
- Legacy `ProcessPool` implementation and related benchmark/pool tests.
- Legacy raw ACP session E2E test in favor of provider-level E2E coverage.

### Security
- Welcome extension sanitizes C0 / DEL / C1 control characters from `gitUpdate.branch` and `gitUpdate.version` before rendering to prevent terminal escape injection via crafted branch names or `package.json` version values. The original `GitUpdateStatus` object is not mutated — sanitization is display-only.

## [0.1.1] - 2026-04-23

### Added
- MCP keepalive mechanism (`provider-mcp.ts`): improved MCP server connection stability
- `diagnostics` extension extracted as a standalone module (`extensions/diagnostics/`): dedicated `dummy-arith` diagnostic tool
- Fleet version display in Welcome screen update status line (e.g., `Up to date (main) · v0.1.1`)
- ACP↔MCP bridge redesigned with a robust queue/router model
  - Per-session FIFO tool-call queues and Bearer token isolation for the singleton MCP server
  - Router lifetime preserved across `done="toolUse"` handoffs within the same logical prompt
  - Explicit cleanup logic on `stop`, `error`, or `abort`
  - Single-instance HTTP server with UUID-based opaque paths

### Changed
- Upgraded `pi-sdk` to 0.69 (`package.json`)
- Consolidated sub-package `package-lock.json` files (`core/agentclientprotocol`, `core`, `core/shell`, `fleet`) into the root and removed them
- Updated `SETUP.md` to reflect project setup and structural changes

### Fixed
- Windows: fixed Codex/Claude CLI `spawn` path error (`packages/unified-agent/src/utils/npx.ts`, `BaseConnection.ts`)
- Welcome extension: use `import.meta.url`-based `__dirname` instead of `process.cwd()` for git update check (`extensions/core/welcome/welcome.ts`)

## [0.1.0] - 2026-04-22

Initial release.

### Added
- **unified-agent package** (`packages/unified-agent/`): unified CLI agent SDK supporting Claude, Codex, and Gemini
  - Core components: `AcpConnection`, `UnifiedAgentClient`, `ModelRegistry`
- **Core extensions** (`extensions/core/`):
  - `agentclientprotocol`: ACP↔MCP bridge and tool-call management
  - `hud`: status bar customization (colors, editor state, git status, etc.)
  - `welcome`: welcome screen and Git remote update detection (`✓ Up to date`, `⚠ Update available`)
  - `keybind`, `settings`, `shell`, `log`, `summarize`, `improve-prompt`, `thinking-timer`: system utilities
- **Fleet extensions** (`extensions/fleet/`):
  - `admiral`: Admiral prompt system and Standing Orders
  - `bridge`: Fleet Bridge panel UI
    - Inline slot navigation: `Alt+H`/`Alt+L` (move), `Ctrl+Enter` (activate immediately)
    - Visual cursor highlight (`▸` prefix + highlight color)
    - Dynamic CliType Overrides: change CLI type instantly with `c` key in `Alt+O` overlay; saved permanently to `states.json`
  - `carriers`: 7 carrier definitions — Athena, Genesis, Oracle, Sentinel, Vanguard, Echelon, Chronicle
  - `shipyard`: Carrier sortie, Squadron, and Taskforce management
- **Grand Fleet extension** (`extensions/grand-fleet/`): centralized control of multiple PI instances with JSON-RPC IPC
- **Metaphor extension** (`extensions/metaphor/`): persona and worldview system
- **Boot extension** (`extensions/boot/`): system bootstrap entry point

### Removed
- Legacy modules removed: `unified-agent-core`, `unified-agent-direct`, `unified-agent-tools`, `utils-improve-prompt`, `utils-summarize`
- HUD legacy consolidation: `hud-core`, `hud-editor`, `hud-welcome` merged into `core/hud`

### Breaking Changes
- Removed `Alt+1~9` individual carrier shortcut keys (replaced by Fleet Bridge navigation)
