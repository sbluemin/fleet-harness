# Changelog

All notable changes to this project will be documented in this file.
This format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- [core] Added per-carrier Native(SubAgent) toggles for Claude-family dedicated CLI sessions.
- [core] Added per-carrier Claude Native(SubAgent) effort defaults to startup agent payloads.

### Changed
- [core] Carrier Status is now reached from Mission Control's `C` shortcut as Carrier Roster.
- [core] Moved default carrier persona settings into each persona module while preserving deterministic carrier registration order.

### Fixed
- [core] Enabled Agent CLI app-mouse drag forwarding while preserving existing Fleet scroll fallback behavior.

### Removed
- [core] Removed the `Alt+O` host shortcut for opening carrier configuration.
- [core] Removed legacy default persona registry exports and unused carrier config renderer hooks.
- [core] Removed the `claude-zai` and `claude-kimi` dedicated Agent CLI profiles from the upper-pane selection; the underlying auth and provider backends remain supported.

## [1.0.2] - 2026-05-26

### Added
- [unified-agent] Added Cursor Composer 2.5 and Composer 2.5 Fast models.

### Changed
- [core] Consolidated the release pipeline onto the `main` branch: stable releases now run automatic version bumping, CHANGELOG promotion, npm publish, and GitHub Release creation in a single workflow triggered by pushes to `main`.
- [core] Mission Control welcome readout now labels published builds uniformly as `stable`; unpublished working copies remain labeled as `local`.
- [wiki-web] Aligned `fleet wiki --help` with the Fleet-branded English help style and primary `fleet wiki` command spelling.

### Removed
- [core] Removed the `canary` npm dist-tag and the auto-publish workflow that fired on every push to the `canary` branch. The `canary` branch is retained as the PR integration target but no longer publishes any artifacts.
- [core] Removed the manual workflow_dispatch release workflow that targeted the `canary` branch.
- [core] Removed the `canary` runtime channel from the Fleet CLI release type, update channel, mission-control welcome label, and prerelease detection logic.

## [1.0.1] - 2026-05-25

### Fixed
- [core] Fixed global installation of `@dotobokuri/fleet-cli` failing at startup with `ERR_MODULE_NOT_FOUND: @xterm/headless` by including the package as a runtime dependency in the published metadata.

### Changed
- [core] Documented `@dotobokuri/fleet-cli` as a global-only CLI tool in the package README with explicit `npm`, `pnpm`, and `yarn` install commands, and added the `preferGlobal` flag to the published `package.json`.

## [1.0.0] - 2026-05-25

Release v1.0.0

## [0.22.2] - 2026-05-25

### Added
- [agent-core] Added Mission Control for starting or relaunching the upper Agent CLI after exit.
- [agent-core] Added native Mission Control Fleet Menu panels for authentication, wiki server control, diagnostics, and about information.
- Added persistent Fleet CLI startup presets with Mission Control option editing and explicit save/reset controls.
- [core] Added double-tap Ctrl+C confirmation before exiting the fleet CLI.
- [core] Mission Control now checks the npm registry asynchronously for the latest version on the user's channel and surfaces an update-available notice on the welcome screen.
- [core] Added `fleet update` subcommand that auto-detects global installation, determines the package manager, and upgrades both `fleet-cli` and `fleet-wiki-ui` together; falls back to printing the install command when the installation scope cannot be confirmed.

### Changed
- [agent-core] Changed Carrier Status to open as a Mission Control panel while preserving active Agent CLI input pass-through.
- [core] Mission Control idle screen now renders a Fleet-branded welcome with the gradient banner, amber accent, a carrier/wiki/queue readout, and a version line tagged as `local`, `canary`, or `stable` (unpublished working copies are detected via the package `private` flag; published prereleases by the version suffix) in place of the bare CLI picker.
- [core] Renamed the CLI launch/profile terminology to Agent CLI, including the `agent-cli` path and `FLEET_AGENT_CLI` selector.
- [core] HUD label is now a compile-time constant tied to the single immutable Fleet Action Protocol; the protocol switching abstraction and dynamic protocol state have been removed.
- [agent-core] fleet CLI now rejects unknown subcommands and options with an error message on stderr and exits with status 1 instead of silently ignoring them.
- Extracted Admiral prompt and Fleet tool policy into the new `@dotobokuri/fleet-admiral` workspace package; the fleet CLI now consumes it as a typed dependency through the package's root barrel instead of owning the policy modules in-tree.
- [mcp-server] Added `createExecutorSessionManager(deps)` factory and `Executor*` session types; the multi-runtime MCP session lifecycle helper formerly named `createDedicatedMcpSession` is now owned by the generic MCP server package.
- [core] Unified `fleet-carriers` internal module topology into `personas/`, `store/`, `dispatch/`, `stream/`, and `jobs/`; removed obsolete `job/` and `events/` directory split.
- [core] Unified the Mission Control welcome banner with the `fleet --help` ASCII banner so both surfaces share a single Fleet wordmark.
- [core][wiki-web] Wiki Server panel now reuses an existing healthy background daemon, opens the browser on Enter in any state (start or reopen), exposes daemon stop on the dedicated `S` shortcut, and aligns its default port with the `fleet wiki` CLI.

### Fixed
- [agent-core] Fixed executor pool busy session isolation, stale pooled client lookup, and internal MCP tool signature drift.
- [core][wiki-web] Fixed Wiki Server panel failing silently when a previous daemon held the lock, mis-reporting running daemons as stopped on panel re-entry, and swallowing permission errors during daemon shutdown.

### Removed
- Removed unused carrier runtime, TUI primitive, and agent model helper APIs that were no longer consumed by workspace packages.
- [agent-core] Removed carrier session persistence runtime; session reuse is now driven exclusively by in-memory executor client pool state without JSONL custom entry tracking.
- [core] Removed the top-level `-rsp` / `--replace-system-prompt` Fleet CLI flag; the option is now toggled via the Mission Control options drawer, the `FLEET_REPLACE_SYSTEM_PROMPT` env var, or a saved preset.
- [core] Removed the top-level `-n` / `--native` and `-em` / `--enable-metaphor` Fleet CLI flags; both options are now toggled via the Mission Control options drawer, the `FLEET_NATIVE` / `FLEET_ENABLE_METAPHOR` env vars, or a saved preset.

### Breaking Changes
- [agent-core] Removed `@dotobokuri/fleet-tui/input` and `@dotobokuri/fleet-tui/pty`; primitive component contracts now use `@dotobokuri/fleet-tui/components`, layout resize contracts use `@dotobokuri/fleet-tui/layout`, and the xterm-backed Agent CLI viewport is owned by fleet CLI controls.
- [core] Removed the in-tree Grand Fleet policy modules (IPC framing, mission reporter, status source, tool specs, ACP prompt builders, runtime access, and text sanitizer) along with their tests; this code was already unreferenced by the fleet CLI runtime.

## [0.22.1] - 2026-05-24

Release v0.22.1

## [0.22.0] - 2026-05-24

Release v0.22.0

## [0.22.1] - 2026-05-24

Release v0.22.1

## [0.22.0] - 2026-05-24

### Added
- Added `@dotobokuri/fleet-infra` as the host-agnostic infrastructure package for auth, data-dir, job, log, and settings services.
- [core] Per-carrier builtin external MCP allowlist; Tempest now exposes the grep.app code search MCP.
- [agent-core] Added auth login, list, and logout commands with migrated auth storage and Claude-family alternate backend support.
- [agent-core] Added `--model` option to forward a model name to the selected dedicated CLI, and reorganized `--help` output into Fleet Agent and underlying CLI option categories.
- [wiki-web] Command palette can now be toggled with the Cmd+K (or Ctrl+K) keyboard shortcut.
- [wiki-web] Command palette now locks page scroll while open and restores it on close.
- [wiki-web] Keyboard focus is now trapped within the command palette while it is open, restoring the previous focus on close.
- [wiki-web] Hovering over a search result now synchronizes the active selection.
- [wiki-web] Search matches in result titles are now visually highlighted.
- [wiki-web] Search results now display body match excerpts with markers stripped for readability.
- [wiki-web] Command palette results are now grouped under section headers for recent and matched entries.

### Changed
- [wiki-web] Inline mermaid diagrams now scale to fit the container as a miniature overview instead of rendering at intrinsic size with overflow scroll; the lightbox retains full-size pan/zoom.
- [wiki-web] Removed raw relevance scores from command palette search results.
- Split Fleet internal MCP access into independent `fleet-carriers` and `fleet-wiki` servers with isolated tokens.
- [core] carrier_jobs full responses for auto-promoted Task Force jobs return per-backend results keyed by CLI type instead of a single full_result string.
- [core][carriers] Completed migration of carrier runtime, dispatch, jobs, store, and Task Force implementation to `@dotobokuri/fleet-carriers` while removing obsolete compatibility facades.

### Fixed
- [agent-core] Anchored CJK IME preedit to the dedicated CLI input cursor and added `--disable-cursor-sync` for terminals that need to opt out.

### Breaking Changes
- Removed the standalone Fleet Admiral and Fleet Admiralty workspace packages; Fleet Agent then owned the integrated single-fleet and Grand Fleet policy modules.
- Removed obsolete root infrastructure re-exports; consumers must import infrastructure APIs from `@dotobokuri/fleet-infra`.
- [core] Removed the carrier_taskforce tool; carrier_dispatch now auto-promotes carriers with configured Task Force to multi-backend execution.
- [core][agent-core] Removed the sortie toggle feature, eliminating the ability to toggle individual carriers offline, the 'd' keybinding in the carrier status overlay, offline carrier states/persistence, and all associated UI indicators (such as dimmed roster lines, inactive HUD tiles, and footer hints).
- [agent-core] Fleet-world tone overlay is now disabled by default; the previous `--disable-metaphor` flag is removed and replaced by an explicit `--enable-metaphor` opt-in.
- [unified-agent] Removed Gemini CLI provider support; users and API consumers must migrate to other supported CLI backends.

## [0.21.0] - 2026-05-20

### Added
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
- [core][mcp-server] Extracted Fleet MCP server and tool registry internals into a leaf package (`@dotobokuri/fleet-mcp-server`) and hardened with 1MiB body caps, 5m timeouts, and snapshot cleanup while preserving fleet-admiral facade compatibility; see `MIGRATION.md` in the package for details.
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
- Added `@dotobokuri/fleet-carriers` as the default carrier persona catalog and self-registration package.
- [core] Added carrier metadata-based executor MCP tool scoping while preserving tool-centric registration.
- [unified-agent] Added 1M context models to the Cursor provider catalog with robust effort/reasoning parameter combination via ACP

### Changed
- Enabled parallel execution for `carrier_dispatch` on the same carrier, eliminating the "carrier busy" rejection for concurrent requests.
- Deprecated `squadronEnabled` persistence key in `fleet-store`; the field is now ignored during runtime initialization.
- [core] Carrier prior-job access now requires explicit persona `carrier_jobs` tool and `<prior_jobs?>` request-block declarations instead of inherited defaults; `CarrierMetadata.commonRequestBlocks` removed.
- [carriers] `PRIOR_JOBS_REQUEST_BLOCK` constant moved from fleet-admiral to fleet-carriers/constants.ts for better domain isolation.
- [wiki] Five read-only wiki tools (`wiki_briefing`, `wiki_orient`, `wiki_query`, `wiki_read`, `wiki_resolve`) are now registered globally, making the wiki knowledge base available to all carriers by default.
- [agent] Enforce `canary` as the only allowed PR base; non-canary PRs, including from forks, are auto-closed with guidance.
- [agent] Auto fast-forward `canary` to match `main` after each push to `main` so release commits propagate automatically.
- [agent] Removed the `fleet-dev` binary; use `pnpm dev` for CWD-routed development launches instead.
- [wiki] Wiki tool rendering is now consistent with carrier tools, featuring a transparent background in the TUI for improved visual integration.

### Fixed
- [core][wiki] Carrier executor MCP tool whitelist decoupled from wiki module load order; domain packages self-register tools into the executor whitelist so fleet-admiral no longer throws when invoked without fleet-wiki imported
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
