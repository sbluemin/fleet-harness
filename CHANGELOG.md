# Changelog

All notable changes to this project will be documented in this file.
This format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- [core] Fleet Console now guides first-time operators with a commissioning walkthrough — registering a Theater, opening an Operation, and observing carriers — shown automatically on the first empty-bridge launch, reopenable anytime from the Welcome dashboard, and surfaced as a setup action in the empty Theater state.
- [core] Fleet Console adds a global Settings screen to choose the system prompt injection mode (Append or Replace) and toggle the naval metaphor tone overlay, matching the options previously available only in the Fleet CLI; changes apply to newly launched sessions.
- [core] Fleet Console raises a global top-centre toast when a background Claude Operation pauses for operator input, naming its Theater and Operation with a control to jump there; unlike the sortie toast it stays until dismissed, and the Operation currently in view is suppressed.
- [core] The Fleet Console Codex (Fleet Wiki) surface can now open as a resizable side panel beside the current view in addition to its full-page route; a navigation-bar toggle switches between Full and Side and the choice is remembered, the panel resizes freely, and it shows only the Codex content when narrowed.

### Changed
- [core] The Fleet Console Operations Map fullscreen no longer exits on the Esc key; it can now only be exited with the maximize/restore control.
- [core] The Fleet Console global navigation bar now separates global Settings from per-carrier configuration, renaming the existing carrier entry to "Carriers" and adding a dedicated "Settings" entry.

### Removed
- [core] The Fleet Console Operations Map panel title bar no longer has a focus button for zooming a panel to fit, and the title-bar double-click that triggered the same zoom is removed along with it.

## [1.7.1] - 2026-06-17

Release v1.7.1

## [1.7.0] - 2026-06-17

### Added
- [core] The Fleet Console Operations Map now zooms smoothly with interpolated wheel zoom while panning stays immediate.
- [core] The Fleet Console Operations Map can open plain user-shell terminal panels in the active Theater's directory; activating one brings it to the front and highlights it as the active panel just like Operation panels, and they are not tracked as Operations or kept across reloads.
- [core] The Fleet Console Operations Map adds a right-click canvas menu to start a new Operation, open a shell, or reset the view at the cursor position.
- [core] Fleet Console Operations Map panels can now be focused by double-clicking an empty area of their title bar, in addition to the focus button.
- [core] Fleet Console Operations Map panels can now be renamed inline by double-clicking the panel name, reusing the same rename flow as the Operations list.
- [core] The Fleet Console Operations Map adds a bottom-right minimap showing all panels and the current viewport, draggable to navigate the canvas, and collapsible to a single bottom-right button that restores it when clicked.
- [core] Fleet Console Operations adds Alt+Left / Alt+Right to focus the previous / next Operation within the active Theater, working in both the Map and Helm views.
- [core] The Fleet Console Operations Map adds a collapsible bottom-left shortcut reference panel that collapses to a "?" button.
- [core] The Fleet Console Operations Map adds a maximize control next to the radar toggle that hides the global navigation bar with an animation and auto-collapses the Operations sidebar; exit with the control or Esc, remembered per browser.
- [core] Fleet Console Operation indicators now reflect the live Agent CLI turn state — grey before the first turn, amber while the agent is processing a turn, green once the turn ends, and the existing live colour whenever a carrier job is running.
- [core] Fleet Console raises a global top-centre toast when a background Operation reports a carrier sortie or stands down, naming its Theater and Operation with a Go control to jump there; it dismisses on close or after ten seconds, and the Operation currently in view is suppressed.

### Changed
- [core] Fleet Console now uses an in-console directory browser for Theater and workspace folder selection — a focused single-column folder list with breadcrumb path navigation, type-to-filter, full keyboard navigation, and single-click descent — replacing OS-native folder dialogs (PowerShell/COM, osascript, zenity/kdialog, WSL); folder browsing works from remote and headless browser sessions.
- [core] The Fleet Console Operations radar sweep animation now consumes far less CPU and pauses automatically while the browser tab is hidden.
- [core] The Fleet Console Operations Map now shows each panel's in-progress carrier job stream below the panel instead of above it.
- [core] Collapsing the Fleet Console Operations Map sidebar now hides the whole panel, leaving only a fixed expand control on the left edge.

### Fixed
- [core] The Fleet Console global navigation bar no longer overlaps the centered Theater selector with the toolbar at narrower window widths; the toolbar now progressively collapses its labels to icons and wraps onto a second row as the window shrinks, keeping the Theater selector centered.
- [core] Forgetting a Fleet Console Theater now always succeeds and removes it from the list, even when the Theater's directory was already deleted or the Theater was no longer registered, instead of failing with a "Not Found" error.

## [1.6.0] - 2026-06-16

### Added
- [core] Added a Fleet Console carrier settings page to edit each carrier's CLI, model, SubAgent mode, Task Force backends, and display name, committed with a single per-carrier save.
- [core] Fleet Console Operations now opens as a freeform terminal canvas for arranging live operation sessions.
- [core] The Fleet Console Operations canvas now has a dark deep-sea backdrop with an ambient radar sweep that operators can toggle on or off, remembered per browser.
- [core] Fleet Console Operations adds a Map/Helm view toggle to switch between the free-placement terminal canvas (Map) and the classic fixed-sidebar single-terminal layout (Helm), remembered per browser.
- [core] The Fleet Console Operations Map now floats each panel's in-progress carrier job stream above its terminal, with live stream-line previews that open the full carrier stream when selected.
- [core-unified-agent] Added explicit Claude Opus 4.7 [1M] and Opus 4.8 [1M] models to the Claude provider's selectable model list.
- [core] Fleet Console now offers a console-wide Operation quick-search via Cmd/Ctrl+K, searching across all Theaters and switching to the selected Operation's Theater and the Operations route, then zooming the Map canvas to that Operation's panel and focusing its terminal for input; the shortcut yields to Codex's own search when on the /codex path.
- [core] Fleet Console's global navigation bar now has a keyboard-shortcuts button that opens a reference map listing every console, Operations, and Codex shortcut with a short description of what each one does.
- [core] Fleet Console now syncs an Operation rename to its running Agent CLI by injecting a `/rename <name>` slash command into that session's terminal, reusing the same terminal prompt injection path as carrier completion reminders.
- [core] Persist Fleet Console theaters and operations across restarts and lazily resume dormant agent CLI sessions on open.

### Changed
- [core] Agent CLI sessions now append the Admiral system prompt to the CLI's native system prompt by default instead of replacing it; fleet-cli's System prompt option can still switch back to replace mode.
- [core] Fleet Console now isolates its runtime directory under the project's `.fleet/console` when run from source (pnpm/dev), instead of the OS temp directory; an explicit `FLEET_CONSOLE_DIR` still overrides it and published builds are unchanged.

## [1.5.5] - 2026-06-15

### Added
- [core] Fleet Console's Operations sidebar now lets operators choose which Agent CLI to launch — Claude, Claude Kimi, or Codex — when starting a new terminal session.
- [core] Fleet Console terminal sessions now deliver carrier job completion reminders to the originating session's Agent CLI, matching the existing fleet-cli behavior.
- [core] Fleet Console Operations can now expand a terminal to full width, hiding the Operations sidebar, and overlays the session's in-progress carrier jobs as compact one-line rows with live streaming status; each Operation remembers its expanded state across navigation and reloads.

### Changed
- [core] Fleet Console terminal sessions now launch Agent CLIs through the shared fleet-admiral runtime instead of spawning a fleet-cli wrapper.

### Removed
- [core][core-agent] Removed the `fleet --headless` flag and the Fleet Console fleet-cli registration channel; observation is now only through console-owned terminal sessions.
- [core-agent] Removed the shared CLI registration contracts from the public surface.

## [1.5.4] - 2026-06-14

### Fixed
- [core] Fleet Console's local shell overlay now keeps its running shell, scrollback, and working directory when closed and reopened, instead of starting a brand-new shell each time.

## [1.5.3] - 2026-06-14

### Added
- [core][core-agent] Fleet Console now shows an "Update available" badge in the global navigation bar when a newer console release has been published to npm.

### Changed
- [core] Fleet Console's local shell overlay now spans 80% of the console width instead of being capped at a fixed maximum, so it no longer looks narrow on wide displays.

## [1.5.2] - 2026-06-14

### Fixed
- [core] Fleet Console job overlay no longer clips its content on the right edge; long tool-call labels now truncate with an ellipsis and stay within the card.
- [core] Fixed Fleet Console terminal sessions failing to start on Windows when launched from an npm-installed stable package.
- [core] `fleet update` now stops a running Fleet Console before reinstalling, so the update no longer fails intermittently on Windows when the running console holds locks on files from the previous install.

## [1.5.1] - 2026-06-14

### Removed
- [core] The redline and frontline protocol modes no longer include a working-branch isolation readiness check before their workflow begins.

### Fixed
- [core] Fleet Console now reports its actual installed package version instead of always showing a placeholder development version.
- [core] Fleet Console no longer terminates a terminal session when its browser view disconnects; sessions now persist across operation switches and console-web closure, ending only on explicit close, the underlying process exiting, or server shutdown.

## [1.5.0] - 2026-06-14

### Added
- [core] Fleet Console now organizes Admiral sessions and Codex wiki context by Theater, a project root directory selected from the top bar; Operations lists only Admirals for the active Theater.
- [core] Fleet Console, a standalone fullstack control surface, ships as its own runtime package with navigable workspace and job rails, smooth incremental streaming of carrier output with reasoning folds and inline tool-call activity, job finalize summaries, and a raw event timeline.
- [core] Fleet Console now opens on a Theater readiness Bridge — surfacing the active Theater's command brief, operations readiness, and a capability matrix across registered Theaters — with carrier streaming on a dedicated Operations route reachable from top-bar navigation.
- [core] Fleet Console now shows a Carrier Readiness Matrix sourced from the fleet-carriers read-model.
- [core] The Fleet Console CLI gains `start`, `stop`, `restart`, and `status` subcommands for managing the local console server, a banner-style help consistent with the other Fleet CLIs, and a `pnpm fleet-console` root script; `fleet console` relays every subcommand to the standalone binary.
- [core] Fleet Console gains a free local shell terminal, opened as a centered overlay with Cmd/Ctrl+` or a top-bar shell action, that runs the operator's own login shell over the existing console terminal stack.
- [core][wiki-web] Fleet Console now owns the Codex/Fleet Wiki web surface under the shared Console GNB, with `fleet wiki` and `fleet-wiki` compatibility routed through the console package.
- [core] Added `fleet --native` boot option to run the selected Agent CLI in terminal-exclusive mode, passing keyboard, mouse, drag, and scroll events natively to the child CLI, skipping the bottom Fleet PTY, and injecting a mid-session reminder into the child session when carrier work completes.
- [core] Added `fleet --headless` flag to opt a session into registration with a running Fleet Console for live observation.
- [core] Fleet now runs Fleet Console as the local fullstack control surface, removes the global gateway daemon, and returns MCP connectivity to per-CLI in-process servers.
- [core-agent] Added shared CLI registration contracts and generic in-process MCP server primitives for Fleet runtimes.
- [core] Fleet Console's Operations sidebar now has a close control on each operation card that terminates the underlying session and removes it from the rail.

### Changed
- [core-unified-agent] Claude Code with Moonshot Kimi now runs the Kimi K2.7 coding model as the default, slot-mapped, and subagent model.
- [core] The Fleet Console server now binds to an OS-assigned random loopback port instead of a fixed one, and `fleet-console start` reopens an already-running healthy daemon in the browser without erroring or spawning a second server.
- [core] Fleet Console adopts the fleet-wide maritime visual identity — deep-water ink and brass/aurora accents, serif display type, glass surfaces, and codex motion — replacing its previous carbon-and-lime look.
- [core] Observability events now retain carrier output text in memory with a per-event retention cap instead of redacting it to length metadata, so the console can render live streams; exposure stays loopback-only.
- [core] Fleet Console registration is now opt-in: only fleet-cli sessions started with `--headless` register with the console; standard and `--native` runs no longer appear as console workspaces.
- [core] Fleet Console's Admirals sidebar now lists console-owned terminal sessions, each showing its carrier job history in registration order; selecting a job opens a centered streaming overlay over that session's terminal, keeping job management scoped to the active terminal session.
- [core] Fleet Console now ends a terminal session and removes it from the Admirals rail when its underlying process exits, instead of respawning it on reconnect.
- [core] Fleet Console's Admirals rail now lists in-progress carrier jobs above finished ones, marks completed jobs with a green status indicator, and labels each job with its carrier name and status instead of an update timestamp.
- [core] Fleet Console replaces the top-bar connection chip with a brand-mark alert — the console sigil turns red and a bottom-right toast surfaces only when the console link drops, both clearing automatically on reconnect.
- [core-agent] The generic MCP registry, routing, and tool snapshot primitives formerly in `@dotobokuri/core-mcp-server` are now owned by `@dotobokuri/core-agent`.
- [core] Renamed the Admiral protocol-mode skills to `protocol-baseline`, `protocol-midline`, `protocol-redline`, and `protocol-frontline`, and the auxiliary gap-audit skill to `assumption-audit`, dropping the redundant `fleet-` prefix from built-in skill identifiers.
- [core] Fleet Console's native folder picker now opens the modern Windows Explorer-style folder dialog (address bar, search, path paste) instead of the legacy folder-tree dialog on both native Windows and WSL, and under WSL it starts in the Linux filesystem so WSL folders are reachable from the navigation pane without typing the path.
- [core] Fleet Console browser payloads no longer expose raw working-directory paths; observer Theater and workspace rows now carry display labels only.
- [core] Fleet Console's Operations launch (+) control now adopts the Theater selector's glass-well instrument styling with a vector plus mark.

### Removed
- [wiki-web] Removed the standalone `fleet-wiki-ui` runtime package; Fleet Wiki browsing is now served by Fleet Console.
- [core][wiki-web] Removed the Korean/English language toggle from the Codex/Fleet Wiki web surface; the interface is now English-only.
- [core] Removed the browser token gate from Fleet Console; local loopback access no longer requires handed-off observer or terminal tokens, while CLI ingest authentication and the terminal origin check remain in force.
- [core] Removed the raw-CLI Native launch mode; dedicated CLIs now always launch with the Fleet persona injected.
- [core] Removed Fleet global shortcuts (Ctrl+C, Ctrl+Q, Ctrl+T) and the MIRROR/DEDICATED input mode toggle from both native and non-native sessions; Fleet exit is now handled through the launcher Exit action or child CLI termination.
- [core-agent] Removed the `@dotobokuri/core-mcp-server` workspace package; consumers should import generic MCP APIs from `@dotobokuri/core-agent` instead.

### Breaking Changes
- [core-agent] The `@dotobokuri/core-mcp-server` package is no longer published or resolvable; migrate imports to `@dotobokuri/core-agent`.

### Fixed
- [core] Claude Code on Windows now shows the terminal cursor and accepts Korean/CJK IME input correctly in the default (non-native) mode; previously the cursor was hidden and stray spaces were inserted while composing. Pass `--disable-cursor-sync` or set `FLEET_CURSOR_SYNC=0` to opt out on terminals where cursor projection still misbehaves.
- [core] Fleet Console now preserves active CLI sessions across local server health refreshes until an explicit restart.
- [core][wiki-web] Fixed Fleet Wiki web opening automatically in the browser when agent CLI sessions start.
- [core] Fleet Console's native folder picker now works under WSL by opening the Windows folder dialog through interop and translating the chosen Windows or WSL path back to a native Linux path.

## [1.4.0] - 2026-06-10

### Added
- [core] Protocol-mode skills now declare checkpoint boundaries and use a two-report cadence with normalized report tokens.
- [core] A protocol sync check now guards protocol mode drift, duplicated Downward Guard wording, and report-token grammar.
- [core] Admiral result integrity now requires artifact inspection before accepting mutating carrier job results.
- [core] Carrier job results now include best-effort workspace change manifests for inspection.
- [wiki] Wiki entry writes now automatically strip duplicate leading frontmatter from the body, and `wiki_drydock` detects this condition with an optional `fix` parameter for opt-in auto-cleanup.

### Changed
- [core] Admiral prompt policy now treats live carrier tool descriptions as the authority for carrier request mechanics.
- [core] Carrier rosters now show the optional prior-jobs context hint once instead of repeating it under every carrier.
- [core] Context Confidence planning thresholds now scale by protocol mode, with standard work requiring sufficient confidence.
- Consolidated duplicated helpers and resolved internal module import cycles across all workspace packages with no behavior change.
- Realigned the root structure map, developer reference documents, and bilingual READMEs with the current workspace layout and public APIs.
- [core-unified-agent] The package is now marked private to prevent accidental publication to npm.

### Fixed
- [wiki-web] The global `fleet-wiki` command now relaunches the repository-local build when invoked inside a monorepo checkout or git worktree, as originally intended.
- [wiki-web] Web client request-failure messages now follow the selected interface language instead of always appearing in Korean.
- [wiki-web] The wiki daemon health endpoint now reports the real package version instead of a hard-coded placeholder.
- [core-unified-agent] System prompts containing control characters are now fully escaped when serialized into the Codex TOML profile.

### Removed
- Removed dead code and unused public API surfaces across all workspace packages; no CLI, MCP tool, carrier, or stored-configuration contracts changed.

## [1.3.1] - 2026-06-07

### Fixed
- [core] Fixed the globally installed `fleet` command failing to launch with a module-not-found error, caused by renamed internal core packages being omitted from the published bundle.

## [1.3.0] - 2026-06-07

### Added
- [core] Fleet sessions now include an auxiliary Context Confidence path for resolving decision-shaped planning gaps before planning proceeds.
- [core] Dedicated Agent CLI sessions now render a project-local Fleet Project plugin from the working directory's `.fleet/` folder, activating its hooks, skills, agents, and MCP servers alongside the built-in Fleet plugin whenever that folder is present.
- [core] Dedicated Agent CLI sessions now render a user-global Fleet Global plugin from the home `~/.fleet/` folder, activating its hooks, skills, agents, and MCP servers across every project whenever that folder holds any of them.
- [core] The project-local and user-global Fleet plugins now expose skills, agents, hooks, and `.mcp.json` as symlinks instead of deep-copying them, so changes in `.fleet/` or `~/.fleet/` are reflected instantly without slowing session launch; broken links are skipped.
- [core] Dedicated Agent CLI sessions now ship built-in protocol-mode skills while the Admiral prompt selects modes through a small protocol gate.
- [core] Each protocol-mode skill now opens with a readiness checklist that confirms the mode's prerequisites before its workflow begins, scaled per mode from a light single-surface check up to multi-carrier ownership and dependency staging.
- [core] Each protocol-mode skill now follows a reporting cadence — plan, readiness checks, briefing, then execution start — so operators can follow how the Admiral runs each mode.

### Changed
- [core] Project-local Fleet Project plugins now render flat under `CWD/.fleet/plugin/` instead of a nested `marketplace/` directory, with both project and global plugin assets exposed as symlinks rather than deep copies; the built-in Fleet and user-global Fleet Global plugins remain in the home marketplace.
- [core] `fleet update` now prints situation-specific guidance instead of a single generic message: local development builds report that there is nothing to update; up-to-date installs skip reinstall with an already-on-the-latest-version notice; undetectable global installs, non-writable install locations, and unreachable registry checks each receive a distinct message before manual fallback instructions.
- Extracted generic agent execution into core-agent and renamed the unified-agent and MCP server workspaces to core packages with enforced core-to-Fleet dependency boundaries.
- [core] Dedicated Agent CLI sessions now use a single Fleet MCP server named fleet while preserving carrier and wiki tool IDs.
- [core] Dedicated Agent CLI launches now activate Fleet through a shared generated marketplace directory with provider-specific marketplace metadata and official Codex CLI plugin registration, while the carrier and wiki MCP servers stay injected directly at session launch instead of through the plugin bundle.
- [core] Fleet system prompt injection for dedicated Agent CLI sessions now occurs at CLI launch time through temporary prompt files and a dedicated Codex profile instead of session plugin hooks; session plugins continue to render skills and subagent definitions.
- [core] Claude-family dedicated sessions now inject live native-subagent guidance through a Fleet SessionStart hook while keeping subagent guidance out of the static Admiral system prompt.
- [core] Job Bar carrier names and Task Force backend rows now show the actual model and effort used for each dispatch.
- [core] The Fleet Codex plugin is now activated only within Fleet-launched Codex sessions via the per-session Codex profile, and is kept disabled in the global Codex configuration so ordinary Codex sessions are no longer affected; stale Fleet plugin entries from earlier marketplace names are disabled during registration.
- [core] The generated per-session Codex profile now stores the Fleet system prompt as a multi-line TOML string with real line breaks instead of a single escaped line, making the profile human-readable.

### Fixed
- [core] Fixed Windows `fleet update` only printing manual install instructions instead of running the automatic global npm or pnpm update; package manager shims are now resolved and invoked correctly on Windows, with manual instructions shown only when detection or installation fails.

### Removed
- [core] Admiral system prompts no longer inline per-tool guide blocks; tool-specific guidance remains available through Fleet MCP tool metadata.
- [core] Removed Codex role-file generation and direct prompt and inline agent injection from dedicated Agent CLI sessions.
- [core] Removed the fleet-usage skill from the Fleet plugin bundle, which now ships only the wiki-usage skill.

### Fixed
- [core][unified-agent] Codex carrier ACP child processes are now reliably terminated when Fleet CLI exits on POSIX—including terminal-close and fatal-error exits—so they no longer linger as orphaned processes.
- [core] Claude-family dedicated sessions on Windows no longer fail to launch with a SessionStart hook module-loading error; the Fleet native-subagent hook now runs through a shell-independent invocation.
- [core] Codex dedicated sessions on Windows now register and activate the Fleet plugin correctly instead of silently skipping activation.

## [1.2.0] - 2026-06-03

### Added
- [core] Job Bar backend rows now display per-backend elapsed execution time inline, using actual backend start and finish timestamps when available.

### Changed
- [core] Mission Control now uses a flat LAUNCH/OPTION/SYSTEM root with automatic global option persistence.
- [core] Mission Control now ignores legacy `presets.json`; operators may delete stale preset files manually after the global options rollout.
- [core] Unified menu and information row alignment across all Mission Control panels using shared block-level layout primitives; key:value rows are now colon-aligned within each group.
- [core] Job Bar token estimates now animate with a smooth frame-by-frame count-up instead of jumping to the final value.
- [core] Job Bar carrier strip tiles no longer render a per-backend progress indicator; activity is conveyed by the job-level status icon alone.
- [core] The active-job indicator in the Job Bar now blinks the filled `●` on and off instead of alternating between `●` and `○`.

### Breaking Changes
- [core] Fleet preset storage and the preset public API were removed in favor of global options.

## [1.1.3] - 2026-06-03

Release v1.1.3

## [1.1.2] - 2026-06-03

### Added
- [unified-agent] Cursor Agent provider now supports the Claude Opus 4.8 (thinking) model.
- [core] Job Bar job rows now show each job's elapsed execution time to the left of the token estimate, displaying seconds only under one minute and minutes plus seconds beyond.

### Changed
- [core] Native(SubAgent) mode carriers are now eligible for carrier_dispatch in addition to their native CLI path, while remaining mutually exclusive with Task Force.
- [core] Carrier Roster and Job Bar rows for Native(SubAgent) carriers now render in their respective CLI signature color instead of a dedicated SA color, while preserving the [SA] badge.
- [core] Job Bar token estimates now account for tool result output size in addition to streamed text and tool labels.

### Removed
- [core] Removed the per-carrier active job and track count badge ([N:M]) from Job Bar carrier strip tiles; live activity is still conveyed by the breathing carrier icon, and the [TF:N] and [SA] badges remain.

### Fixed
- [core] Carrier Roster and other Mission Control panels now keep the focused item visible when the terminal height is reduced; selected rows that would be clipped are scrolled into view automatically.

## [1.1.1] - 2026-06-02

### Changed
- [core] Mission Control now uses a launcher-root and action-list navigation model with zero domain hotkeys across root and nested panels.
- [core] Fleet gradient banner now animates with a right-to-left shimmer on inactive screens.
- [core] Inactive Mission Control UI is vertically centered when content is shorter than allocated rows, while active Agent CLI PTY output remains top-aligned.
- [core] Mission Control panels now share a consistent visual treatment with frame utilities, accent markers, and selected-row highlighting.
- [core] Conditional actions are omitted from menus when unavailable instead of shown as disabled rows.
- [core] Introduced a single durable-I/O primitive (`fs-store`) in `fleet-infra` that unifies atomic writes, advisory directory locks with quarantine-based stale recovery, and secure filesystem guards; preset, auth, and carriers storage now consume this primitive instead of maintaining independent implementations.
- [core] Auth storage is now protected with atomic writes, directory lock, and 0600 file permissions, matching the security level of preset storage and resolving the prior sensitivity inversion.
- [core] Auth service converted to a pure DI factory (`createAuthService({ authPath })`); module-level mutable singleton and `setAuthPath` removed.
- [core] Auth service is now wired through the Composition Root; all auth command paths receive an injected `AuthService` instead of creating one per call.
- [core] `fs-store` `sensitivity` field is now required on `CreateDurableJsonStoreDeps` to prevent accidental 0644 creation for sensitive data.
- [core] `carriers.json` write mode explicitly set to 0644 to reflect its non-sensitive status and align with the sensitivity model.

### Fixed
- [core] Fixed the host TUI leaving stale characters and rows on screen when the terminal is resized or split.

### Removed
- Removed the `@dotobokuri/fleet-infra/log` public subpath, runtime log store, carrier debug-log hooks, executor stderr log attachment, and Mission Control log viewer.

## [1.1.0] - 2026-06-01

### Added
- [core] Job-bar strip now shows an `[SA]` badge for carriers in Native(SubAgent) mode.
- [core] Restored the `claude-kimi` dedicated Agent CLI profile for Claude-family native subagent sessions.
- [core] Added per-carrier Native(SubAgent) toggles for Claude-family dedicated CLI sessions.
- [core] Added per-carrier Claude Native(SubAgent) effort defaults to startup agent payloads.
- [core] carrier_dispatch now rejects carriers in native subagent mode, returning an accepted:false response that instructs the host AI to invoke the carrier via its CLI's native subagent path instead.
- [core] Codex dedicated CLI hosts now support Native(SubAgent) mode, running a toggled carrier as a native Codex subagent with its own model and reasoning effort.

### Changed
- [core] TaskForce carrier job-bar labels, strip tiles, and header now render in the signature TaskForce blue while preserving per-backend row colors.
- [core] Enabling Native(SubAgent) mode and committing a TaskForce config are now mutually exclusive, with a warning surfaced when one would overwrite the other.
- [core] Carrier Status is now reached from Mission Control's `C` shortcut as Carrier Roster.
- [core] Moved default carrier persona settings into each persona module while preserving deterministic carrier registration order.
- [core] Claude-family Agent CLI native subagents injected via inline startup payloads now default to `background: true` and run as background tasks.

### Fixed
- [core] Enabled Agent CLI app-mouse drag forwarding while preserving existing Fleet scroll fallback behavior.

### Removed
- [core] Removed the `Alt+O` host shortcut for opening carrier configuration.
- [core] Removed legacy default persona registry exports and unused carrier config renderer hooks.
- [core] Removed the `claude-zai` dedicated Agent CLI profile from the upper-pane selection; the underlying auth and provider backend remain supported.
- [core] Removed the unused `@dotobokuri/fleet-infra/settings` package subpath along with dead settings.json persistence and adjacent log-injection code.

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
- [core][mcp-server] Extracted Fleet MCP server and tool registry internals into a leaf package (`@dotobokuri/core-mcp-server`) and hardened with 1MiB body caps, 5m timeouts, and snapshot cleanup while preserving fleet-admiral facade compatibility; see `MIGRATION.md` in the package for details.
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
