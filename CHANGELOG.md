# Changelog

All notable changes to this project will be documented in this file.
This format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.21.0] - 2026-05-20

### Added
- [agent-core] Added Fleet auth login, list, and logout commands with migrated auth storage and Claude-family alternate backend support.
- [agent-core] Added `--replace-system-prompt` (`-rsp`) CLI flag that overrides instead of appending the system prompt when launching the Claude dedicated CLI.
- [agent] Added Fleet Wiki tools to dedicated CLI MCP sessions through fleet-agent boot registration.
- [core][agent] Added dedicated CLI launch injection for Fleet Admiral prompts, Fleet MCP access, and native permission bypass flags for Claude and Codex.
- [wiki] Added `wiki_patch_edit` for approval-gated in-place edits to pending wiki patches.
- [core][agent] Absorbed Job Bar functionality from former harness into fleet-agent, including a dynamic job status section, active-only frame ticker, and programmatic PTY input bridge.
- [wiki] Implemented approve-time stale-base guard using content hash and version checks to prevent concurrent modification conflicts.
- [wiki] Added automatic `rawSourceRefs` accumulation and deduplication to preserve complete provenance history across entry updates.
- [wiki] Enforced POSIX target validation and `realpath`-based approval locks to prevent path traversal and symlink/case-alias attacks.
- [wiki] Enhanced `wiki_compile_source` with improved update provenance and related entry tracking for batch operations.
- [wiki] English localization of all tool prompts, schemas, and guidelines in `prompts.ts`.

### Fixed
- Resolved an issue where concurrent dispatches from the same carrier shared a single PanelRun and collapsed into one line by enforcing unique run identifiers.
- [wiki] Unified patch hash calculation to cover the entire `patch.md` content, ensuring `summary` frontmatter changes are correctly reflected in `changed_fields`, `patch_hash`, and `base_patch_hash`.
- [wiki] Introduced per-`patch_id` in-process mutex and snapshot atomicity to prevent race conditions during concurrent `wiki_patch_edit`, `approve`, and `reject` operations.
- [wiki] Integrated `lastEditHash` as the single source of truth (SSoT) for the actual written patch hash to ensure consistent stale-base detection during interleaved edits.
- [wiki-web] Large Mermaid diagrams are no longer clipped by the document container width.
- [core][agent] Prevented persistent JSONL session files from being written when an agent session is opened but never receives a user prompt, eliminating accumulated "(no messages)" entries in the session selector.
- [core][agent] Hardened session commit integrity by enforcing cross-session token guards to prevent stale state updates.
- [core] Improved session engine stability by implementing FIFO fatal error handling for ACP tool-call queues.
- [agent] Grand Fleet now re-registers with Admiralty when the bound ACP session ID changes or the client auto-reconnects after a socket drop, preventing stale registration state on session switches and reconnects.
- [agent] Fixed type-checking issues in status overlay tests by correcting state property access.
- [core] Fixed resource leaks by adding explicit executor pool disconnection wiring to `runtime.shutdown()`.

### Changed
- [agent-core] Carrier strip stays always visible while the Job Bar detail now auto-shows only when at least one carrier job is active, replacing the prior toggle shortcut and empty-state placeholder.
- Redesigned the Job Bar expanded view into a hierarchical structure featuring a carrier header and independent dispatch sub-lines.
- Enabled parallel execution for `carrier_dispatch` on the same carrier, eliminating the "carrier busy" rejection for concurrent requests.
- Deprecated `squadronEnabled` persistence key in `fleet-store`; the field is now ignored during runtime initialization.
- [wiki-web] Fleet Wiki Web now runs as a single per-user daemon that can open multiple registered workspaces with workspace-scoped URLs.
- [wiki-web] Made the `fleet-wiki` CLI entry point worktree-aware; it now automatically detects and executes the appropriate worktree-local distribution when running within a git worktree.
- [wiki-web] Relocated Table of Contents to a sticky rail card for wider document readability. The card hides when empty and hoists above content on mobile.
- [wiki-web] Added interactive Mermaid diagram lightbox with zoom controls (25–400%), drag-to-pan, mouse-wheel/keyboard shortcuts, auto-fit on open, and navigation-preserving anchor-link guards.
- [agent] Prompt templates are now invoked with the `/prompt:{name}` prefix, aligning with the `/skill:{name}` convention for consistent slash-command naming and eliminating namespace collision risk with built-in commands.
- [core][mcp-server] Extracted Fleet MCP server and tool registry internals into a leaf package (`@sbluemin/fleet-mcp-server`) and hardened with 1MiB body caps, 5m timeouts, and snapshot cleanup while preserving fleet-core facade compatibility; see `MIGRATION.md` in the package for details.
- [core] Enhanced session and executor engines to capture and validate origin tokens during state transitions and execution to ensure transactional integrity.
- [agent] Improved Grand Fleet registration stability by utilizing in-flight guards for session identifiers and generations instead of synthetic IDs.
- [core] Refined Grand Fleet registration state fields to include explicit status tracking for better observability.

### Removed
- [core] Removed unused legacy panel hint constants.
- Eliminated obsolete `visibleRunIdByCli` payload from status sources and the `_streams` parameter from status updates.
- Removed squadron-specific UI elements including the `[SQ]` badge, `→SQ` filtering, `S` toggle special handling, and Sortie-Squadron mutual exclusion logic.
- [agent] Removed Gemini and Cursor Agent from dedicated CLI support.
- [core][agent] Removed 'metaphor' domain (worldview, operation naming, directive refinement) and 'request_directive' tool.
- [wiki-web] Removed the Constellation (backlinks) panel and Outgoing references along with the backend backlink indexer and associated API.
- [agent-core] Removed service status UI and refresh logic.

## [0.20.0] - 2026-05-16

### Added
- Added `@sbluemin/fleet-carriers` as the default carrier persona catalog and self-registration package.
- [core] Added carrier metadata-based executor MCP tool scoping while preserving tool-centric registration.
- [unified-agent] Added 1M context models to the Cursor provider catalog with robust effort/reasoning parameter combination via ACP

### Changed
- Enabled parallel execution for `carrier_dispatch` on the same carrier, eliminating the "carrier busy" rejection for concurrent requests.
- Deprecated `squadronEnabled` persistence key in `fleet-store`; the field is now ignored during runtime initialization.
- [core] Carrier prior-job access now requires explicit persona `carrier_jobs` tool and `<prior_jobs?>` request-block declarations instead of inherited defaults; `CarrierMetadata.commonRequestBlocks` removed.
- [carriers] `PRIOR_JOBS_REQUEST_BLOCK` constant moved from fleet-core to fleet-carriers/constants.ts for better domain isolation.
- [wiki] Five read-only wiki tools (`wiki_briefing`, `wiki_orient`, `wiki_query`, `wiki_read`, `wiki_resolve`) are now registered globally, making the wiki knowledge base available to all carriers by default.
- [agent] Enforce `canary` as the only allowed PR base; non-canary PRs, including from forks, are auto-closed with guidance.
- [agent] Auto fast-forward `canary` to match `main` after each push to `main` so release commits propagate automatically.
- [agent] Removed the `fleet-dev` binary; use `pnpm dev` for CWD-routed development launches instead.
- [wiki] Wiki tool rendering is now consistent with carrier tools, featuring a transparent background in the TUI for improved visual integration.

### Fixed
- [core][wiki] Carrier executor MCP tool whitelist decoupled from wiki module load order; domain packages self-register tools into the executor whitelist so fleet-core no longer throws when invoked without fleet-wiki imported
- [agent] Fixed missing frontmatter on the pr-creates skill that prevented it from loading.

### Removed
- Removed squadron-specific UI elements including the `[SQ]` badge, `→SQ` filtering, `S` toggle special handling, and Sortie-Squadron mutual exclusion logic.
- [agent] Removed the `/scoped-models` slash command and associated configuration UI, along with related keybindings (`Ctrl+S`, `Ctrl+A`, `Ctrl+X`, `Alt+Up/Down`) for customizing model cycling scope.

## [0.19.0] - 2026-05-13

Release v0.19.0

## [0.18.5] - 2026-05-12

### Fixed
- Removed unused `canvas` devDependency and dropped its `allowBuilds` entry to prevent `pnpm install` failures on platforms without prebuilt binaries or a C++ toolchain (e.g., Windows arm64 + Node 25)

## [0.18.4] - 2026-05-12

### Fixed
- [unified-agent] Codex legacy app-server exits are now classified as graceful, intentional, or abnormal so false turn-completion crashes are suppressed while real child exits include diagnostics.

## [0.18.3] - 2026-05-12

Release v0.18.3

## [0.18.2] - 2026-05-12

### Added
- [unified-agent] Added dual-transport support for Codex with a validation toggle (`CODEX_USE_ACP`), enabling both the new npx bridge (`codex-acp`) and legacy app-server connections

### Changed
- Enabled parallel execution for `carrier_dispatch` on the same carrier, eliminating the "carrier busy" rejection for concurrent requests.
- Deprecated `squadronEnabled` persistence key in `fleet-store`; the field is now ignored during runtime initialization.
- [unified-agent] Default Codex transport reverted to the legacy app-server path pending a Windows compatibility fix for the ACP npx bridge route
