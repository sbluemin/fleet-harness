# Changelog

All notable changes to this project will be documented in this file.
This format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.20.0] - 2026-05-16

### Added
- [unified-agent] Added 1M context models to the Cursor provider catalog with robust effort/reasoning parameter combination via ACP

### Changed
- [harness] Enforce `canary` as the only allowed PR base; non-canary PRs, including from forks, are auto-closed with guidance.
- [harness] Auto fast-forward `canary` to match `main` after each push to `main` so release commits propagate automatically.
- [harness] Removed the `fleet-dev` binary; use `pnpm dev` for CWD-routed development launches instead.
- [wiki] Wiki tool rendering is now consistent with carrier tools, featuring a transparent background in the TUI for improved visual integration.

### Fixed
- [core][wiki] Carrier executor MCP tool whitelist decoupled from wiki module load order; domain packages self-register tools into the executor whitelist so fleet-core no longer throws when invoked without fleet-wiki imported
- [harness] Fixed missing frontmatter on the pr-creates skill that prevented it from loading.

### Removed
- [coding-agent] Removed the `/scoped-models` slash command and associated configuration UI, along with related keybindings (`Ctrl+S`, `Ctrl+A`, `Ctrl+X`, `Alt+Up/Down`) for customizing model cycling scope.

## [0.19.0] - 2026-05-13

Release v0.19.0

## [0.18.5] - 2026-05-12

### Fixed
- [ai] Removed unused `canvas` devDependency from `fleet-ai` and dropped its `allowBuilds` entry to prevent `pnpm install` failures on platforms without prebuilt binaries or a C++ toolchain (e.g., Windows arm64 + Node 25)

## [0.18.4] - 2026-05-12

### Fixed
- [unified-agent] Codex legacy app-server exits are now classified as graceful, intentional, or abnormal so false turn-completion crashes are suppressed while real child exits include diagnostics.

## [0.18.3] - 2026-05-12

Release v0.18.3

## [0.18.2] - 2026-05-12

### Added
- [unified-agent] Added dual-transport support for Codex with a validation toggle (`CODEX_USE_ACP`), enabling both the new npx bridge (`codex-acp`) and legacy app-server connections

### Changed
- [unified-agent] Default Codex transport reverted to the legacy app-server path pending a Windows compatibility fix for the ACP npx bridge route

## [0.18.1] - 2026-05-12

### Added
- [coding-agent] Added `Settings.enterStreamingBehavior` ("steer" | "followUp", default "followUp") to control Enter submission behavior during active streaming
- [coding-agent] Added a GUI toggle for "Enter behavior" in the `/settings` overlay

### Changed
- [coding-agent] Unified message queueing under the Enter key; behavior now branches based on `enterStreamingBehavior` setting instead of dedicated keybindings

### Removed
- [coding-agent] Removed Alt+Enter (`app.message.followUp`) keybinding and `handleFollowUp()` handler

## [0.18.0] - 2026-05-11

### Added
- [core] Added per-sub-operation byte caps (20KB each) and a global ceiling (60KB) for `carrier_jobs(action:"result", format:"full")` responses in Squadron and TaskForce jobs
- [core] Implemented UTF-8 safe character-level slicing for job archives to prevent data corruption at multibyte character boundaries (e.g., CJK, emojis)
- [core] Preserved legacy 20KB single-cap behavior for `carrier_dispatch` while enabling precision char-slicing only for sub-operation paths via internal opt-in
- [core] Guaranteed sub-operation cap policy enforcement through `jobId` prefix fallback (`squadron:` / `taskforce:`), ensuring consistency even after summary LRU eviction
- [unified-agent] New Cursor Agent backend provider added with ACP protocol support, single agent mode, and first-prompt-pending system prompt pattern
- [unified-agent] Cursor Agent model catalog introduced including Auto, Composer 2 (fast), Gemini 3.1 Pro, and Gemini 3 Flash
- [unified-agent] Live Cursor service status monitoring integrated via Statuspage with primary matching for CLI, Cloud Agents, and cursor.com components

### Changed
- [core][harness] Model ID suffix (Unified) removed and model names are now used directly as IDs for consistency
- [harness] Carrier Status overlay UX improved by replacing raw CLI keys and internal model IDs with user-friendly provider and model names across all selection panels and status displays

### Removed
- [unified-agent] Nine models removed from OpenCode Go catalog including Kimi K2.5, Mimo V2/V2.5 variants, Minimax M2.5/M2.7, and Qwen 3.5/3.6 Plus

### Fixed
- [core][harness] Concurrent Fleet instances now self-heal stale `cliType` and model selections from `states.json`, suppress watcher self-echo, and prevent Carrier Status overlay crashes caused by provider-mismatched model pairs

## [0.17.2] - 2026-05-11

### Fixed
- [harness] Carrier Status (Alt+O) and Task Force config (`t`) overlays no longer crash on narrow terminals or when carrier names contain wide characters such as CJK glyphs

## [0.17.1] - 2026-05-10

### Changed
- [core] Carrier job archive serializer optimized to reduce token consumption by ~67% through compact JSON formatting, removal of header metadata and per-block ISO timestamps, and elimination of pretty-print indentation

## [0.17.0] - 2026-05-10

### Changed
- [core] Host and carrier ACP session mappings now persist as `fleet/host-session` and `fleet/carrier-session` custom entries inside the host JSONL session file instead of a separate `~/.fleet/session-maps/<pid>.json` sidecar; legacy `session-maps/` directory is auto-deleted once at boot with no data preserved
- [harness] Package and workspace directory renamed from fleet-harness-extension to fleet-harness

## [0.16.0] - 2026-05-10

### Added
- [unified-agent] Claude reasoning effort enabled across all Claude models via `_meta.claudeCode.options.effort` bridge channel
- [ai][coding-agent] `defaultThinkingLevel` field added to model and provider model configurations for per-model default thinking level assignment
- [harness] Per-carrier default model and reasoning effort assignments seeded on first Fleet boot

### Changed
- [core][unified-agent] Unified raw thinking effort ownership under unified-agent and selectable UI thinking-level policy under fleet-core
- [unified-agent] claude-agent-acp npx bridge upgraded from 0.29.2 to 0.33.1
- [unified-agent] @agentclientprotocol/sdk dependency bumped from ^0.19.0 to ^0.21.0
- [unified-agent] Claude effort transmission moved from ACP `session/set_config_option` RPC to `_meta` spread in session/new and session/load payloads
- [unified-agent] SDK `unstable_closeSession` and `unstable_resumeSession` calls aligned to `closeSession` and `resumeSession` stable methods
- [coding-agent] Thinking level fallback source switched from settings persistence to the selected model's `defaultThinkingLevel` field
- [harness][unified-agent] Fleet provider thinking level mapping now derives from unified-agent `effort.default` mapped to provider model `defaultThinkingLevel`
- [harness] Carrier Status (Alt+O), Keybind (Alt+.), and Settings (Alt+/) overlays now render inside the editor area instead of floating above the screen; trigger keys and keyboard interactions remain unchanged
- [harness] Editor Job bar and above-editor carrier status widget unified into a single below-editor carrier HUD with arrow-key carrier focus and Enter to expand each carrier's carrier/squadron/taskforce jobs

### Removed
- [unified-agent] Claude `setConfigOption('effort')` no longer issues an ACP RPC (silently stored for next session)
- [unified-agent] `setModel` fallback to `session/set_config_option('model')` removed
- [coding-agent] Host-side thinking level reconciliation on session start and model select removed; thinking level now flows directly from model defaults

### Fixed
- [harness] Model-level thinking level capability map now derived from effort levels so xhigh and max are no longer downgraded to high during clamping
- [coding-agent] Switching models in interactive session now applies the target model's default thinking level instead of preserving the previous model's level

## [0.13.0] - 2026-05-05

### Added
- [harness] New wiki workspace tools for orientation, multi-entry read, context synthesis, batch ingest, and citation-aware query
- [harness] Canonical `[[wiki:id]]` link syntax established as the cross-layer standard across all wiki packages
- [harness] Human-readable markdown index catalog and append-only operational log for workspace auditability
- [harness] Workspace schema auto-bootstrapped with AGENTS.md and wiki-schema.md convention files
- [harness] Claim provenance sidecar files with read/write/list helpers for knowledge traceability
- [harness] Ingest conflict persistence with dedicated conflict directories and eleven new drydock semantic lint codes
- [harness] Ingest modes (auto/create/update) with conflict detection, stale-base rejection, and duplicate policies
- [harness] Retrieval boundary tags around LLM-facing wiki content for trust separation
- [harness] Expanded entry frontmatter with aliases, type, status, confidence, language, revalidation, and raw source refs
- [harness] Enhanced briefing ranker with alias/type/status freshness boost
- [harness] Web UI: conflict/log/index-md views, copy-context actions, and status badges
- [harness] Security headers (CSP, X-Content-Type-Options, Referrer-Policy, Cache-Control) on all web responses

### Changed
- [harness] All drydock prompts and lints now reference workspace schema as the authoritative convention guide
- [harness] Index rebuild atomically writes JSON and markdown catalogs together with a log entry
- [harness] Workspace initialization bootstraps schema files automatically

### Fixed
- [harness] create_wiki no longer silently overwrites existing entries; patch validation enforces update-only for modifications
- [harness] Raw source files include content-hash suffix to prevent same-day filename collisions
- [harness] Index catalog entry excluded from listings and direct reads; `index` reserved as entry ID
- [harness] Log entries with multiline or special characters no longer corrupt the single-line log invariant
- [harness] Path traversal prevented in raw-source reading helpers
- [harness] Web approve returns proper 409 status for create-target-already-exists scenarios
- [harness] Drydock `ok` status reflects zero errors, not zero issues; warnings no longer mark healthy stores as failed
- [harness] Client bundle no longer includes Node-only modules from fleet-wiki
- [harness] Nested wiki entries remain readable through fallback recursive scan when index is stale
- [harness] Patch IDs include target+body hash to prevent collisions in batch ingests
- [harness] Drydock queue listing handles corrupted entries gracefully instead of crashing
- [harness] Retrieval results consistent across wiki_briefing, wiki_query, and wiki_resolve via token-level OR matching

## [0.12.0] - 2026-05-04

### Breaking Changes
- [harness] Directive refinement settings shape changed from provider/model/reasoning to cliType/model/effort; existing settings not migrated
- [harness] Legacy settings fallback keys and standalone `/fleet:metaphor:directive` command removed; refinement now accessible only via Alt+M keybind

### Added
- [harness] Directive refinement uses callback-pattern executor runner instead of direct pi-ai dependency
- [harness] Output contract validator with NFKC normalization and multilingual coverage
- [harness] Common `<prior_jobs?>` request block auto-merged into all carrier prompts
- [harness] Carrier self-call hint doctrine for fetching prior job archive results
- [harness] Carrier brevity guideline updated with explicit job_id handoff contract
- [harness] Connect-time MCP for executor sessions so carriers can self-call allowed tools
- [harness] Inline refinement request builder with UNTRUSTED_DRAFT boundary markers
- [harness] Bilingual (English+Korean) prompt-injection rule for user-draft safety

### Changed
- [harness] Directive refinement settings UI now sources backends from the unified CLI catalog instead of pi-ai model registry
- [harness] Directive refinement doctrine delivered inline instead of as a separate connect system prompt

### Removed
- [harness] Standalone directive refinement command and separate compose module

### Security
- [harness] UNTRUSTED_DRAFT markers enforce explicit data boundary against prompt injection in refinement requests

## [0.11.5] - 2026-05-04

_(maintenance release)_

## [0.11.4] - 2026-05-04

_(maintenance release)_

## [0.11.3] - 2026-05-04

### Changed
- [harness] Executor surface made carrier-agnostic with generic poolKey field; callers map pool keys themselves

### Removed
- [harness] All carrier-bound executor types and helpers removed; consumers use generalized executeWithPool / executeOneShot

## [0.11.2] - 2026-05-04

### Added
- [harness] Fleet Wiki Drydock web page with pending/archived queue tabs and patch detail with action card
- [harness] REST API for queue listing, patch detail, approve/reject actions
- [harness] CLI auto-restart on stale dist with safety trust gates

### Changed
- [harness] Entry manifest panel rendered as frontmatter description list with metadata
- [harness] Server method whitelist expanded to accept POST for approve/reject only
- [harness] Sidebar Drydock placement moved between search and entry navigation

### Fixed
- [harness] Concurrent approve/reject race prevented via process-local patch action locks
- [harness] Wiki validation errors map to appropriate 4xx HTTP status codes
- [harness] UI duplicate-click guard on approve/reject buttons

### Security
- [harness] POST handler whitelisted to approve/reject only; strict origin equality; body size and content-type enforcement
- [harness] Stale-lock takeover hardening with multi-condition safety checks

## [0.11.1] - 2026-05-04

_(maintenance release)_

## [0.11.0] - 2026-05-04

### Added
- [harness] New standalone web surface for Fleet Wiki with dark theme, 3-column layout, command palette, and backlink panel
- [harness] `fleet-wiki` CLI command that serves the wiki web UI and manages per-user lock files
- [harness] Wiki web APIs for index, entry detail, search, backlinks, and health check
- [harness] Web security: DOMPurify sanitization, safe-ID validation, exclusive lock files, malformed-URL guards

## [0.10.2] - 2026-05-03

_(maintenance release)_

## [0.10.1] - 2026-05-03

### Breaking Changes
- [harness] Single `carriers_sortie` tool replaced by per-carrier MCP tools (e.g., carrier_genesis)
- [harness] `sortieDisabled` fleet-store key renamed to `offline`; no automatic migration performed

### Added
- [harness] Automatic fleet data directory migration from `~/.pi/fleet/` to `~/.fleet/` with deep-merge and backup
- [harness] Atomic migration lock with PID owner record and stale-lock recovery for concurrent boots

### Changed
- [harness] Per-carrier tool specs generated from carrier metadata directly; carrier availability reflected via tool registration
- [harness] Fleet data directory relocated to `~/.fleet/`, decoupled from Pi runtime environment variable

### Security
- [harness] Fleet directory I/O hardened with symlink-prevention flags, pre-checks, and restrictive file modes
- [harness] Migration lock path symlink attack prevented via fail-closed startup

## [0.10.0] - 2026-05-03

### Breaking Changes
- [harness] Carrier metadata now requires a category field; custom carrier definitions must be updated
- [harness] `streamingSink` API replaced by job stream event handler registration
- [harness] Bridge subpaths and legacy AgentStreamEvent type removed; use CarrierJobStreamEvent instead

### Added
- [harness] Carrier categories (strategy/planning/operations); status overlay groups carriers by category
- [harness] Normalized carrier job stream event type unifying all carrier streaming contracts
- [harness] Public API for registering carrier job stream event handlers
- [harness] Unified sanitize and detached job lifecycle modules
- [harness] Pure coalescing reducers and render-agnostic panel view-model builder

### Changed
- [harness] Removed all globalThis usage; runtime state migrated to module-level singletons
- [harness] Reload lifecycle resets ACP provider state and re-establishes carrier sessions on session_start
- [harness] Service-status consumption switched to unified-agent public API

### Removed
- [harness] Entire bridge directory, all provider-specific tool ports interfaces, streaming-sink module, and global bridge keys

## [0.9.0] - 2026-05-02

### Added
- [harness] Task Force backend whitelist expanded from 3 to 6 CLI providers; any persona may pair with any provider
- [harness] Task Force tool prompts and overlay colors auto-derived from CLI backend catalog

### Removed
- [harness] `budgetTokens` field removed from all model selection surfaces and runner contracts
- [harness] Claude-specific reasoning budget UI removed; unsupported providers show no effort/budget controls
- [harness] Local hardcoded CLI colors replaced by auto-derived catalog

## [0.8.1] - 2026-05-01

_(maintenance release)_

## [0.8.0] - 2026-05-01

### Added
- [harness] Active carrier jobs rendered as horizontal tiles below the editor input with keyboard navigation
- [harness] Unified track tree rendering for all job kinds with per-track colors and status icons
- [harness] Visual polish: bracket-wrapped focused tiles with wave animation and carrier-colored spinners

### Changed
- [harness] Expanded tracks show latest streaming block inline instead of multi-line child blocks
- [harness] All inline streaming uses a single color regardless of block type
- [harness] Sortie jobs now use consistent tree depth with squadron and taskforce

### Removed
- [harness] Tool-call statistics from track lines and various unused rendering utilities

## [0.7.1] - 2026-05-01

### Changed
- [harness] HUD status bar relocated from standalone widget into editor bottom border for compact layout
- [harness] Operation name moved from status bar to editor top-right border
- [harness] HUD state consolidated into a single shared singleton
- [harness] Model change reactivity fixed to bypass stale context getter

### Removed
- [harness] globalThis HUD render bridge and border bridge replaced by module-level variables and direct imports
- [harness] Dead code: unused operation segment definition and context fields

## [0.7.0] - 2026-05-01

### Added
- [harness] OpenCode Go CLI, Claude Z.AI GLM, and Claude Moonshot Kimi as first-class CLI providers
- [harness] Auth service for managing per-provider API keys with automatic env resolution

### Changed
- [harness] CLI display names sourced from models.json as single source of truth
- [harness] Build-connect-options made async to support per-CLI authentication
- [harness] Fleet ACP provider split per CLI with unified provider labels

### Removed
- [harness] `name` field from CLI backend entries; local display name hardcodes; vendor/CLI suffix stripping
- [harness] Provider catalog thin wrapper; direct unified-agent consumption
- [harness] Automatic Claude budget token filling; budget flows only when explicitly set

## [0.6.6] - 2026-04-30

_(maintenance release)_

## [0.6.5] - 2026-04-30

### Breaking Changes
- [harness] Massive reduction of public API surface; all downstream consumers must update
- [harness] `createFleetCoreRuntime` now strictly requires a new ports argument
- [harness] 16 deprecated public subpaths completely removed

### Added
- [harness] New agent runtime subpath with core execution and session management
- [harness] Lazy tool registration and unified MCP API with automatic lifecycle management
- [harness] Service status module for provider health tracking

### Changed
- [harness] Runtime initialization signature and context structure revised
- [harness] MCP server lifecycle internalized with auto-start and auto-terminate

### Removed
- [harness] Entire agent service directory (23 files), legacy agent services, tool registry services, and their public exports
- [harness] Duplicate definitions, wrapper types, and adapter classes

## [0.6.4] - 2026-04-30

_(maintenance release)_

## [0.6.3] - 2026-04-30

### Breaking Changes
- [harness] Agent service reorganized into 3-bucket structure; consumers must migrate import paths
- [harness] Log port interface removed; consumers use services/log directly
- [harness] Bridge export policy tightened; TaskForce state management changed

### Added
- [harness] Detached fanout helper to unify parallel-job runner logic
- [harness] Provider catalog extracted from fleet-store for isolation

### Changed
- [harness] Pi-Fleet extension restructured to flat domain architecture mirroring fleet-core services
- [harness] Pi-AI gateway relocated to a single domain-internal location
- [harness] Carrier prompts refactored for performance; service implementations consolidated

### Removed
- [harness] Legacy capability buckets and bindings directory; all content absorbed into domain homes
- [harness] Various dead public types, subpaths, files, and unused exports/symbols

## [0.6.2] - 2026-04-30

### Removed
- [harness] Fleet Wiki AAR support, including capture mode, prompts, schemas, and MCP tool
- [harness] Fleet Wiki append-log patch operation and related store directory

## [0.6.1] - 2026-04-30

### Changed
- [harness] All experimental-wiki directories, imports, and symbols renamed to fleet-wiki
- [harness] Fleet Bridge panel auto-collapses completed track details into single-line summary

## [0.6.0] - 2026-04-30

### Added
- [harness] Experimental wiki domain extracted into standalone fleet-wiki package

### Changed
- [harness] Core schemas, carrier mutators, and grand-fleet specs moved into fleet-core
- [harness] Grand Fleet domain re-embedded under fleet-core

### Breaking Changes
- [harness] Grand Fleet entrypoints moved; consumers must update import paths

## [0.5.0] - 2026-04-28

_(maintenance release)_

## [0.4.1] - 2026-04-28

### Removed
- [harness] Codex `service_tier` configuration support

## [0.4.0] - 2026-04-28

_(maintenance release)_

## [0.3.3] - 2026-04-27

### Added
- [harness] Fleet Bridge panel with job-scoped streaming model for all carrier types
- [harness] Bridge doctrine file documenting UI/runtime boundary

### Changed
- [harness] Fleet Action Protocol split into Scope Triage and Mandatory Vanguard Reconnaissance phases
- [harness] Direct file handling threshold lowered; delegation threshold tightened
- [harness] Job archive made read-many with 3-hour TTL (was read-once)
- [harness] Fleet Bridge rendering reworked into job-scoped columns with track trees
- [harness] Shipyard tools use fixed-height one-line summaries in conversation
- [harness] Carrier status animation limited to sortie-style streaming

### Fixed
- [harness] Sortie panel streaming fixed by binding tracks to actual stream-store run
- [harness] Panel runtime stability: circular imports and foreground side effects removed
- [harness] Verbose carrier_jobs output wrapped by terminal width

### Removed
- [harness] Legacy Fleet Bridge switching UI and obsolete job navigation shortcuts
- [harness] Old streaming components and dead code from carrier tool renderers

## [0.3.2] - 2026-04-27

_(maintenance release)_

## [0.3.1] - 2026-04-26

### Added
- [harness] Log category pre-registration system; unregistered categories silently ignored
- [harness] Full system prompt logged under dedicated category on each ACP request

### Changed
- [harness] Dev mode injects RISEN prompt; Fleet persona sections skipped
- [harness] System prompt registration uses pi's before_agent_start pattern instead of globalThis bridge
- [harness] Prompt section tags unified into consistent format

## [0.3.0] - 2026-04-26

### Changed
- [harness] `<system-reminder>` wrapping restricted to carrier completion pushes only; synchronous responses return plain text
- [harness] Completion pushes carry source identifier for framework identification

## [0.2.0] - 2026-04-26

### Added
- [harness] In-band guidance notices in carrier_jobs responses to deter unnecessary polling
- [harness] Push delivery mode configuration with slash command and settings overlay
- [harness] Persistent push mode setting in user configuration

### Changed
- [harness] Retry guidance explicitly instructs against manual retries
- [harness] Push delivery respects user-configured mode (followUp by default)

## [0.1.3] - 2026-04-26

### Added
- [harness] Asynchronous carrier operations with fire-and-forget execution
- [harness] carrier_jobs meta tool for managing detached carrier jobs
- [harness] Job stream archive with 3-hour TTL and capacity limits
- [harness] Result push mechanism notifies Admiral on job completion
- [harness] New Ohio carrier receiving plan_file for wave execution
- [harness] Global executable commands for fleet and grand fleet
- [harness] CI workflow for auto-tagging main pushes
- [harness] Pull request template and admiral workflow documentation

### Changed
- [harness] Worldview toggle switches between naval and neutral role prompts
- [harness] Metaphor domain reorganized; directive refinement and settings updated
- [harness] Carrier tools return job_id immediately instead of waiting for execution
- [harness] Carriers renamed: Oracle→Nimitz, Athena→Kirov, Echelon→Tempest
- [harness] Genesis reverted to single-shot implementation
- [harness] Delegation doctrine updated to Nimitz→Kirov→Ohio 3-step pipeline
- [harness] Keybind overlay categories reorganized

### Fixed
- [harness] ACP session resume restored
- [harness] Fleet state writes serialized to prevent race conditions

### Removed
- [harness] Various keyboard shortcuts, obsolete carrier definitions, and root-level models.json

## [0.1.2] - 2026-04-24

### Added
- [harness] PI_EXPERIMENTAL flag for opting into experimental extensions at boot
- [harness] Provider-specific unified-agent clients for Claude, Codex, and Gemini
- [harness] Provider contract E2E test coverage and update slash command
- [harness] Update alert banner in welcome screen

### Changed
- [harness] UnifiedAgentClient split into provider-specific implementations
- [harness] ACP execution and stream handling reworked for new client contracts

### Fixed
- [harness] Admiral prompts now explicitly require the pi-tools availability check
- [harness] Codex commentary events routed as message chunks
- [harness] Panel widget synchronization detaches stale contexts
- [harness] Welcome extension renders branch info correctly without upstream configured

### Removed
- [harness] Legacy ProcessPool implementation and related tests

### Security
- [harness] Welcome extension sanitizes control characters from branch/version display

## [0.1.1] - 2026-04-23

### Added
- [harness] MCP keepalive mechanism for connection stability
- [harness] Standalone diagnostics extension with diagnostic tool
- [harness] Fleet version display in welcome screen
- [harness] Redesigned ACP↔MCP bridge with per-session FIFO tool-call queues and Bearer token isolation

### Changed
- [harness] pi-sdk upgraded; sub-package lock files consolidated into root

### Fixed
- [harness] Windows CLI spawn path error fixed
- [harness] Welcome extension uses correct base path for git update check

## [0.1.0] - 2026-04-22

### Added
- [harness] Unified CLI agent SDK with Claude, Codex, and Gemini support
- [harness] Core extensions: ACP bridge, HUD customization, welcome screen, system utilities
- [harness] Fleet extensions: Admiral prompt system, Fleet Bridge panel, 7 carrier definitions, sortie/squadron/taskforce management
- [harness] Grand Fleet extension for multi-PI orchestration with JSON-RPC IPC
- [harness] Metaphor extension for persona and worldview
- [harness] Boot extension for system bootstrap

### Removed
- [harness] Legacy modules and HUD consolidation

### Breaking Changes
- [harness] Individual carrier shortcut keys removed (replaced by Fleet Bridge navigation)
