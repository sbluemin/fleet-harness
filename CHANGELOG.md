# Changelog

All notable changes to this project will be documented in this file.
This format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.81.0] - 2026-09-01

### fleet-console

#### Added
- A collapsed panel leaves a slim brass filament on the screen edge: hovering it peeks the panel over the canvas without moving anything, and clicking it (or the pin inside the peek) docks the panel back open.

#### Changed
- Session Analyst artifacts now share the Console's design language: pages sit on the panel ground with raised cards, quiet section kickers, the Console's own typefaces, a centered reading column, and a host component set that keeps every artifact consistent across all four themes.
- The Session Analyst chat now speaks the chat view's ledger grammar: process sentences stack as segments while one tool row updates in place during streaming, finished turns fold into one line with every step inside, and the confirmed answer stands alone under its own seam instead of merging with interim narration.
- The analyst composer now uses the chat view's assembly, with the input above a coordinates rail that stays after the first question, and the initial centered composer settles to the bottom when streaming starts, the same motion the chat view uses.
- The Cruise / Tactical / War Room mode switch now sits at the true center of the command band, falling back to the left cluster only when the window is too narrow to keep it centered.
- Session search moved to the center of the command band, right of the mode switch, and stays there on every view as the one global entry point.
- Collapsing the sidebar and the Activity Rail now belongs to each panel itself: a collapse control inside the panel folds it away, and the same Cmd+B / Cmd+Alt+B shortcuts keep toggling the same states.
- Repository controls rest on a visible fill-and-border body: primary verbs, inspector segments, view toggles, depth steppers, and row actions no longer appear as bare text until hover, and inputs float above the surface instead of sinking into darker wells.
- Repository panel bands unify on one surface: the identity cap, tabs, toolbars, tree column, and inspector shelf share a single subtle wash instead of mismatched darker stripes, while file status letters become tinted chips and ref badges soften into capsules. Selection keeps the familiar neutral wash with the side spine.
- Move every setting's description behind a '?' glyph beside its title: hover previews the help bubble, click or tap pins it for reading, and Esc or clicking outside closes it. State warnings, errors, and live readouts stay inline.

#### Fixed
- The effort track no longer leaves a brass sliver behind the knob at the lowest rung on surfaces without an auto slot, so the lowest setting reads as cleanly as the rest of the ladder.
- Long analyses no longer die at two minutes: the fixed 120-second response cap became an inactivity watchdog that rearms on every streamed event, so artifact authoring and other long turns keep running as long as they keep reporting.
- Evidence citations in analyst chat replies no longer surface as raw cite markup when the model uses the artifact citation form; they render as the same evidence chips everywhere.

#### Removed
- The Theater and Operation breadcrumb switcher left the command band center; the sidebar remains the single place for switching and renaming them.
- The two panel collapse buttons left the command band; the band keeps only identity, canvas mode, search, and system controls.
- Retire the sidebar card header and its inline operation filter: the Theater label, the Theater count, and the header new-Theater button are gone, and the list starts at the group/status switch. New Theater stays available from the row at the bottom of the list and from the command band.

## [1.80.0] - 2026-08-31

### fleet-console

#### Added
- Chat view sessions can now publish Artifacts, and the composer deck lists the artifact skills alongside the rest.
- Launch a Claude Operation straight into the chat view from the right-click menu. Each model row carries a start-surface mark you can click, or reach with the Left arrow, and the menu remembers the surface for the next time it opens. Rows whose launch kind cannot start a chat carry no mark, and the menu keeps its own choice rather than following Quick Launch.

#### Changed
- Session Analyst artifacts now render on the Console theme with a typographic base, so headings, tables, code, and evidence citations read as part of the product instead of an unstyled page.
- Chat message box now matches the reading width you chose, and a new control in the composer row widens it to the whole panel.
- Remember Activity Rail panel width per tool, so widening one panel no longer widens every other panel, and a tool you have never resized keeps opening at the width its own panel declares.
- Open Settings wide enough for its theme grid to stand in two columns by default.

#### Fixed
- Downloading an artifact saves a standalone document that keeps its theme and styling; copying still yields the analyst's original source.
- Let slow Windows starts reach readiness and clean up failed startup processes without leaving a background Console behind.
- Reset only the active panel's width when you double-click the rail resize handle, leaving every other tool's remembered width in place.
- Mark the active Theater in the sidebar with a brass spine, a filled initial badge, and a brighter name, so hovering another Theater no longer looks more active than the one you are working in.

## [1.79.0] - 2026-08-30

### fleet-cli

#### Added
- Use OpenAI native compaction for Codex gateway models in Claude Code, including automatic and manual compaction, durable resume, and a safe plaintext fallback.

#### Changed
- `fleet` now launches Claude Code in auto mode, with the permission gate up. Turn on "Skip permission prompts" in Fleet Console Settings, under Harness, to launch without the gate as before.

### fleet-console

#### Added
- Use OpenAI native compaction for Codex gateway Operations in Claude Code, including automatic and manual compaction, durable resume, and a safe plaintext fallback.
- Give the sidebar a self-contained card header with a Theater count, a new-Theater action, and an inline operation title filter.
- A Harness section in Settings gathers how agents are launched: a Claude Code card holding the permission opt-in and the system prompt switch, shared agent session settings, and the agent CLI executable list.
- "Skip permission prompts" is a new opt-in that is off by default. While it is off, the session runs in Claude Code auto mode: the permission gate stays up, its classifier answers most approvals, asks in the terminal when it needs confirmation, and blocks what it cannot judge. The card states where the choice applies: the terminal and the `fleet` launcher, never Chat, which has no approval screen of its own and always runs bypassed.

#### Changed
- Expand the operations chart to the full viewport in Cruise, Tactical, and War Room, with the sidebar and Activity Rail floating over it as glass cards and every mode layout, fit, launch, and minimap computed against the unobscured arena.
- Unify the command band into one continuous plate: the sidebar cap seam is retired and the Cruise, Tactical, and War Room switch joins the left cluster at a fixed position.
- Host one panel at a time on the Activity Rail card: opening another panel replaces the current one, panel opening no longer pushes the chart, and the push and overlay duality is retired in favor of the floating card.
- New Claude Code sessions no longer skip the permission gate by default; they open in auto mode instead. Turn the opt-in on under Settings, Harness to get the previous behavior back.
- The Terminal settings section now holds only what it draws: terminal font, chat reading width, and rendering. The Claude Code system prompt and idle agent session settings moved to Harness, and the agent CLI executable list moved there from AI Gateway.
- The File Explorer viewer now stands as its own rail column, with a host caption that names the open document and carries history, reload, wrap and expand.
- Rail columns share one divider: drag or arrow-key the boundary between a list and its document, and each surface remembers where you left it.
- The Codex document stands as its own rail column, with history and expand on its caption.
- The Repository rail icon now opens the workbench on the canvas the way Shell does, with the same two-column layout and far more room. Press it again to put it away.
- Settings moved from a dedicated page into a Settings pane behind the Activity Rail gear: sections stand as wrapped chips, search still covers every setting and now reaches the command palette, dense management faces such as remote access open on the expanded surface, and the console stays visible beside every appearance control.
- The rail gear menu is dismantled: float and opacity live in the Appearance section, and a double-click on the panel divider resets a remembered panel width.
- The rail panel opacity control moved into the Theme card as "Right sidebar opacity", standing right below the unfocused panel fade; the dedicated Rail panels card is retired.

#### Fixed
- With liquid glass on, the left sidebar no longer shows a faint mosaic of false gridlines: its soft glass blur left too much of the chart weave behind it, and the residue posterized on the dark tint. The card now uses the same strong blur as the right sidebar panels, keeping the glass material clean.

#### Removed
- The dedicated desktop Settings page, its appearance preview mock, and the command band Settings button are retired; old /settings links land on the new pane, and the phone keeps its settings screens.

## [1.78.0] - 2026-08-30

### fleet-console

#### Changed
- Activity Rail settings now live behind a gear at the top of the icon column, split from the panel tabs by a divider, and open as a menu holding float over Map, panel opacity, reset panel width, and close panel.
- Let full-screen terminal applications own scrolling while they use the alternate screen, reclaim scrollbar and sub-cell grid space, and restore normal terminal history when they exit.
- Let Agent Operations and the global Shell use the full terminal body without an inset gutter.
- Advertise 24-bit color support to programs running in Shell and Agent terminals while retaining compatible terminal metadata, and let dark Liquid Glass terminal panels reveal the canvas through a smoked translucent surface.

#### Fixed
- Keep the Session Analyst panel at full strength while its session holds focus, so the panel you just opened no longer fades along with the neighboring panels.
- Keep the What's New language picker scoped to release notes without overriding the Console display language.
- Preserve the global Shell session and terminal contents when its sidebar surface is closed and reopened.

#### Removed
- The rail panel no longer summons a header when the pointer crosses the top of its body, so panel controls on the first row stay reachable and the body keeps the full slot.

## [1.77.1] - 2026-08-29

### fleet-console

#### Fixed
- Load Codex again in installed builds. The Codex panel reported that it could not read a Theater's Fleet Wiki data, because the plugin's server routes were left out of the packaged build when Codex moved out of the console core.
- Hide the terminal's provider title from browser payloads in installed builds, which had kept it visible because a plugin's redaction list did not survive packaging.

## [1.77.0] - 2026-08-29

### fleet-console

#### Added
- Chat Mode composer opens a capability deck: `/` lists the session's commands and skills, `@` lists its subagents, each row carrying the description and argument hint the session itself reports. Category headers stay pinned while the list scrolls, arrow keys move across categories, and choosing a row completes your input rather than sending it. A name you have finished typing is highlighted once it matches something the session can actually run.
- The deck stands up four commands, chosen because this surface can carry them end to end: `/clear`, `/compact`, `/context`, and `/reload-skills`. Everything else the agent advertises is built for a terminal that has a prompt bar, a model picker, and a session title this surface does not.
- A command runs as its own line in the transcript instead of as a conversation turn. There is no thinking node, no elapsed clock, and no streaming text, because two of these never reach the model at all. `/compact` carries a gauge: it sweeps while the agent is compacting, because the agent reports no progress figure, and then fills to the share of context actually reclaimed, with the before and after in the numbers the agent itself measured.
- `/clear` asks once, then empties the chat view along with the agent's memory. A conversation the agent cannot read is not a record you can trust, so both sides forget the same thing.
- `/context` opens the context meter that already reads the same numbers, instead of asking the agent to print them.
- Terminal settings now carry a CJK fallback font, so Korean, Japanese and Chinese text in terminal panels and the chat view is drawn by a font you choose whenever the terminal typeface has no glyph for it. The list offers only installed fonts that actually draw CJK and labels each one with the scripts it covers, and Console keeps using its bundled Korean face when you pick nothing.
- Set each Quaker aide's size from Settings, with a slider that previews the aide on screen while you drag and a one-click return to the standard size.
- Open documents and terminals side by side on an expanded work surface over the canvas, splitting it into as many vertical slots as you need and dragging the dividers to give each one the width it deserves.
- Let plugins contribute their own expanded surfaces, so any plugin can present a full-size work surface instead of only a rail panel.

#### Changed
- Typing a full command name now puts that command first in the deck. Previously another row whose description happened to mention the same word could sit above it.
- Chat view now follows your Terminal Font for everything except markdown-rendered answers, so switching an Operation between the CLI view and the chat view keeps one typeface.
- Keep multi-panel terminal input responsive by avoiding hidden peer refits during focus-layer changes and reducing compositor work at high panel density across Cruise, Tactical, and War Room.
- The light theme no longer uses liquid glass. On paper there is no light behind the glass to bend, so floating menus, panels and console chrome return to their solid material, and the Liquid glass switch in Settings reads off and cannot be changed while the light theme is active. Your choice is kept for the dark themes and comes back when you return to one.
- Aides now roam by their own size: screen edges, the deck they walk on, how far they keep from each other, and the row they park in when motion is reduced all follow each aide's figure instead of one fixed measurement.
- Selected controls across all four themes now speak quietly: segmented switches drop their boxes and mark the active option with a sliding low-contrast wash, ink contrast, and a tiny brass underline, independent chips such as effort levels keep a soft tint, and boolean toggles mark "on" with the wash plus a brass glyph, replacing the loud brass outline pill everywhere; forced-colors mode renders selection with system selection colors.
- Open Shell as one console-wide terminal on the expanded surface rather than as a separate Operation per Theater, so it no longer takes a canvas panel, a caption, a sidebar row, or a War Room card. Shell starts in the Theater that was active when you opened it and stays there until you close it.
- Press the rail Shell icon again to put the Shell away, and see that icon lit while the Shell is showing. Putting it away is not ending it: the session and its working directory wait where you left them, so pressing once more lands you back in the same place.
- Move Codex out of the Console's core and into a plugin of its own, so the knowledge surface is installed and updated like every other panel rather than being welded into the Console itself.
- Keep the War Room Map still after its entry sequence instead of repeating a vertical scan line.

#### Fixed
- Restore the streaming wave in the light theme, where the chat and analyst live lines read as static because the sweep lost almost half its contrast against pale paper.
- Restore the streaming wave on the chat "Thinking" line, which was painted over by opaque ink in every theme.
- Skills bundled with the agent, such as `/doctor` and `/batch`, were listed under Commands until the session had run a turn. They now appear under Skills from the first `/`.
- Reloading skills mid-session left the deck showing the old list until the session was reopened.
- Korean text in the chat log and in terminal panels now renders in a bundled monospace face instead of dropping to a system fallback, so Hangul no longer sits at a different weight and width from the Latin text beside it.
- Keep the Console answering requests while a chat view starts, instead of freezing every session behind a repeated Claude binary lookup.
- Keep the Codex outline on the section you are actually reading, including the last one when you scroll a document to its end.
- Keep long File Explorer lists filled while scrolling in tall panels.
- Stop War Room from casting a dark vignette over the panel it raises onto the stage, so a staged panel reads at full contrast to its corners.

#### Removed
- Retire the saved Shell panels that reopened dormant after a restart, along with their Relaunch card. A Shell now lives only as long as the console it runs in.

## [1.76.1] - 2026-08-28

### fleet-console

#### Fixed
- Keep the Alt+Arrow panel shortcuts working while a chat composer holds focus, so moving between panels no longer dies exactly where the caret lives.
- Title a chat background job from the tool call that started it, so non-ASCII titles no longer arrive garbled on Windows.
- Codex expanded reading now keeps the document title block and the body on one shared center axis, in every reading width and with or without the related-entry rail.

## [1.76.0] - 2026-08-26

### fleet-console

#### Added
- Codex reading at full size now keeps a head bar that names the document you are reading, shows how far into it you are, and carries Find, Copy link, Source and reading width beside the close button. Cmd+K opens an entry switcher inside the reading surface, so you can search the catalog and move to the next document without leaving full size, and a tag in the document opens that same switcher already filtered.
- The document you are reading now lives in the address bar, so a reload comes back to the same document at the same place and in the same view, the browser's back and forward walk the documents you moved through, and Copy link hands someone else exactly what you are looking at.
- Full-size reading is now keyboard-first: the document body takes focus when it opens, so Space, PageDown, Home and End move through it, J and K jump between sections, Cmd+[ and Cmd+] walk reader history, and Cmd+F finds inside the document instead of across the whole page.
- Reading width and size can be set to narrow, wide or large, the full markdown source can be read and copied, and on a wide screen related entries and backlinks move beside the text instead of waiting at the end of it.
- Search File Explorer by ranked file names or literal file contents, with highlighted path and line matches and direct navigation to matching source lines.
- Usage limits cards now collapse one at a time. A chevron in each card header folds that provider to a single row, and the row keeps reporting: the percentage of its most pressed window, a bar in the same severity colour the full meter uses, and the countdown to its reset. A provider that is collapsed while in trouble also carries a coloured rim, so a folded card is a density change rather than a blind spot. Cards with nothing to report say why instead - "Not connected", "No plan". Which cards are folded is remembered across restarts, next to the card order.

#### Changed
- Codex keeps up with the wiki on its own. A draft staged by an agent, an approval made elsewhere, or an entry that just landed now reaches the catalog, the review-queue count and the status chip within a moment, instead of waiting for a page refresh. A document you are reading is never swapped out from under you - it says it changed and waits for you, and says so differently when the proposal you were reading has already been decided somewhere else. The status chip carries when Codex last checked and whether it is watching or falling back to periodic checks.
- Show where keyboard focus went on the Map. The panels you are not working in now fade back while one panel holds focus, that panel sits one step above the board, and a brass ring runs around it once at the moment focus arrives - so an arrow-key move reads on the panels themselves instead of only in the sidebar. Settings -> Appearance carries a slider for how far the other panels fade, from off to strong. Captions keep the look they always had, a faded panel keeps its status rail and stays readable, and the ring is skipped entirely when the system asks for reduced motion.

#### Fixed
- The table of contents no longer freezes on the first section when you open a document at full size. Moving the reader between the split pane and full size re-anchors the scroll spy, so the current section keeps following what you are reading.
- Reader history keeps your place. Following a link out of a long document and pressing back returns to the line you left, instead of dropping you at the top, and a reload restores the same scroll position as well.
- The console preview in Settings -> Appearance now runs the full height of the theme controls beside it, instead of sitting as a small box pinned to the top of its column with a third of that column empty. The preview terminal fills the taller frame and the floating menu stays over its output, so liquid glass still reads as glass.

## [1.75.0] - 2026-08-26

### fleet-console

#### Changed
- Make Liquid Glass legible on the light theme. The glass now carries color, a shadowed lower bevel, and a contact shadow, and the canvas behind it gained the same chroma budget the dark themes already used, so turning the setting on and off is a visible change instead of a 2 percent shift in brightness.
- Let the settings page scroll behind the command band so the glass has something to refract.
- Give the Maritime and Carbon dark themes their own Map ground across Cruise, Tactical, and War Room, instead of the single Instrument-shaped field all three dark themes shared. Maritime reads as a chart table with a teal graticule, depth contours, and one warm lamp; Carbon reads as a machined graphite deck with an achromatic lattice, planar light, and a single copper bevel. Instrument keeps its existing Map exactly.
- Group Settings by what each section does rather than which plugin owns it, and add a search box that finds any setting by name or by a related word such as "dormant" or "pairing".
- Show all four themes as cards at once, including in the light theme, and preview the console beside them so a theme, liquid glass, and the interface font size can be judged where they are chosen.
- Say on/off with one switch and either/or with one segmented control everywhere in Settings, and replace the repeated "stored server-side" sentences with a chip on each row that states when the setting takes effect.
- Let every Theater sidebar section expand or collapse without first switching the active Theater.

#### Fixed
- Give the environment popover in the command band the same glass surface as the menu beside it.
- Keep remote control disconnected after the host takes it back or another device connects, until the remote user explicitly reconnects.
- Correct the Console port and display language rows, which shared one note claiming changes apply to new sessions even though the language repaints the Console at once and the port waits for a console restart.
- Keep the Settings section list readable below 1120px, where it previously reflowed into a ragged grid that buried its group headings among the sections.
- Keep dimmed terminal output on the glass surface in the dark themes, so diff gutters and faded lines no longer print as solid black blocks.

## [1.74.0] - 2026-08-24

### fleet-console

#### Changed
- Join each completed Chat turn's work summary directly to its final answer, while keeping the process expandable in place.
- Codex reading surfaces now scale document typography to the pane they actually occupy, start with a one-line outline spine that mirrors the current section, and fold long tag rows, so an entry opened in the split pane starts with its body visible instead of a full-screen preamble.
- The Codex AI composer dock moved from floating over the document to a fixed row at the reading frame boundary, so it no longer covers the paragraph being read, and its annotation counter appears only when annotations exist.
- Codex catalog rows read denser: the repeated current status label is gone, the update time sits right-aligned on the title row, exceptional states (draft, deprecated, stale) surface as badges, and tags stay on one line with a +N marker.
- Tag chips in a Codex entry header are now buttons that filter the catalog by that tag, and the header timestamp uses the same relative time as the catalog with the absolute date in its tooltip.
- Unify hover, focus, selection, disabled, and form control feedback across Console chrome, settings, and built-in file and repository tools, with keyboard navigation and an undimmed current row in the Host picker.
- Improve Glass caption legibility and keep the Command Band visually seamless when routes or the sidebar change.
- Operation rows in the Cmd+K search palette now show the same activity status mark as the sidebar (including the unseen-completion signal) instead of a provider glyph and a text badge, and the launch provider moved into the row's meta caption.

#### Fixed
- Liquid glass no longer sinks the terminal into the canvas on the dark themes: the reading field rises back above the sidebar and rail, the pane carries a light of its own, and terminal black stays darker than the field it is drawn on.

## [1.73.1] - 2026-08-24

### fleet-console

#### Fixed
- Terminal and agent panel text reads crisply again in the light theme. The terminal now takes its transparent drawing path only when its field is genuinely translucent, so an opaque light field keeps the full stroke weight it had before the liquid glass material arrived.

## [1.73.0] - 2026-08-23

### fleet-cli

#### Changed
- Claude Code passthrough sessions share one Fleet plugin tree under the Fleet data directory, receive its Fleet Harness version at session start, and load that same version from the plugin manifest.
- The old shared `marketplace/` plugin tree is no longer written, and Fleet reclaims what it left there once no older `fleet` release has rendered into it for a week.

### fleet-console

#### Added
- Arm the Chat panel composer on a recognized `ultracode` word the same way the Quick Launch bar does: the word glows on an apex wave, the frame takes an apex border and glow, a notice line explains the mark, and a bare Backspace right after the word hides it for that draft.
- Codex reading deck: expanding a wiki document now anchors it over the canvas as a non-modal work surface with a left outline, a reading-width column, and the catalog kept alive in the rail.
- Codex drydock review now shows a rendered diff against the current document with a changes-only toggle, and queue rows carry the proposer and a line diffstat.
- Codex drydock queue gained a decided-history segment, so approved and rejected patches stay reviewable after the decision.
- Codex wiki links now open a hover preview card, and each document lists the entries that reference it as backlinks.
- Give floating menus, popups, and the console chrome a liquid glass material on every theme - translucent, blurred surfaces that reveal the canvas beneath.
- Add a "Liquid glass" checkbox to Settings - Theme, on by default; unchecking it restores the classic solid look everywhere at once.
- Introduce the new material once after release notes close, with a one-time welcome card that shows the finish and how to turn it off.

#### Changed
- Give the Session Analyst the Chat ledger's streaming grammar: a finished turn now folds into the single sentence that already carried its outcome instead of repeating the same duration as both a heading and a pill, and the working clock and live activity line ripple the way the Chat log does. The latest-activity pulse and the artifact cards are unchanged.
- Make Chat Mode easier to start, control, and follow with a focused first-turn composer, a quieter control row where stop and the context meter stand as glyphs and Esc stops the running turn, queued instructions listed by their own text with a cancel on each, keyboard-resizable background work, accessible answer notices, and new-turn counts while reading earlier messages.
- Keep the Chat Mode conversation readable while a turn runs: tool calls fold into a single progress line that ripples while it works and unfolds on click, a background job stays as one anchor line where it started instead of a card that reordered the turn, and the running-jobs indicator sits as a glyph in the composer tool row, next to the attach button, opening the work pane on click.
- Make the streaming Chat Mode ledger scannable: the model's sentences now stand at full reading brightness so prose no longer blends into the folded tool line, every tally clause leads with its tool-family mark, and the working clock carries the same progress ripple as the live line.
- Codex patch approval controls moved into a sticky decision dock at the top of the review, so the evidence and the decision stay on one screen.
- Codex navigator condensed its health sentence into an always-visible status chip with a conflict-count badge, and groups entries by freshness with drafts and retired entries set apart.
- Codex conflict detail now renders a block comparison of the current and proposed texts instead of two stacked full copies.
- File explorer folders now show a rotating expand chevron with indent guides, and the selected row carries a brass spine so selection reads apart from hover.
- The file tree sort control opens a menu listing all sort orders with the current one checked, header controls grew to comfortable hit targets, and "/" focuses the filter box.
- The file viewer header is now a breadcrumb: click a segment to copy the path up to it, double-click a folder segment to reveal it in the tree, and chips for same-named open files show a parent-folder hint.
- The image viewer gained a Fit/100% zoom toggle and a meta bar stating dimensions, file size, and the actual display scale, keeping upscaled pixels crisp.
- A new Operation now opens its Claude session under the Operation's own id, so its resume coordinate is known the moment it is created instead of after the first turn reports back.
- A Chat session that cannot load its Fleet plugin now refuses the turn with a visible error instead of quietly running without skills, identities, and the delegation guard.
- Claude sessions share one Fleet plugin tree under the Fleet data directory, receive its Fleet Harness version at session start, and load that same version from the plugin manifest.
- Unify Claude Code operation launch and resume metadata under one durable session identity, with automatic migration and a one-time v3 state backup.
- The Repository panel now folds the commit inspector into a one-line peek chip when you switch to the Changes view, so staging gets its full height back and one click returns you to the commit you were reading.
- Opening a stash now shows a dedicated card with the stashed files - untracked ones included - and Apply, Apply-and-remove, and Delete right on the card, and the Stash button asks for an optional message before saving.
- The staging file list gained the same list/tree toggle as the commit inspector, and row actions now spell out Stage, Unstage, Discard, or Delete on hover instead of showing bare glyphs.

#### Fixed
- Every provider mark now carries its own supplier color: the xAI and OpenCode chips in AI Gateway settings no longer lose their frame and fall to grey, Kimi is painted in the same tone the Quota panel uses, and the Quota panel colors its xAI mark too.
- Show a Chat Mode turn as working while it streams when the view attaches after the turn already began, as a Quick Launch session does. Its opening frame now arrives live instead of inside the replayed history, so the turn no longer appears finished with a "worked on this" fold while the answer is still streaming in.
- Codex search excerpts no longer start mid-word and collapse line breaks into single spaces.
- Order usage meters by severity in the light theme, so a routine bar no longer reads heavier than a bar that has run out.
- Lighten the reasoning-effort handle and its filled track in the light theme, so a setting no longer outweighs everything else on the page.
- Restore the ring around the reasoning-effort handle at ULTRACODE and MAX in the light theme.
- Calm the gated ULTRACODE and MAX track in the light theme by dropping its metallic grain and drift.
- Chat Mode and the terminal now receive one session definition instead of assembling their own, so the same Operation no longer gains different skills or setting layers depending on which surface opened it.
- Stashing or pulling from the toolbar now refreshes the staging list immediately, so the list no longer disagrees with the sidebar counts until a manual reload.

#### Removed
- Drop the "earlier turns replayed" notice from Chat Mode. Reopening, reconnecting, or moving a session between the terminal and chat rebuilds the conversation silently, so a freshly launched session no longer claims it replayed earlier turns that were really its own. The restored conversation still appears; only the misleading banner is gone.

## [1.72.0] - 2026-08-22

### fleet-cli

#### Added
- Route Claude Code turns through an Antigravity subscription, using the sign-in the `agy` CLI already owns; Gemini 3.7 Flash and Gemini 3.1 Pro are selectable once enabled in AI Gateway settings.
- Configure the AI Gateway from the terminal: `fleet gateway` opens an interactive screen for models, providers, spend priority, and policy, and `fleet gateway status`, `models`, and `set` report or change the same settings without prompts.
- Serve the AI Gateway on its own port with `fleet gateway serve`, so a client that speaks the Anthropic API can ride your subscriptions through `ANTHROPIC_BASE_URL`. It binds to loopback only and carries no authentication.

#### Changed
- Group `fleet --help` into runtimes, their commands, settings, and maintenance. Each runtime lists its commands on one line and hands the detail to `fleet <runtime> --help`, and the new settings section names the files and environment variables that hold your configuration.
- Move provider authentication under the gateway as `fleet gateway auth`. The old `fleet auth` spelling still works and says where it went.
- Stop forwarding Claude Code's own identity line and Anthropic billing header to non-Anthropic AI Gateway providers, so a Gemini, Grok, GPT, Kimi or MiniMax turn is no longer told it is Claude Code. Turns served by Anthropic itself are unaffected.

### fleet-console

#### Added
- Route Claude Code turns through an Antigravity subscription, using the sign-in the `agy` CLI already owns; Gemini 3.7 Flash and Gemini 3.1 Pro are selectable once enabled in AI Gateway settings.
- Show Antigravity usage in the Quota panel, with the 5-hour and weekly Gemini limits the subscription meters.

#### Changed
- Stop forwarding Claude Code's own identity line and Anthropic billing header to non-Anthropic AI Gateway providers, so a Gemini, Grok, GPT, Kimi or MiniMax turn is no longer told it is Claude Code. Turns served by Anthropic itself are unaffected.

## [1.71.1] - 2026-08-22

### fleet-cli

#### Fixed
- Read a Cursor Fast variant at its base model's grade and benchmark evidence when picking delegation candidates, so a flagship's priority tier is no longer passed over as a light model.

### fleet-console

#### Added
- The source tree carries a reload control that re-reads local repository state, working tree, stashes, refs, and ahead/behind, without contacting the remote.
- Cut-off reads say so: a capped status list, a commit whose read was cut off, and a scan that hit its depth limit each carry a visible mark instead of looking complete.

#### Changed
- The repository panel names its remote verb after what it does: the toolbar reads Fetch, its result speaks about the remote it actually fetched, and the tooltip drops raw git flags.
- Destructive verbs say what they destroy: deleting an untracked file is named apart from discarding tracked changes, and dropping a stash asks about deletion instead of a bare "Sure?".

#### Fixed
- Correct the AI Gateway model grades in Settings: a Cursor Fast variant now carries its base model's grade instead of LIGHT, and Composer 2.5 reads as STANDARD on both Cursor and xAI instead of contradicting itself across providers.
- Failed repository reads explain themselves. History, commit, diff, and compare failures now show a sentence and a next step instead of a raw error code.
- A repository whose state could not be read no longer looks clean: write verbs stay locked and say why, instead of turning on as if there were no merge, rebase, or index lock in progress.
- The changes view stays usable in a narrow rail: the file list and diff stack instead of crushing filenames to zero width, the diff header keeps its close button in reach, and the commit button no longer collapses into a column of characters.
- Added and deleted diff lines keep their signal colors in every theme instead of drifting toward yellow-green and amber.

## [1.71.0] - 2026-08-21

### fleet-cli

#### Added
- Add on-demand Professional Pushback and orchestration skills without restoring a Fleet system prompt.
- Offer the OpenCode Go models Ox-Alpha-Free and Muse-Spark-1.2-Contributor, each with the reasoning-effort rungs its backend accepts.

#### Fixed
- Let a long-running turn finish instead of cutting it off while the model is still working. The gateway now waits as long as the client itself does, so a turn that goes quiet during a lengthy answer is no longer ended early.
- Recover a gateway turn that a provider drops or refuses, instead of ending it on the first attempt. Transient failures now reach Claude Code as statuses its own retry budget acts on, so an interruption that one more attempt would clear no longer surfaces as an API error.
- Cap how many upstream connections the launcher holds per provider, so a wide fan-out queues instead of opening a connection per agent and losing streams to the pressure.
- Record every failed gateway turn to a durable log, so an interruption that used to vanish after one on-screen notice can be diagnosed afterwards.

#### Breaking Changes
- Every `Workflow` stage must name a gateway model again. A stage that pins none is refused before the run instead of falling back to the session model, and `agentType` is refused in a script rather than accepted as a stage's other pin. Delegation is judged from the call payload alone: no roster lookup has to land first, so naming a `fleet:*` identity is enough to dispatch.

### fleet-console

#### Added
- Add on-demand Professional Pushback and orchestration skills to gateway Operations without restoring a Fleet system prompt.
- Offer the OpenCode Go models Ox-Alpha-Free and Muse-Spark-1.2-Contributor, each with the reasoning-effort rungs its backend accepts.

#### Changed
- Keep delegation one level deep: an agent you delegate to can no longer spawn agents of its own.
- Find files from the Files panel with one search that skips dependency and build folders, instead of opening folder after folder until it gives up. A file six levels deep now answers in milliseconds, path fragments such as `deep/needle` match, and Escape clears the filter instead of closing the document you were reading.
- Mark an open document that changed on disk and reload it on your click, so an agent editing the file no longer leaves you reading a stale copy without saying so.
- Show a large file as soon as you open it by drawing only the lines on screen, and say plainly how much of the file the preview holds. Long lines can now be wrapped instead of scrolling sideways for hundreds of screens.
- Roll uncommitted changes up the folders that contain them, so the working set is visible at the root instead of only after expanding to the file.
- Size the panel from the window when a document opens, and mark how many open files the strip is hiding, keeping the active one in view.
- Reach the file tree by keyboard the way a tree is expected to work: type-ahead jumps, PageUp/PageDown, and Shift+F10 or the Context Menu key opening the row menu that every row already advertised.
- Ledger groups spend by backend, so you can see which provider the money went to before opening a single model row.
- Show a Shell operation as its own kind glyph instead of an activity status mark, since a shell never reports a running or awaiting turn. The sidebar chip, command band, mobile list, and War Room map dot all drop the glow for shells, and status sections still list them where they were.
- Installed skill cards say what a skill does. The card carries the skill's own description, the agent list collapses to a count, and a project skill that hides a global one of the same name is marked as such.
- The scope-wide update moves off every card into one action above the list, labeled with how many skills it will touch, and Remove is now a word instead of a bare glyph.
- The installed filter matches a skill's description, so a word that appears only there still finds the skill.

#### Fixed
- Let a long-running turn finish instead of cutting it off while the model is still working. The gateway now waits as long as the client itself does, so a turn that goes quiet during a lengthy answer is no longer ended early.
- Recover a gateway turn that a provider drops or refuses, instead of ending it on the first attempt. Transient failures now reach Claude Code as statuses its own retry budget acts on, so an interruption that one more attempt would clear no longer surfaces as an API error.
- Cap how many upstream connections a single Console holds per provider, so a wide fan-out queues instead of opening a connection per agent and losing streams to the pressure.
- Record every failed gateway turn to a durable log, so an interruption that used to vanish after one on-screen notice can be diagnosed afterwards.
- Keep every folder you left open actually open after a reload, instead of restoring only the first few and drawing the rest as open but empty.
- Cut a long listing at the alphabetical boundary the cap message describes, so the entries it drops are the ones after the limit rather than a scattered sample from the middle.
- Keep a folder that fails to open expanded with the reason and a retry, instead of silently collapsing it, and say when live updates are limited in this Theater.
- Report a running turn's token count for gateway models whose provider withholds usage until the turn ends, instead of showing zero for the whole run.
- Deliver the whole multi-line Quick Launch prompt on Windows installs that run the agent CLI through a `.cmd` shim, instead of only its first line.
- Ledger daily bars open that day's models in every window, not only Today, and a day with nothing to show is no longer drawn as a button that does nothing.
- Ledger states in dollars when the total holds spend the daily chart cannot place on a day, instead of leaving the two silently disagreeing.
- Installed skills show which registry they came from again. The panel could only read an older skills lock file layout, so every skill was reported as having no source.

## [1.70.0] - 2026-08-20

### fleet-cli

#### Added
- Replay Grok's own prior reasoning across a tool round-trip, so the model no longer re-derives thinking it already did. Measured against xAI's wire, the following turn spends about half the reasoning tokens.

#### Changed
- A workflow stage no longer has to name a gateway model. Stages that name none run on the session's own model, and a stage may pin an identity through `agentType` again; only a model value that would kill the run at dispatch is still refused. Naming a gateway identity remains required for `Agent` delegation.
- Send Grok turns to the endpoint the official Grok CLI uses. It is the pool an xAI subscription is built around, and it holds a steadier worst case than xAI's shared API, which refuses a turn outright when it is full.
- Tell that endpoint the version of the Grok CLI actually installed on this machine, read from the installation itself. The gateway used to claim a version fixed in its own source, which only ages as that endpoint raises the version it accepts.

#### Fixed
- Codex turns now reuse the prompt cache instead of paying for the whole conversation again. The gateway sent no session identity, so OpenAI routed each turn to a different machine and only about 4 in 10 turns found their own cached prefix; naming the session lifts that to better than 9 in 10 and cut the input tokens one measured run billed by 71 percent.
- Retry a Grok turn that xAI refused for capacity, and name the refusal an overload when the retry is refused too. xAI announces it with an empty error type and code, so the gateway read it as a plain API error, never retried it, and ended the turn on a message that only asked you to try again in a few minutes.

### fleet-console

#### Added
- Choose which endpoint Grok turns use, in Settings under AI Gateway next to the xAI models. Chat Proxy is the default and is what the official Grok CLI uses; Direct is xAI's own API. Both draw on the same subscription, and a turn always stays on the one you pick.
- Replay Grok's own prior reasoning across a tool round-trip, so the model no longer re-derives thinking it already did. Measured against xAI's wire, the following turn spends about half the reasoning tokens.

#### Changed
- Session Analyst model names in the picker now use the same mono type, size, and glyph-column indent as the canvas context menu.
- Pull, Push, and Stash report their outcome on the button itself instead of a banner that pushed the Repository panel down: the icon turns into a check, a small bubble names how many commits moved, and a failed attempt leaves a marker whose message reopens on hover.
- Move Shell creation from the canvas context menu and expandable right rail panel to a direct right rail action that creates one Shell Operation per Theater on the canvas. Pressing the action again focuses the existing panel. The Shell caption shows its Theater name.
- Send Grok turns to the endpoint the official Grok CLI uses by default, and tell it the version of the Grok CLI actually installed on this machine. The gateway used to claim a version fixed in its own source, which only ages as that endpoint raises the version it accepts.

#### Fixed
- Codex turns now reuse the prompt cache instead of paying for the whole conversation again. The gateway sent no session identity, so OpenAI routed each turn to a different machine and only about 4 in 10 turns found their own cached prefix; naming the session lifts that to better than 9 in 10 and cut the input tokens one measured run billed by 71 percent.
- Retry a Grok turn that xAI refused for capacity, and name the refusal an overload when the retry is refused too. xAI announces it with an empty error type and code, so the gateway read it as a plain API error, never retried it, and ended the turn on a message that only asked you to try again in a few minutes.

#### Removed
- Drop the Alerts panel from the right rail. Operation attention still shows on the left list and the mobile Alerts tab.

## [1.69.0] - 2026-08-20

### fleet-cli

#### Added
- Offer Cursor's GPT-5.6 Sol, Terra, and Luna, Gemini 3.7 Flash, and Kimi K3 as gateway models, each with the reasoning rungs Cursor publishes for it.

### fleet-console

#### Added
- Offer Cursor's GPT-5.6 Sol, Terra, and Luna, Gemini 3.7 Flash, and Kimi K3 as gateway models, each with the reasoning rungs Cursor publishes for it.

## [1.68.0] - 2026-08-19

### fleet-cli

#### Changed
- Gateway sessions no longer carry a Fleet system prompt or Fleet skills. Each turn states the pin contract instead, and a delegation that names no gateway identity is refused with instructions rather than quietly running on the session's own model.

### fleet-console

#### Added
- The file explorer viewer now keeps every open file on a chip strip with back/forward history, an Escape shortcut to close, a Preview/Source toggle for markdown, and a size and line-count meta bar.
- The file tree gains a Name/Modified/Size sort control, and files deleted in the working tree appear as struck-through ghost rows with a D badge.
- Open files and expanded folders are remembered per Theater and restored after a reload.
- The Repository panel now works like a Git client, not just a viewer: a Local Changes view splits unstaged and staged files with per-file and bulk stage, unstage, and two-step discard, and a commit box with amend support writes commits from the staged set.
- Pull, Push, and Stash join Sync on the Repository panel toolbar, with ahead/behind counts on the current branch; pull stays fast-forward-only and diverged histories are handed back with a clear message instead of a server-side merge.
- Checkout tabs above the Repository workspace switch between the root checkout and its worktrees in one click, and the commit inspector gains a File Tree tab that browses the full tree at that commit folder by folder.
- Write actions guard themselves before running: the panel locks its write verbs while the index is locked or a merge, rebase, or cherry-pick is in progress, and warns when Operations are stationed in the same checkout.
- Settings now carries one Claude Code system prompt switch. On keeps Claude Code's own prompt, and Off replaces it with an empty one, which measures 6,490 fewer input tokens per turn in a terminal session and 6,360 in Chat. It binds new sessions in both the terminal and Chat, and a running session keeps the prompt it launched with.
- Offer xAI Grok Composer 2.5 Fast in the AI Gateway model picker.

#### Changed
- Send Grok turns to xAI's own Responses endpoint instead of the Grok CLI proxy, which queued roughly a third of requests behind a 5 to 18 second wait. The same subscription and quota back both routes, and an account the direct endpoint refuses falls back to the proxy on its own.
- The WORKING > Changes view is now the staging workbench: the previous unified changed-file list (with its filter and tree grouping) is replaced by the unstaged/staged split.
- The Repository workspace filter now walks the whole sidebar - branches, tags, stashes, and worktrees answer the same query as repositories.
- Stash rows offer apply, pop, and drop from their context menu, with drop behind the product's two-step arm.
- The sidebar now carries one named Groups | Status switch pinned above the Theater list, instead of repeating an unlabelled sort button on every Theater row. One control, one effect, and the current axis is a word you read rather than a pressed state you decode. Alt+S still flips it and the axis still opens on Groups each session.
- A Theater's "something is awaiting in here" tick now sits on that Theater's initials, so it says which Theater is waiting instead of riding the switch that organises all of them.
- Delegation policy is enforced while a run starts rather than described in advance. An Agent or Workflow run that pins no gateway identity is refused with the instruction to read gateway_models and pin one, and every turn carries that contract.
- Updating now keeps the screen you were on: the console comes back on the same address, the open tab reconnects itself, and no second window is opened unless the old address could not be reclaimed.
- An update in progress reads as progress instead of a connection error: a curtain names the step the console is in and says the screen will come back, and the result is reported when it does.
- The update mark moved from the settings button to the help button, where the update action lives, and the menu row now names the version it would install.
- Updating from a remote session now asks for confirmation first, because it restarts the console on someone else's machine.

#### Fixed
- A caption button's name tag now clears as soon as the pointer leaves the button. Clicking one - maximizing a panel, for example - no longer leaves its tooltip standing until you click somewhere else, while keyboard focus still shows the name.
- Stay put on Tori, Bori, and Dori now survives a Console restart or update, so the aides remain moored at the last place you left them until you switch it off.
- Update no longer claims to be done while it is still installing, and a failed update now says so with its reason instead of leaving the console silent.
- A remote screen recovers by itself after the console restarts, instead of retrying an expired session forever.
- A console with remote access turned on now shuts down when asked, instead of staying alive until it is killed because a connected device was still holding the listener open.
- End a Grok turn whose upstream went quiet mid-stream, instead of waiting on it indefinitely because the proxy keeps the connection alive without sending anything.

#### Removed
- The Fleet system prompt mode setting is gone. Gateway sessions and Chat Mode no longer receive a Fleet system prompt, so its Append and Replace compositions have nothing left to compose.
- Stop magnifying a War Room deck card on hover. Pointing at a card no longer waits out a dwell and then blows it up over its neighbours; the card you are pointing at is still marked with the brass ring and lit caption, and clicking it still takes it to the stage. Hovering a marker in the map view still raises that panel beside it.

### fleet-desktop

#### Changed
- Update from inside the console now works on Desktop: the shell picks up the request and performs it with its own restart, instead of the console offering a control that could not act.

#### Fixed
- A window whose remote session ended is now told to open that host again, instead of being sent to ask for an access link it does not need.

## [1.67.0] - 2026-08-18

### fleet-cli

#### Changed
- Agents now search with the dedicated Grep and Glob tools instead of shell commands alone.

#### Fixed
- Stop a Grok answer from ending in the raw `<|eos|>` marker the model emits as text.

### fleet-console

#### Added
- Chat Mode panels now carry their own composer, always open at the panel bottom and aligned to the reading column instead of the full panel width: it sends with Enter, keeps per-panel drafts, takes images by paste, drop, or the attach button, and carries the key hints on its control row while you type. Before the first message the panel offers an invitation right above it, and the composer settles to the bottom once the conversation starts. The session's model and effort ride the same row as one badge marked with the supplier's glyph, and while a turn runs the send control becomes stop. It works on the canvas, on the War Room stage, and in narrow layouts, while deck-tile cards show no composer.
- Operation chat now has a "Chat reading width" preference with Reading, Wide, and Full presets, adjustable from the panel caption or the Terminal plugin settings.

#### Changed
- Keep the collapsed chat turn summary to the turn's own outcome, so a turn that finished no longer carries a failed-step count; individual failures stay visible when the work is expanded.
- Agents now search with the dedicated Grep and Glob tools instead of shell commands alone.
- An Operation panel's own controls now live in its caption instead of floating over the body: Session Analyst, the chat/terminal switch, and the chat reading width stand as marks to the left of the panel menu, and every caption control names itself in a hover bubble. The reading width appears only in the chat view and steps aside on a narrow panel; a War Room card keeps its caption clear of them. With no chip row over the body, a chat log now starts at the top of the panel.
- The chat context meter moved from the floating chip row into the composer control row, one step to the left of the send control, so what is left in the window reads where the message is written.
- Give each panel state its own motion on the caption rail: background work now flows in one direction, a panel awaiting your answer pulses with a widening glow, and a finished but unopened panel breathes slowly instead of sitting still. Panels in the same state now pulse in step with each other, an awaiting panel never dims below a working one, and with reduced motion turned on background work stays a dashed rail so it never reads as a running turn.
- Answer the pointer the moment it reaches a War Room card: the card you are aiming at now takes a brass hairline and a warmed caption right away, instead of staying silent for the four-tenths of a second before the preview opens. The enlarged preview then lifts clear of the cards it covers, and a card reached by keyboard shows the same mark as one reached by pointer.

#### Fixed
- Console view shortcuts such as Alt+F and Alt+T now fire while a text field has focus, so typing in a chat composer no longer costs you the keys that switch the view. Alt+Arrow still belongs to word-wise caret movement while editing.
- Show a chat Operation as background while subagents or workflows keep running after its turn ends, instead of reading as idle until they finish.
- Stop counting background work Fleet does not recognize as agent work toward an Operation's background state.
- Stop replaying the agent CLI's own internal lines as messages you sent. Switching an Operation to the chat view no longer shows background-task notifications, slash-command expansions, or local command output as your own chat bubbles, and the replies that followed them stay on their own turns instead of overwriting the previous answer.
- Keep Cruise Map from taking keyboard focus, so focusing a chat view and pressing Enter no longer paints a brass line on the map.
- Keep Claude Code's usage-limit wrap-up directive out of every request the AI gateway forwards, so work running on another provider is no longer told to cut itself short because the Claude subscription is near its limit.
- Stop a Grok answer from ending in the raw `<|eos|>` marker the model emits as text.
- A pressed caption control (a maximized panel, an open Session Analyst) draws its brass fill on the brass hue in every theme; it previously landed on green or magenta because the color mix took the long way around the hue circle.
- Close the state ring around a War Room card. A card waiting for review, arriving, or landing back on the deck drew its coloured outline down both sides and along the bottom but never across the top, so the caption sat outside the ring; the outline now encloses the whole card, including with reduced motion turned on. The magnified panel in the map view also gets its intended brass edge back instead of a green one that read as a completion signal.
- Promote a panel that finishes during War Room onto the stage even when it was already focused before you entered.
- Keep a Grok turn whose tool call arrived complete but whose stream stopped before its closing frame, instead of ending the turn with a mid-response server error.

#### Removed
- A chat log no longer opens with a line restating the coordinates it started on. The composer badge carries that fact at all times, so the log begins with the conversation itself.
- The floating reply bubble that opened Quick Launch from a chat panel is retired, along with the caption coordinate badge, the "via Quick Launch" dispatch tag, and the floating stop pill: the in-panel composer replaces those, and Quick Launch mentions keep working as a separate route.
- Remove the CLI/CHAT surface chip from left-sidebar Operation rows.

### fleet-desktop

#### Fixed
- Keep the Windows window control buttons sized and aligned with the top band when the window moves between monitors with different display scales and when the zoom level changes.

## [1.66.0] - 2026-08-17

### fleet-cli

#### Added
- Restore explicit 524K variants for Codex Sol, Luna, and Terra, including Fast, alongside the existing 272K and 1M models.

### fleet-console

#### Added
- Restore explicit 524K variants for Codex Sol, Luna, and Terra, including Fast, alongside the existing 272K and 1M models.
- Chat panels now state which model and effort the session runs on, in the chip row and as the log's first line, and mark an ultracode session with the apex tier.

#### Changed
- Session Analyst's model menu now groups providers with the same glyphs as the canvas launch menu and stays inside the window.
- Session Analyst now picks its model and effort with the same chip and three-rung track as Quick Launch, limited to low, medium, and high.
- The left sidebar no longer keeps a separate Background group. Operations still doing leftover work now sit in Running, and only their row mark still says they are in the background.
- A sidebar row that finished without being opened is now told once by its activity mark, instead of being repeated as a separate dot at the row's right edge, a tinted row, and a count on the status group header.
- The activity mark now separates an operation that is waiting for you from one that finished without being opened. Waiting keeps the cyan calling pulse; a finished, unacknowledged operation carries the green of a finished run and says so with a slow blink instead. Both still gather at the top of the status list, so nothing moves out of sight to gain the distinction.
- Fold every status group in the left sidebar and War Room into one shelf caption that keeps the signal stripe and count, drops the tinted wash, and keeps restore verbs on Minimized and Ended only.

#### Fixed
- State a gateway model's real context window in the Chat view, instead of the 200k coordinate Claude Code meters it on.
- Move the Chat context meter during a turn, so a file the model just read shows up while it is still working.
- Place a panel created from a Cruise right-click at the click, instead of dropping it on the default cascade origin.
- Sidebar rows outside the status sections, including the group axis and the minimized shelf, called such an operation idle while the extra dot said it had arrived. Every sidebar list now reads the same activity.

### fleet-mobile

#### Added
- Add the Fleet Console app for iPhone and iPad, with secure pairing to a Console on your network and a TestFlight lane for tester builds.

## [1.65.0] - 2026-08-17

### fleet-cli

#### Changed
- Remove 512K variants from the Codex Sol, Luna, and Terra picker and keep the existing 272K and explicit 1M variants only.

### fleet-console

#### Changed
- Remove 512K variants from the Codex Sol, Luna, and Terra picker and keep the existing 272K and explicit 1M variants only.
- Chat Mode now folds failed steps and writes outside the Theater into the same per-sentence tally as ordinary tool calls.

## [1.64.0] - 2026-08-17

### fleet-cli

#### Changed
- Codex Sol, Luna, and Terra keep their existing 272K models and add explicit 512K and 1M variants, including Fast, in the gateway picker.

### fleet-console

#### Added
- Running background jobs can be stopped one at a time from the job detail view.
- The empty canvas now offers "Open all in Tactical", resuming every standing-by operation into the auto-arranged grid in one click; beyond eight operations the button arms first so a misclick cannot spawn a pile of shells.

#### Changed
- Codex Sol, Luna, and Terra keep their existing 272K models and add explicit 512K and 1M variants, including Fast, in the gateway picker.
- Chat Mode keeps its agent session alive for as long as the Operation is open, so background shells, subagents, and workflows outlive the turn that started them and report back when they settle.
- Stopping a chat turn now interrupts the agent instead of ending its session, so background work started earlier keeps running.
- The empty canvas standby list shows every standing-by operation with its last-activity time instead of only the two most recent, scrolling past four; the Korean copy now labels them as kept off so it no longer collides with the War Room waiting label.
- Drop the rounded status mark from Sort by status and War Room group headers. Each panel already shows that mark.

#### Fixed
- Keep nested subagent frames off the Chat Mode host transcript so their tools and reports stay on the job surface.
- Starting Chat Mode from Quick Launch with the ULTRACODE track now keeps standing dynamic-workflow orchestration (`xhigh` plus the session ultracode setting) instead of collapsing that choice to max intensity.

## [1.63.0] - 2026-08-16

### fleet-cli

#### Changed
- `fleet --version`, `-v`, and `version` now print the Fleet package version and channel. Claude Code's version is still `fleet cli --version`.
- `fleet auth login` and `logout` reject an unknown provider name instead of opening a picker.
- `fleet doctor` reports the install, Claude Code on PATH, gateway auth, and Console health without changing anything. `fleet status` is the same as `fleet console status`.
- `fleet update --check` reports whether a newer package is available without installing or stopping the Console.

### fleet-console

#### Added
- Show how much of the context window a chat session is using. A meter chip sits with the view chips and opens a breakdown of what fills the window: messages, tools, memory files, skills, and free space. Each folded turn line carries the tokens that turn added. The reading is taken when a prompt starts, which is the only moment the session answers, so it always describes the last prompt and says so.

#### Changed
- Every AI Gateway model now offers ULTRACODE in both launch intensity controls, while models without MAX skip that rung.
- Right Rail panels now share one body text size, so switching between Repository, Quota, Skills, Ledger, and Files no longer changes the type you are reading.
- Command Band controls now sit on one height, so the local chip, breadcrumb, and mode switch line up on a single baseline.
- Code highlighting in the file preview now uses its own colour channel instead of borrowing the status colours, so a string no longer reads as "complete" or a number as "in progress".
- Show each usage-limit reset as a calendar date and hour next to the remaining time, or as a 24-hour clock when it is a day or less away, keep the used percent under the bar, and put the exhaustion countdown in the old percent slot.
- Give every Operation the same activity mark, one rounded square, in the sidebar, War Room, and the command band alike, in place of the launch-provider glyph, and drop the per-chip notification count.
- Clear the panel caption down to the name and its window controls: the status mark and slot number are gone, and a More button opens the same Operation menu as right-clicking the sidebar chip.
- Hide the stop and reply buttons on a War Room card, together with the first-turn invite that only makes sense next to the reply bubble. They return on the staged panel, where they can be used.

#### Fixed
- Keep Console APIs reachable when several Chat Mode panels are open by moving each chat journal off HTTP/1.1 EventSource onto the same ticketed WebSocket path the terminal already uses.
- Render Chat Mode step commentary as markdown instead of forcing the whole sentence into italics.
- Keep the chat workflow stage table in one set of columns at any panel width, eliding a value that no longer fits instead of letting each row set its own layout.
- Show a gateway model in the chat workflow stage table by its own name, without the routing alias every row repeated.
- Stop a long agent turn from stretching with blank space by no longer drawing a ledger segment whose sentence and steps are both empty.
- Tighten the ledger rhythm so a folded tool line sits with its own sentence instead of leaving a blank line under it.
- Opening Quick Launch from a chat reply bubble addresses that Operation and drops any leftover unsent draft.
- The apex outline on Quick Launch keeps circling for as long as `ultracode` stays in the prompt. It used to freeze into a single arc the moment the ignition finished.
- `fleet-console --help` now shows the installed version and channel instead of always saying `local`.

## [1.62.0] - 2026-08-16

### fleet-cli

#### Fixed
- Retry transient Grok server and socket failures before any caller-visible output instead of ending the model turn with an incomplete-response API error.

### fleet-console

#### Added
- Answer the agent inside the chat view. When the model stops to ask which way to go, the question stands as a card where it was asked, so you can pick an option or type an answer of your own, and the turn continues from your choice. A plan the model submits for review arrives the same way: approve it, or ask for a change and it comes back revised.
- Show a waiting operation as waiting. While the chat view holds a question, the sidebar chip, War Room tile, and map dot read it as awaiting input rather than working, so a question you have not opened still finds you. The session waits until you answer or skip it, and never times out on its own.
- Chat Mode now tracks background work (subagents, dynamic workflows and background shells) on its own clock. A backgrounded call keeps its own card instead of folding away, and a strip above the reply control counts what is still running. Clicking that strip opens the work surface beside the conversation rather than in place of it: a column on a wide panel, a drawer on a narrow one, resizable either way. A dynamic workflow opens into its stage tree, one row per agent with the identity it was pinned to. A subagent opens into the report it returned plus the trail of tools it actually called, and a background shell opens into the tail of what it printed.
- Chat Mode can stop a turn that is going the wrong way. The control stands next to the reply button while a turn is in flight, and the turn it closes reads as stopped rather than failed, keeping whatever the model had already written. Background work that was already started keeps running, and the work surface still reports it.
- Chat Mode now runs under the same Fleet instructions, skills, and gateway tools a terminal Operation gets, so a session answers the same way on either surface.
- Keep your place in a streaming chat log, and jump back to the live tail with a Follow chip.
- Usage limits shows OpenCode Go again, reading account-wide session, weekly, and monthly percents from OpenCode's official usage API.

#### Changed
- Give the Session Analyst panel its own caption bar, so it lines up with the panel beside it instead of leaving an empty strip above it and squared-off top corners. Its identity, state, Reset, and the Chat/Artifacts switch move into that bar and stop covering the first line of the conversation.
- Rebuild the Session Analyst composer as one surface: the model, effort, and slash-command controls now sit inside the prompt box instead of a separate strip above it, control labels are large enough to read, and effort uses the same colour ladder as Quick Launch.
- Switching an Operation between the terminal and Chat Mode now continues one conversation file instead of copying it back and forth, so neither surface can overwrite what the other wrote.
- Refocus Ledger on Claude Code model usage with native Anthropic and Gateway-provider attribution, static OpenRouter cost estimates, merged Fast variants, and model detail reserved for the Today window.
- Show the Codex reset credits as a compact chip, and hide the line entirely when no credit is held.
- Hide the Analyst and Chat view chips on a War Room card, and let a chat-mode card use the space those chips leave. They return on the staged panel, where they can be used.

#### Fixed
- Show a gateway model in the Session Analyst model list right after you add it in Settings. The list was read once per Operation and never again, so a model added later stayed missing until the page was reloaded.
- A turn that left work running no longer closes with a check mark on it. The fold now says how many jobs are still running, and a job that was cut short before finishing says so instead of reading as completed.
- A collapsed row of tool calls now looks like something you can open before you hover it. The tool's name reads a step brighter than the words around it, and the chevron that opens the row is large enough to see at rest.
- When background work finishes and the model answers again, that answer opens its own turn instead of replacing the answer of the turn that started the work.
- Chat Mode no longer holds a live stream for a parked, minimized, or hidden panel. Only a body the user can read keeps its EventSource, so close and Resume requests are not starved behind off-screen chat subscriptions. War Room deck tiles stay subscribed because their bodies are painted.
- Aide Bori cheers when a panel finishes, then returns to idle instead of freezing mid-pose.
- Keep inertial phone scrolling from typing malformed mouse coordinates into terminal prompts.
- Retry transient Grok server and socket failures before any caller-visible output instead of ending the model turn with an incomplete-response API error.
- In War Room, a focused deck panel that starts waiting now comes up on stage without a pick.
- Clicking empty space in War Room now unfocuses a focused panel that is not on stage, the same way an empty Cruise map click does.

#### Removed
- Drop the Analyst composer's provider control while only one provider is offered. It listed a single unchangeable entry, and the model menu already covers every native and gateway model.

## [1.61.0] - 2026-08-16

### fleet-cli

#### Fixed
- A Console server that fails to start now names what stopped it and what to check, and a browser that never opened hands you the address instead of reporting success.

### fleet-console

#### Changed
- Chat view now shows the agent's work as it happens: steps stack up as a live ledger with a verb and its target, each one carrying its outcome (exit status, lines written, or the first line of an error), and the files a turn changed stand above them.
- One turn reads as a sequence of what the agent said it would do and what it then did. Each sentence the model writes opens a segment, and the routine steps under it settle into a single tally line such as "read 3 files, ran 2 shell commands" once that segment closes. Clicking a tally line unfolds the steps it counted. Failed steps and writes outside the Theater never fold into a tally.
- A finished turn folds its whole process into one line that reads how long the agent worked, with an expander beside it. A turn that had a failed step says so on that line instead of hiding it behind a checkmark.
- Writes that land outside the Theater folder are marked in the ledger instead of reading like any other path.
- A brand new install no longer opens What's New. Its release backlog is not news to someone seeing the product for the first time, so the next release is the first one it announces.
- Restored sessions after a Console restart now share one Ended signal and a start-again path from the panel, sidebar, and palette, instead of painting a dead process as idle.
- A rejected rename, accent, group, or reorder edit rolls the panel back to the server value and offers Try again, instead of looking saved.

#### Fixed
- Failures now say what happened, why, and what to do. A terminal that cannot connect, a folder that cannot become a Theater, and an Agent CLI that is missing or signed out each explain themselves instead of showing a status code or a machine name.
- Saving one setting no longer blocks another. Two settings changed in quick succession both persist, and a failed save reverts only its own field.
- Removing a skill, relaunching a dormant Shell, and opening a remote host now report a refusal instead of looking like nothing happened.
- The terminal panel and the Skills list now follow the console language, and the Skills preview dialog, its tabs, and the Theater row are reachable with a screen reader.
- A plugin that comes up without its panel now says so, instead of leaving an empty spot in the rail with no explanation.
- Scrolling a full-screen agent on a phone no longer types `NaN` into the CLI prompt.
- Keep the Quaker aides' speech bubbles and full-answer card opaque in the Carbon, Maritime, and Whites themes, so the Map and panels behind them no longer show through the words.
- Restored Codex and other Agent CLI sessions no longer inherit a Claude supplier mark when the launch record was missing.
- Station Keeping now keeps window captions out of neighboring panels, not just the panel bodies.
- Station Keeping now settles a panel when a drag is interrupted without pointerup, so captions do not stay overlapped.
- Drop a War Room panel's hover magnification the moment the deck density changes, so adjusting density no longer leaves one panel enlarged across its neighbours.
- Release a War Room panel's hover magnification as soon as the pointer leaves it, so a magnified panel no longer stays enlarged over its neighbour and close the gap between deck tiles.
- Keep a War Room panel's caption and body inside the tile it stands in, so lowering the deck density - or narrowing the deck until it adds a column - no longer paints one panel's text across its neighbours.
- Open a War Room panel's hover magnification only when the pointer moves onto it, so a tile that slides under a still cursor - on entering the deck, changing density, or resizing the sidebar - no longer enlarges itself across its neighbours.

### fleet-desktop

#### Fixed
- A startup that cannot proceed now explains what stopped it and where the diagnostic log is, instead of quitting with no window and no message.

## [1.60.0] - 2026-08-15

### fleet-cli

#### Added
- The AI Gateway honors Compact timing from Settings so Claude Code auto-compacts at Auto (window minus 16k), Early (88%), Late (97%), or a Custom 70-99 percent of each model window.

### fleet-console

#### Added
- Settings > AI Gateway now has Compact timing (Auto / Early / Late / Custom) so a gateway session auto-compacts at a chosen share of each model's catalog window.
- Clicking Console chrome outside the Map, including the left sidebar and right rail, or empty sea on the Map, now clears the active panel. Clicks on a panel, sidebar chip, or Map-owned menu keep it.
- Show an Operation's group on its panel caption as a coloured dot and the group name, so membership reads without opening the sidebar.
- Quick Launch can mention the focused Operation when opened, from an opt-in control next to pin.
- Quick Launch `@` now lists the Quaker aides on duty beside your Operations, so a quick web question goes out from the composer instead of chasing a roaming mascot; the aide moors, answers in its own speech bubble, and "Open the full answer" hands the rest to its chat card.
- Quick Launch `/effort` ends with a gate row that names and reveals the gated tiers the chosen model actually offers, and omits that row for a model that gates none, so the list tells a hidden tier apart from an unavailable one.
- Quick Launch can start an Operation directly in chat view. Type `/view` and pick Chat view: no terminal opens, and your first message becomes the session's first turn. The choice is remembered, and while it is on the composer says so above the input and draws its own outline, so the launch bar keeps its single row. Switch back any time with "Use terminal view" or `/view`.
- War Room cards show the same Operation mark as the sidebar, to the left of the title.

#### Changed
- Redesigned the Session Analyst drawer in the chat-view grammar: it now shares the operation panel surface, replaces the header band with floating identity and Artifacts chips, renders questions as identity-washed bubbles with turn spines, adds a collapsible work receipt per answer, promotes evidence citations to inline chips, and enlarges answer typography.
- Merged the Session Analyst into a single panel with a Chat/Artifacts mode switch: published briefs open inline via the mode segment or the publish card, and the vertical ANALYZE/EXIT and ARTIFACTS edge handles are replaced by an Analyst chip that joins the view-chip cluster next to the chat-view switch.
- Session Analyst evidence citations are now clickable: selecting an [eN] chip prefills the composer with a question that asks the analyst to show that evidence in context.
- A chat Operation replies from a bubble button in the panel, which opens Quick Launch already addressed to that session; the status strip along the bottom of the chat view is gone and the log now runs to the panel edge.
- Right-click no longer opens the operation launcher when no Theater is registered.
- File Explorer marks every limit it used to hide: a folder listing cut at 500 entries shows a marker row, the file filter reports live scan progress and warns when its folder cap skips matches, palette search flags capped results, and an oversized git status notes hidden badges.
- Version-control internals (.git, .svn, .hg) no longer appear in File Explorer listings, filters, or searches; with hidden files shown, a named muted row records what was withheld.
- Ledger now reads a second local models breakdown so the rail can name suppliers and models instead of collapsing spend into CLI client rows.
- Quick Launch no longer puts an ULTRACODE chip in the bar when the prompt contains `ultracode`. The notice above the field stays for the whole request, and the outline ignites before it cruises.
- The Quaker mascots are now aides rather than admirals, so "Admiral" names only the host agent that plans and delegates.
- Quick Launch `/model` pins each provider band to the top of the list while you scroll and indents model names under it, so a supplier is named once instead of on every row.
- Quick Launch `/effort` paints each rung in the same tone ladder the effort track uses, with MAX and ULTRACODE carrying their own molten-copper and aurora treatments.
- The reasoning-effort ladder spreads across its full available range, so neighbouring rungs read apart at a glance instead of only under direct comparison.
- Quota cards now show Claude Max 5x/20x, Codex Pro 5x/20x, and xAI SuperGrok plan names.
- A repository sync that finds nothing new now answers on the Sync button itself: the refresh icon settles into a check and returns, with a short hint beside it, instead of opening a notice that shifts the panel.
- War Room now puts the real panel in every deck tile, so a shell rewraps to the tile it stands in instead of being a shrunken picture of itself; band layout, density, and the map dots are unchanged.
- Admiral Bori still shows the alert mark, but no longer hops or flaps through a warning.

#### Fixed
- A chat Operation's panel caption now shows whether it is working, and a restored Operation reads as dormant there instead of idle.
- Focusing a chat no longer retints the whole log. Caption and chat use the same fills as the terminal view: the panel face, with the focus wash on the caption only.
- An Operation running in the chat view no longer reads as dormant. Closing the terminal ended the panel's only source of activity, so the sidebar said the session was asleep while the chat strip said it was working. Chat now reports its own turns, and the sidebar shows the same running, waiting, or idle signal the terminal view shows, and each chip now names the surface its Operation runs on with a small CLI or CHAT mark.
- The Console no longer presents a guess as an activity state. When it cannot reach the source of that signal it says so in a banner and leaves the chips as they were, instead of quietly showing every Operation as idle.
- A chat log no longer jumps to the top when the panel changes size, as it does when an Operation is promoted to the War Room stage. A log that was following the newest turn keeps following it, and a log you had scrolled up to read keeps showing the same place instead of being pulled to either end.
- The docked Quick Launch bar now shows Ctrl+Space next to Mod+J, matching the shortcut that already opens it.
- A chat Operation whose transcript is missing now says so instead of waiting on a connecting message forever, and the terminal button beside it is the way out.
- Tactical Grid empty-slot boxes now match the occupied window, including the 32px caption, instead of drawing only the body.
- The War Room deck reaches the bottom of the canvas, reclaiming a reserved strip that held nothing.

#### Removed
- Drop the accent stripe down a panel's left edge; identity now speaks only through the caption's nameplate mark, so an unfocused caption stays on the same surface as the panel.

## [1.59.0] - 2026-08-15

### fleet-cli

#### Added
- Offer Cursor Opus 5 and Fable 5 through the AI Gateway, including Max Mode 1M variants billed against the Cursor API pool.

#### Fixed
- Let Cursor models page through the caller Read tool instead of repeatedly replaying whole files through failed native reads, reducing context growth and compaction during long gateway sessions.

### fleet-console

#### Added
- Offer Cursor Opus 5 and Fable 5 in AI Gateway model selection, including Max Mode 1M variants billed against the Cursor API pool.
- Claude Gateway operations can switch from the terminal to a chat view that continues the same session through the Claude Agent SDK, replays earlier turns, and takes replies only through Quick Launch; while a turn runs, an activity card shows the current step with a live elapsed timer and the reply streams in character by character, and when it finishes the work collapses into an expandable receipt while the final answer stays rendered with the Console markdown component. The terminal reopens on demand with the full history intact.
- Quick Launch understands slash commands: typing `/` as the first character opens a command deck that changes the Theater, model, reasoning effort, or bottom dock without leaving the keyboard, with model choices carrying their provider marks.
- Toggle Quick Launch with Ctrl+Space on every platform, including macOS, while keeping Mod+J.
- Attach images in the Quick Launch composer by pasting, dropping, or the attach button: images appear as thumbnail chips with click-to-enlarge preview and per-chip removal, ride new launches and '@' mentions to running or dormant Operations alike, and the agent reads them from disk alongside the message.
- Quick Launch recognizes `ultracode` in a prompt: the word lights up as you type it, an apex arc travels the edge of the composer, and a dashed `ULTRACODE` chip stands beside the reasoning-effort track to say that this turn requests a dynamic workflow while the reasoning effort stays exactly where you set it. The match ignores letter case. Pressing Backspace right after the word, or selecting the chip, hides the mark and nothing else - your prompt is delivered exactly as you typed it, so the agent still reads the word. It all works the same way when the prompt is addressed to a mentioned Operation.

#### Changed
- The chat view now sits on the same surface as the terminal panel in every theme. Its session strip at the top is gone and the log starts right under the window caption, so the panel reads as one window instead of a header bar over a separate sheet. Returning to the terminal moved into a floating chip in the top-right corner, matching the chip the terminal view uses to switch into chat.
- Reduced the repeated command and result payloads used when Cursor searches run through caller-approved shell tools, while preserving bounded search results and permission checks.
- An Operation panel is now one surface. The caption, the border around the terminal, the terminal field, and the chat log all take a single color per theme, so a panel reads as one window instead of three stacked sheets, and Maritime loses the darker ring that used to frame its terminal. That one color is the work surface's own tone, so the panel still stands clear of the canvas and, in Whites, stays the brightest tier the eye lands on. Focus, identity accent, and the status rail keep working as before, now against a single fill.
- Operation panel state now reads on the window caption instead of the panel outline. A focused panel lifts its caption fill and title, and a status rail runs along the caption's lower edge, so a focused panel still shows whether it is running or waiting for you, and a panel working in the background finally shows anything at all. The panel outline stays a neutral rim in every state, and the unseen-completion glow becomes an arrival flash on that rail.
- Operation panels now carry a 32px window caption above the existing body, so the PTY keeps its previous size. The caption draws the same rim as the panel body so the two read as one outlined window. Tactical packs each row with that 32px caption in the stride so stacked captions stay in their cells. War Room and maximize keep the caption outside the body by shifting the slot down. Dragging uses the whole caption, including the title; rename stays on double-click. The Activity Rail keeps its hover-reveal header so the panel body uses the full slot.

#### Fixed
- Let Cursor models page through the caller Read tool instead of repeatedly replaying whole files through failed native reads, reducing context growth and compaction during long gateway Operations.
- Maximizing a panel in Tactical no longer leaves the mode boundary drawn over it. The boundary marks the grid arena, and a maximized panel covers that arena entirely, so the frame and its corner brackets now step aside instead of sitting on top of the panel while it overhangs them.
- The rail Shell panel now sits on the same surface as the terminal inside it, so the framed step around that terminal is gone in every theme.
- A staged War Room panel now fills the canvas down to the same 18px inset Tactical already uses. The old bottom waiting rail is gone, but the stage still reserved that band, so activating one panel left an empty strip under the frame.
- Stop the terminal from flashing blank for a frame when its panel is resized, such as when the side bar is collapsed or expanded.
- Let the terminal catch up to its panel as soon as the side bar finishes moving, instead of staying clipped for roughly half a second afterwards.
- Stop asking the shell to redraw its whole screen when a resize leaves the character grid unchanged, such as a drag smaller than one cell.

#### Removed
- Usage limits no longer shows an OpenCode Go card. OpenCode has no supported quota API, so the local-log approximation is gone; OpenCode models remain launchable.

## [1.58.1] - 2026-08-14

### fleet-cli

#### Changed
- Reduced repeated Grok 4.6 tool-schema uploads during tool-search loops while preserving selected and continuation-referenced tools.

### fleet-console

#### Changed
- Reduced repeated Grok 4.6 tool-schema uploads during gateway Operations that use tool search while preserving selected and continuation-referenced tools.

## [1.58.0] - 2026-08-13

### fleet-cli

#### Added
- Added Grok 4.6 through the official Grok CLI subscription, reusing its local sign-in without API keys or a Fleet-managed OAuth flow, matching the CLI proxy's client contract, and rejecting incomplete tool calls before they can appear as running work.

#### Changed
- Gateway models other than Claude and Kimi no longer receive Claude Code's Web Search tool, so those models stop attempting a search they cannot run.

### fleet-console

#### Added
- Added Grok 4.6 gateway routing, weekly subscription quota, and the official Grok product mark across launch, settings, and quota surfaces.
- Reconcile the Ledger hero with device-wide spend: an attribution bridge under the summary splits the window's cost into Console-attributed operations and other local sessions, with the device-wide total named in the same block.
- Keep Operations visible in Ledger when their saved session has no matched usage in the window: they render as dimmed ghost rows with a matched/unmatched coverage line, and the operation list gains a recent-activity / highest-cost sort toggle.
- Read the Ledger daily trend past one peak day: a square-root scale toggle keeps small days readable, and a bright layer inside each bar marks the cost attributed to this scope's Console operations on the same day axis as the totals.
- Close an Operation from the mobile session title with the same two-tap arm and undo window as the desktop frame.
- Pin Quick Launch to the bottom of the screen so you can write an instruction while the work stays visible. The docked bar recedes into a single line carrying your draft when you look away, and returns when you focus it or press the Quick Launch shortcut. Settings folds the bar away and brings it back when you leave. Opening the composer for the first time points out the pin.
- Reorder provider cards in the usage limits panel by dragging their grip: cards collapse into single rows while dragging so every drop target stays visible, the order persists across sessions, and the grip also moves cards with the arrow keys.

#### Changed
- Move the provider glyph onto the Command Band Operation name and drop the trailing model chip. The mark sits to the left of the name the way the sidebar chip already does; which model is running stays in the Operation switcher list.
- The codex workspace agent menu now opens the effort track to the right of the model rows first, falling back to the left only when the right side lacks room.
- Gateway models other than Claude and Kimi no longer receive Claude Code's Web Search tool, so those models stop attempting a search they cannot run.
- Quick Launch picker menus now follow the standard menu keyboard grammar: opening a picker focuses the current choice, arrow keys and Home/End move through the list, typing a letter jumps to a matching entry, Enter picks and returns to the prompt, and Escape returns to the chip.
- The usage limits panel now shows a proper loading state that explains provider usage is being read, instead of a bare "..." while the first summary loads.
- Quick Launch still puts the original prompt on the Claude argv on POSIX, and on Windows when that prompt is short enough and has no cmd.exe metacharacters. On Windows, Fleet writes the original prompt to a unique OS temp file per launch and the session receives only a short instruction to read that file when the prompt contains a character cmd.exe would reinterpret (" & < > ( ) @ ^ | %), or when the command line would overflow (8,191 characters through a cmd shim, 32,767 through native claude.exe). Trust folder and update dialogs still complete before the first user turn. The Operation title still comes from the original prompt, not from a file instruction.

#### Fixed
- The focus ring on the Theater and model chips draws as a complete ring instead of two clipped side arcs.
- Closing Quick Launch with Escape no longer discards a typed prompt; reopening restores the draft.

#### Removed
- Drop the War Room bottom rail. The sidebar already keeps the waiting order, so two places announced the same backlog and split your attention across the screen. Setting an item aside and pushing it to the back are unchanged.

## [1.57.2] - 2026-08-13

### fleet-cli

#### Added
- Add Cursor Grok 4.6 and Grok 4.6 Fast with Low, Medium, High, and Extra High reasoning levels while retaining Grok 4.5.

### fleet-console

#### Added
- Offer Cursor Grok 4.6 and Grok 4.6 Fast in AI Gateway model selection with CursorBench 3.2 quality evidence.

## [1.57.1] - 2026-08-13

### fleet-console

#### Fixed
- Keep the Quick Launch composer inside the screen on phones: a long Theater name now truncates in its chip instead of pushing the card past the viewport, and the Theater, model, and effort controls wrap onto their own rows so every control stays reachable.

## [1.57.0] - 2026-08-12

### fleet-console

#### Added
- Give a terminal opened on a touch screen a bar of the keys a soft keyboard leaves out: Escape, Tab, arrows, and latching Ctrl and Alt, with function keys, paging keys, and shell punctuation behind one more tap.
- Mention a running agent Operation with @ in Quick Launch and the prompt goes straight to that Operation's terminal instead of starting a new one. A dormant Operation is resumed first, and the composer stays where you are after sending.

#### Changed
- Name the model an Operation is actually running in the command band and its Operation menu, so a breadcrumb reads GPT-5.6-Sol-Fast or Opus instead of the launcher it went through.
- Rebuilt the Cowork dock's agent settings as a single-layer model menu: each model row carries a reasoning-effort handle that opens the same effort track the launch menu uses, the chip now reflects both the model and the chosen effort, and Cowork offers the low/medium/high tiers that fit document co-editing.
- Recast the Cowork model lineup to opus[1m], sonnet, and haiku - fable is no longer offered for document co-editing - and stopped the instruction input from triggering the browser's autofill suggestions.
- The right rail panel header no longer occupies a resident row; it now reveals as an overlay when the pointer approaches the panel top (or via keyboard focus and a top-edge tap on touch), returning its full height to panel content, and Escape inside the revealed header closes the panel.
- A console keeps one remote connection at a time and hands that seat to the device that joined last, instead of turning a device away because another one is still connected. The device that had the seat is disconnected and told that another device connected, rather than that its control was taken back, and it keeps its pairing, so it takes the seat back by simply joining again. Nothing changes on the machine itself: the same notice names whoever is connected and still offers to take control back or keep watching.

#### Fixed
- Return an Agent Operation to running as soon as you answer its question in the terminal, instead of leaving it marked as waiting for input until the turn ends.
- Read an Operation as running background work once its turn has ended, so subagents and workflows that outlive the turn no longer read as a running turn.
- Show the terminal at full height on a phone; an open session had collapsed to a sliver above empty space.

## [1.56.0] - 2026-08-12

### fleet-console

#### Added
- Switch Theater on a phone from a Theater tab, where each Theater lists how many Operations it holds and how many are waiting.
- Show a new access link as a QR code so a phone can take it off the screen instead of through a chat app, with the link's remaining time and the moment a device pairs both visible in the same window.

#### Changed
- Open Settings on a phone as a list of sections, and tap one to give it the whole screen. The section list no longer takes most of the first screen, and each row shows what it currently holds, so the theme, language or gateway in use reads without opening anything.
- Size every control on the phone's Settings screens for a fingertip, and stand the theme choices in one column instead of letting them wrap into uneven rows.
- Name the active Theater above the mobile Operation list, so the list says which Theater it belongs to.

#### Fixed
- Stack the desktop Settings rows on any window narrow enough for the mobile layout. Between 721 and 767 pixels the help text was squeezed into a narrow vertical ribbon beside a wide empty gap.

## [1.55.0] - 2026-08-11

### fleet-console

#### Added
- Open Remote access on the local network by default, with an optional public hostname and NAT route that must be enabled and acknowledged explicitly.
- Edit the remote endpoint as a draft and apply it deliberately. Choosing an interface, changing a port mode, or turning the public endpoint on no longer touches a running listener; Start listening, Save for later, Apply changes, and Stop listening are the only actions that save.
- Say what applying a change costs before it happens: a listener restart keeps paired devices, while any change to the address devices trust disconnects sessions, revokes unused access links, and unpairs every device.
- Show the connection route once, and only once every required value is valid, so an incomplete endpoint reads as a named requirement instead of a placeholder hostname.
- Spell the router rule out in the fields a router actually asks for - external port, internal IP address, internal port - and say so when the external and internal ports differ, because entering the public port on both sides forwards to a socket nothing is listening on.
- Leave pairing as the only thing a remote listener answers without a session. Pairing happens in the Fleet Console apps, which check this console's certificate fingerprint, so the listener no longer serves a browser-facing page explaining that.
- Spend a failure budget on that pairing door so a public endpoint cannot be hammered for free, and report the rejected attempts in Settings instead of counting them silently. A successful pairing clears its source's budget, so a device that connects is never punished for someone else's noise.
- Keep the listener's own settings on the owner's side. Remote access does not appear in Settings when you are connected from another device, so a paired device can neither read the address this machine listens on nor rewrite the one it publishes, and a public hostname that no device could reach - a loopback or wildcard address - is refused the same way a listen address already was.

#### Changed
- Show the Claude launch group as Claude instead of Claude built-in.
- MAX and ULTRACODE efforts each carry their own signature motion: the MAX label flickers like embers over a molten copper fill with a breathing knob halo, while the ULTRACODE fill drifts like an aurora with twinkling gate glyphs in place of the white sweep. Reduced-motion environments keep every treatment static.
- Replace the launch menu's native scrollbar with directional edge strips: hover a strip to glide through a long model list, click it to jump a page, and a slim gauge shows the position while scrolling. Wheel and arrow-key scrolling keep working, and reduced-motion setups get click-step jumps instead of the glide.

#### Fixed
- Backend API settings now organize Console Operations and successfully loaded plugin HTTP, SSE, WebSocket, and proxy routes into default-visible, collapsible Core and per-plugin groups.
- Opening the apex effort gate no longer shifts the track's existing stops and knob: the ladder keeps its closed spacing and only extends to the right.
- Preserve the selected Claude Code model and effort when dormant Agent panels resume, with Opus 1M as the default for legacy panels that lack saved launch settings.

## [1.54.1] - 2026-08-11

### fleet-cli

#### Changed
- Advertise `[1m]` only for gateway models with a real 1M-or-larger context window, while continuously mapping usage so Claude Code reports approximate context progress and compacts with 16K of each model's real window remaining in mixed-model sessions.

### fleet-console

#### Changed
- Advertise `[1m]` only for gateway models with a real 1M-or-larger context window, while continuously mapping usage so Claude Code reports approximate context progress and compacts with 16K of each model's real window remaining in mixed-model sessions.

## [1.54.0] - 2026-08-10

### fleet-cli

#### Removed
- Drop unsupported Cursor AI Gateway models from discovery. The Cursor catalog keeps Auto, Composer 2.5, and Grok 4.5 (including their fast variants); Claude, GPT, and Kimi entries no longer appear on the Cursor provider.
- Stop publishing the version-matched, bin-free `@dotobokuri/fleet-cli` migration bridge on stable Console releases; install `@dotobokuri/fleet-console` instead.

### fleet-console

#### Added
- The reasoning effort track now closes its everyday ladder at XHIGH and keeps MAX and ULTRACODE behind an apex expander that appears only for the apex tiers the model actually exposes; unsupported apex rungs stay off the axis so the closed gauge does not reserve empty MAX or ULTRACODE stops. Opening the gate plays a staged reveal, MAX uses a molten-copper crest channel, and ULTRACODE paints the gauge violet with a flowing label wave.
- ULTRACODE launches the operation with Claude Code `--effort ultracode`, which applies xhigh effort and standing multi-agent orchestration together.
- Offer Cursor Max Mode 1M variants of Opus 5 and Fable 5 beside the existing Kimi K3 1M catalog model.

#### Changed
- Streamline the Operation launch menu with compact model rows and a final Etc group for Shell.
- Launch Fable with Claude Code's 1M context coordinate while keeping the existing Fable labels.
- Mark each Agent Operation with the provider whose model launched it, so the sidebar, the command band, and the search palette all show that provider's glyph in its own carrier colour instead of one uniform Claude mark.
- Usage limit meters now read the same risk verdict the AI Gateway roster uses, so a window being spent faster than its clock refills shows as at-risk instead of waiting for the bar to look full. Each bar marks how far its reset cycle has run, shades the headroom the current burn rate is on track to consume, and says how long the window lasts at that pace. The panel now keeps its update time, refresh, and a help control on a bar that stays put as you scroll; the help explains what the fill, the tick, and the hatching mean, and where the readings come from.
- Make Repository graph badges easier to scan by placing branches before tags, folding remote tracking into the branch mark, strengthening contrast, and keeping every visible badge whole as the panel resizes.

#### Removed
- Drop unsupported Cursor AI Gateway models from the settings catalog and launch pickers. The Cursor provider keeps Auto, Composer 2.5, and Grok 4.5 (including their fast variants); Claude, GPT, and Kimi entries no longer appear under Cursor.
- Remove the AI Gateway model star that set a session default. New gateway sessions keep Claude Code's own model choice; the host loadout no longer marks a settings default.

## [1.53.0] - 2026-08-09

### fleet-cli

#### Fixed
- Give AI Gateway API key login enough time for the live validation probe to return, so a slow OpenCode Go response no longer fails as a timeout before the key is stored.

### fleet-console

#### Added
- When you pick a reasoning effort other than AUTO in the canvas launch cascade, a tip under the track says to press the knob again to launch; it keeps appearing until that confirm gesture succeeds, and Help > Show the screen guide restores it.
- Settings > Remote access now points to the latest Fleet Desktop release under the section lead, with a link to GitHub releases, so another device can install the app that opens this console.

#### Changed
- Right-clicking the canvas or an empty sidebar row now opens the model list itself. The launch menu used to list launch kinds first and hide the models behind a side flyout, so picking a model took one hover more than it needed; now Shell sits on the first row and the provider bands follow it in the same menu, with reasoning effort still one step to the side. The menu keeps one name wherever it opens, so its heading no longer changes with the surface it was opened from.

#### Fixed
- Give AI Gateway API key sign-in enough time for the live validation probe to return, so a slow OpenCode Go response no longer fails as a timeout before the key is stored.
- Moving to a console that runs somewhere else on this computer, such as one inside a WSL distribution or a second console you started yourself, no longer strips the way back. The host box now works out where you are standing from the console the app launched rather than from the shape of the address, so any console that is not that one unfolds your own computer's list exactly as a remote console does. The chip names the console you are standing on instead of calling it local, that console's row in the list carries its own name rather than borrowing the name of the console drawing the list, and the app tells a console where home is before the window arrives, so the way back no longer depends on which of the two gets there first.

### fleet-desktop

#### Fixed
- Make access-link copy actions work in the Windows Desktop app while keeping clipboard permission limited to the active Console origin.

## [1.52.0] - 2026-08-09

### fleet-cli

#### Added
- Record third-party benchmark evidence (CursorBench) in the gateway model catalog and report it through the `gateway_models` roster; sessions rank judgment work by measured scores first, and models CursorBench has not measured fall back to the provider class as the only prior. Each gateway agent identity's description carries its benchmark score and token cost at its reasoning effort, with a class-based fit hint.
- Add the opt-in `providerPriority` setting: an ordered provider list whose allowances runs spend first, overriding quota pressure forecasts until real failures are observed.

#### Changed
- Claude Code sessions on Codex and OpenCode Go models no longer resend their full tool catalog for the short suggestion generated after a visible turn. Claude Code explicitly forbids tool use in that internal request, so the catalog could not affect the result and only enlarged each request; the tools callable in ordinary agent turns are unchanged.
- A session launched on a Cursor model through the AI Gateway now carries its tool instructions as an always-applied Cursor rule, alongside the copy at the head of the conversation. The rule travels with each turn, including the turn that follows a tool result, so the instructions reach the model at the point it chooses a tool rather than only once at the start.
- Gateway model identities now carry the Fleet plugin scope. Select one as `fleet:<name>`, which is the spelling `gateway_models` reports, and the same rule the bundled Fleet skills already follow.
- Ship `fleet` from `@dotobokuri/fleet-console` with `fleet cli`, `fleet console`, and bare Claude Code passthrough.
- Update only `@dotobokuri/fleet-console`, stopping the local Console first when present.
- Publish a version-matched, bin-free `@dotobokuri/fleet-cli` migration package on each stable release so existing installs keep matching `@dotobokuri/fleet-console`.

#### Fixed
- A session launched on a Cursor model through the AI Gateway no longer hangs for three minutes after a tool call, and stops re-sending the whole conversation on the turn that follows one. Cursor numbers a connection's tool requests from zero and omits that number when it is zero, keeps writing a turn's own tail after the gateway has already handed the tool call to the session, and echoes that call back once the session answers it. So the gateway could not match an answer to a connection's very first tool call and closed the connection instead of holding it open; when it did hold one open, it read the tail as the model running ahead and dropped it, and read the echo as a fresh tool call it was still waiting on, so that turn never ended and the session sat idle until its stall timeout. The gateway now reads an absent request number as zero, treats the tail and the echo as the remainder of work it already handled, and holds a call the model starts just after a sealed batch to hand over on the next turn. Cursor Auto, Composer, and Grok sessions join the same single-connection path: they were held back on the reconnecting path on the assumption that Cursor ran their tools itself, and measurement showed they hand their tool calls to the session exactly as the other models do.
- A session launched on a Cursor model through the AI Gateway no longer stalls or announces that it is blocked when the model reaches for Cursor's built-in read, search, or shell tools. The gateway hands those operations to the session's matching tool, preserving its permission checks, and returns the result to the same Cursor connection. Search explicitly preserves Cursor's requested output mode; a read result whose whole-file metadata the caller did not expose is returned without inventing a complete-file success. Other built-in calls that cannot be represented without losing meaning remain refused, with deferred replacements pointing at tool search.
- Report why a Cursor turn failed instead of ending it with an empty reply. When Cursor rejected a request outright (an expired sign-in, a usage limit, a gateway in front of it answering with an error page), the reply body was not the streaming format the gateway reads, so nothing decoded, the turn simply ended, and Claude Code received a successful but empty assistant message with no stated cause. The gateway now waits for Cursor's response status before reading anything as model output, passes a rejection through with that status and Cursor's own message, and treats a turn that produced no output at all as a failure rather than a completed answer.
- A session launched on an OpenCode Go model through the AI Gateway no longer fails a tool call when the model invents an argument the tool never declared. Keys the tool's own schema does not list are dropped from the arguments that backend returns, because it accepts `strict: true` and then ignores it.
- A large enabled model roster no longer breaks the launch on Windows. Identity definitions moved off the command line into plugin files, so the number of models you enable no longer competes with the Windows command-line limit.
- Turning a model off in the AI Gateway selection now also stops it being served. The model list already advertised only the models left on, but a request naming a model by its exact id was still answered against the full catalog and billed to that provider's subscription.
- Refuse a launch on Windows when its arguments do not fit the command line Claude Code starts with, naming the size it reached and the limit it passed, instead of failing at process start with no explanation. Arguments passed through to Claude Code count toward that limit.

#### Removed
- Remove superseded OpenCode Go model generations (MiniMax M2.x, Qwen 3.5 to 3.7, GLM 5 and 5.1, Kimi K2.5 to K2.7) from the gateway catalog, keeping each lineup's current generation only.

#### Breaking Changes
- Resolve `FLEET_AGENT_CLI=claude` to the gateway launch instead of the retired Classic launch, so an environment that still exports the old value keeps starting.
- `@dotobokuri/fleet-cli` no longer provides the `fleet` command. It is now version-matched migration metadata that only depends on `@dotobokuri/fleet-console`, and npm does not expose a dependency's command in the global prefix. Running `fleet update` from an existing install carries you across on its own, but installing or updating that package directly with npm leaves no `fleet` on your PATH; install `@dotobokuri/fleet-console` instead.

### fleet-console

#### Added
- Record third-party benchmark evidence (CursorBench) in the gateway model catalog; Console-launched sessions rank judgment work by measured scores first, and each gateway agent identity description carries its benchmark figures.
- Set the opt-in provider spend order in AI Gateway settings: click providers into a numbered order, or set a provider's place from the toggle beside its own name, which carries its rank and summarises what the order does in one line on hover or focus. Saves from other gateway controls preserve the order, and it weighs quota use only, never model quality.
- Repository history now shows the author of each commit, marks the commits that carry a message body beyond their subject, and lets you choose whether commits are listed in topological or date order. The default is topological, so a branch and its commits stay contiguous.
- Read a roster model's capability class beside its name in AI Gateway settings: `flagship`, `standard`, or `light`. Hover it for one line on what the grade claims and how the host agent reads it when filling a seat.
- See `unclassed` on a routing alias instead of a blank, because what serves it changes per call and no single grade would be true of it.
- AI Gateway models can now be marked host-only: the model stays selectable from Claude Code's `/model` picker and the launch dropdown, but Fleet registers no delegation identity for it and leaves it out of the `gateway_models` roster.
- Start a Claude (Gateway) Operation on a specific Claude built-in alias or enabled Gateway model from the canvas launch menu, with a reasoning effort chosen before launch. Enabled models group under provider bands carrying the matching provider glyph, and show short model names without the provider prefix. Each menu is sized to the names it carries, and a submenu always opens outward from the box that owns it instead of folding back over the menu you opened it from.
- Reasoning effort is a track you drag or click along rather than a list of choices. Rungs a model does not offer keep their place on the ladder instead of being spaced out evenly, so a model that offers only low, high and max shows high where it actually sits. The first stop leaves the effort unset and launches on the model's own default, and it says so: that stop paints no fill at all and wears a dashed track, a hollow knob and a dashed underline, so leaving the choice to the model never reads as picking the lowest rung. The value beside the track takes its own tone per rung, deepening from the faintest readable tier into brass as the ladder climbs, and the rung under the pointer previews itself while the knob gently enlarges.
- In the canvas launch menu the track only sets the value and the model row still launches, carrying the effort you chose. The track opens from a handle on the row's right rather than from the row itself, so running down the model list no longer springs a submenu open on every row it passes; that handle carries a small gauge and the rung now loaded, so a closed row still says what it will launch with, and it follows its row while the list scrolls, closing once the row leaves view. Clicking the already-selected rung again, or pressing Enter on the track, launches with that model and effort straight away.
- Choosing Opus launches Claude Code's `opus[1m]` 1M-context alias. The dropdown still shows the plain `Opus` label, and a leftover bare `opus` selection is rewritten to `opus[1m]` when it is read and before launch.
- Let Terminal settings choose whether new Claude AI Gateway sessions append or replace Fleet doctrine, or use Claude Code's own prompt while keeping Fleet harness tools available.
- Start work from anywhere with Mod+J: type what the agent should do, pick the Theater and the model with its reasoning effort, and press Enter to open a Claude (Gateway) Operation that is already working on it. The composer sits in the centre of the Console viewport, and the shortcut opens it even while a terminal has focus rather than being swallowed by the Operation you are looking at.
- Choose the model and the reasoning effort inside the composer itself: the model from a popover that opens under the chip you pressed, the effort from the track beside the model chip. Choosing a model that does not offer the remembered effort clears it instead of launching on a rung that model rejects, a first-time Quick Launch starts on Opus, and the composer sends with a single round button whose esc hint reads as a hint rather than a control.
- Aim a launch at any Theater, not only the one on screen. Where it will land is read from the chip the composer opens with, and choosing another Theater switches to it and brings up the new Operation there. The last Theater you launched in, and the last model and reasoning effort you selected, are reused even after closing the composer without launching, so a repeat launch is one shortcut and one sentence.
- On Windows a prompt that does not fit the command line the agent starts with is refused before launch, with the number of characters to cut, instead of letting the launch die with no usable reason. The composer and its draft stay open, the whole command line is measured so a prompt that fits on its own is still refused when the arguments around it leave no room, and a prompt a Windows command shim would rewrite before the agent reads it is refused rather than launched as corrupted text.
- Remote access: serve the console on a chosen network interface over TLS and hand out access links. A link is a single `fleet://join?code=...` string carrying the address, a single-use credential, the certificate fingerprint, and the console's name in one encoded envelope, so a pasted link never spells a private address out on screen; the envelope is encoding rather than encryption, so treat a link as a secret. A created link states what it opens, and a full link warns that it opens a session able to run commands on this machine while a monitoring-only link carries no such line. The listener reopens on the port it first took, so the address a link handed out keeps working across restarts and a firewall rule made once keeps holding, and a browser that lands on that address is told what an access link looks like and where to paste it. Sessions open through a single-use grant on both the loopback and remote listeners, each listener judging only the requests that arrived on it, and WebSocket upgrades pass the same Host check as ordinary requests. Settings shows the live listener, the fingerprint, every unused link and open session with its own revoke, and an identity rotation that cuts off every paired device at once; turning remote access off closes the listener and ends every remote session immediately.
- A device that opens this console with an access link is paired with it for good. The link is still spent on first use, but the pairing outlives the connection: taking control back, an idle timeout, and restarting the console all end the session while the device keeps its way in and reconnects on its own. Removing the device ends that, and so does this console taking a new certificate, which it does when you rotate its identity or move it to a different bind address. A device that has not opened this console for about a year needs a fresh link. Settings lists the paired devices and which one is connected right now, with two separate actions: disconnect ends the current connection and leaves the device paired, remove revokes the pairing.
- Settings keeps the other consoles this one can reach, and the host chip in the command band switches between them. Pasting an access link confirms the certificate before saving anything, and from then on each host is named, checked, opened, and forgotten from one place. `Add host...` also sits in the host chip's own list, so pasting a link no longer means a trip to Settings, and closing that window while the certificate is still being checked cancels the whole add. The switcher lists the consoles already running on this machine, which take no link at all, including one inside a WSL distribution on Windows, named by the distribution it lives in. Opening the host box on a remote console unfolds your own computer's list, so you can go straight from one remote console to another; your console draws that list itself and the remote console never receives the addresses of your other machines.
- Only one device drives at a time, and the console says so instead of changing silently. When a device joins over an access link and takes control, a full-screen notice names it and offers to take control back; dismissing it leaves a bar that keeps the same control one click away. The terminal keeps showing live output as read-only rather than going blank, so the owner can watch the work continue, and opening the same terminal from a second window leaves the first one on that same read-only view instead of a dead screen showing an internal code. A second full access link is refused while a device is connected, and the refused link stays usable for later.
- Remote access introduces itself and is marked experimental wherever it is reached. The host chip carries a one-off highlight explaining that another device can reach this console, and opening the Remote access section in Settings walks it card by card: the consoles you can save, the address this console answers on, its fingerprint, and how an access link is handed out. Finishing the walkthrough retires the chip highlight, and the link step is skipped while the listener is off. The experimental mark appears on the Settings section header and its navigation entry, the saved-hosts list, the notice shown while another device holds control, and the page a browser lands on at the remote address; pasting a link states that how links and pairings behave can still change between releases.
- Cruise mode gains Station Keeping, an opt-in toggle in the command band's Cruise tray that spreads overlapping panels apart with minimal movement and then keeps every launch, drag, resize, and restore from overlapping; turning it off leaves panels where the discipline placed them, and the per-Theater choice also toggles from the command palette.
- Choose how often terminal panels you are not working in redraw, under Settings > Terminal > General. Balanced keeps the current 4 updates a second, Instant raises it to 20 for watching several panels at once, and Saving drops it to 2 on slower machines. The panel you selected always redraws at full speed.
- War Room Watch Deck cards carry always-visible minimize and close controls, and the staged panel gets its minimize control back. Minimizing in War Room takes the Operation off the deck rather than folding a window, so a panel minimized on the stage clears the stage too. Close still arms on the first press and confirms on the second.
- Minimized Operations get their own shelf. The War Room side bar collects them just above Dormant and returns one to the deck when you select its row, and they leave the deck, the status sections, and the staging queue meanwhile, so a minimized panel no longer takes the stage on its own. The Alt+S Status views separate minimized from dormant Operations the same way, in per-Theater recovery shelves that restore the former and resume the latter.

#### Changed
- A Claude (Gateway) Operation on a Codex or OpenCode Go model no longer resends its full tool catalog for the short suggestion generated after a visible turn. Claude Code explicitly forbids tool use in that internal request, so the catalog could not affect the result and only enlarged each request; the tools callable in ordinary agent turns are unchanged.
- A Claude (Gateway) Operation on a Cursor model now carries its tool instructions as an always-applied Cursor rule, alongside the copy at the head of the conversation. The rule travels with each turn, including the turn that follows a tool result, so the instructions reach the model at the point it chooses a tool rather than only once at the start.
- Session Analyst now runs on the Console's AI Gateway instead of a detected Claude Code CLI, so it starts whenever the Console is listening and no longer depends on an installed agent binary. Its picker lists the Claude aliases beside the gateway models you enabled in Settings, and the default selection is now `Sonnet` at `low` effort instead of `Opus [1M]` at `xhigh`; every other model stays selectable. The analyst also keeps no file or shell tools at all, so it can read only the observed session through its own analysis tools.
- Scuttlebutt's Admirals Tori, Bori, and Dori answer over the same AI Gateway, so chatting with them no longer needs an installed Claude Code CLI. Their model and response speed are unchanged, and they still reach only web search and web fetch.
- Cowork on a Wiki entry no longer asks which Agent CLI to use. It runs on the Console's AI Gateway, so the settings row offers a model and an effort only, and the default is `Sonnet` at `low`. A turn that stops without finishing now reports an error instead of waiting silently.
- The canvas context menu is roughly half as tall. Its icon-and-title masthead collapses into one line that names what you are launching into and carries the `Launch` label, the plugin name joins that line when a single plugin supplies the kinds, and every row is a single line. Measured on a four-row menu it comes to 288x168 instead of 340x307, and 115px of chrome ahead of the first action becomes 31px. Each Claude launch kind shows a short contrast beside its name, and its full one-line description opens next to the menu when you point at that row or move keyboard focus to it, rather than sitting under every row at all times; a kind that opens a submenu of its own keeps the description off screen because the submenu takes that space, and screen readers still read it on every row.
- Group release notes by the runtime a change is noticed in. What's new now shows Fleet CLI, Fleet Console, and Fleet Desktop tabs for a new release instead of splitting one feature across package-shaped tabs, and a change built in a shared package is listed under the runtime it surfaces in. Releases up to v1.51.0 no longer list what they grouped under `fleet-plugin` and `fleet-core`, so a version whose whole release note was internal work drops out of the version list. Section chips read in Korean when the Console language is Korean.
- Draw the Repository commit graph one row at a time, so a row spends width only on the lanes it actually draws and its commit text sits beside the graph rather than behind every lane the list ever opens. Branch and merge connectors follow right angles with rounded corners instead of diagonals. Branch, tag, and remote badges are bold labels with their own icon segment, tinted by the graph lane of the commit they sit on while the current checkout stays on the location tone, and each commit subject raises its Conventional Commit prefix above the rest of the line.
- Keeping the command band visible in fullscreen now gives it a place instead of floating it over your work: the stage starts below the band, so nothing is covered and the strip under it stays clickable. A band that only slid down for a moment still floats, because a temporary reveal gives the space straight back.
- The fullscreen command band also comes down when the pointer moves upward near the top edge, instead of only inside the topmost 8px. The wider approach is watched rather than claimed, so clicks and drags near the top of the canvas still reach the canvas.
- Choosing to keep the fullscreen command band visible is remembered for the next visit, and the command palette can turn it on or off while the band is hidden and its own controls are out of reach. The palette entry names the direction it will take, so it never reads as enable-only to someone who already turned it on.
- Gateway model identities now carry the Fleet plugin scope. An Agent Operation selects one as `fleet:<name>`, which is the spelling `gateway_models` reports.
- Read and edit a model's reasoning levels straight from its `effort` badge in AI Gateway settings: the badge now lays the whole ladder out in the row, marks which levels are offered, and takes a click on any level. The per-model levels disclosure and its summary count are gone, so a narrowed model no longer hides which levels survived behind an extra expand.
- Own both `fleet` and transitional `fleet-console` bins from one package.
- Prefer `fleet console` in help while keeping transitional `fleet-console`.
- Fleet Console now comes back the way you left it when you move between the local console and a remote one, or reload the page. The canvas mode you were in returns, whether that is Cruise, Tactical, or War Room, with Tactical remembered per Theater and War Room across all of them; panels you expanded stay expanded, because "the first time each Theater opens in a session" is counted against the browser tab session rather than the page load. A newly opened tab still starts in Cruise with its existing panels minimized, and the queue judgments made inside War Room stay tied to that visit rather than returning with the mode.
- "Show the screen guide" now replays every onboarding guide from the beginning: all feature tours and the first-run setup guide reset together, no matter which screen you are on.
- Switching between light and dark console themes now raises a single dismissible notice instead of one hint per terminal panel. The notice appears once at the bottom-right, dismisses itself after a few seconds, and still suggests relaunching running CLIs or running `/theme` to match.

#### Fixed
- A Claude (Gateway) Operation on a Cursor model no longer hangs for three minutes after a tool call, and stops re-sending the whole conversation on the turn that follows one. Cursor numbers a connection's tool requests from zero and omits that number when it is zero, keeps writing a turn's own tail after the gateway has already handed the tool call to the Operation, and echoes that call back once the Operation answers it. So the gateway could not match an answer to a connection's very first tool call and closed the connection instead of holding it open; when it did hold one open, it read the tail as the model running ahead and dropped it, and read the echo as a fresh tool call it was still waiting on, so that turn never ended and the Operation sat idle until its stall timeout. The gateway now reads an absent request number as zero, treats the tail and the echo as the remainder of work it already handled, and holds a call the model starts just after a sealed batch to hand over on the next turn. Cursor Auto, Composer, and Grok Operations join the same single-connection path: they were held back on the reconnecting path on the assumption that Cursor ran their tools itself, and measurement showed they hand their tool calls to the Operation exactly as the other models do.
- A Claude (Gateway) Operation on a Cursor model no longer stalls or announces that it is blocked when the model reaches for Cursor's built-in read, search, or shell tools. The gateway hands those operations to the Operation's matching tool, preserving its permission checks, and returns the result to the same Cursor connection. Search explicitly preserves Cursor's requested output mode; a read result whose whole-file metadata the caller did not expose is returned without inventing a complete-file success. Other built-in calls that cannot be represented without losing meaning remain refused, with deferred replacements pointing at tool search.
- Report why a Cursor turn failed instead of ending it with an empty reply. When Cursor rejected a request outright (an expired sign-in, a usage limit, a gateway in front of it answering with an error page), the reply body was not the streaming format the gateway reads, so nothing decoded, the turn simply ended, and the session received a successful but empty assistant message with no stated cause. The gateway now waits for Cursor's response status before reading anything as model output, passes a rejection through with that status and Cursor's own message, and treats a turn that produced no output at all as a failure rather than a completed answer.
- A Claude (Gateway) Operation on an OpenCode Go model no longer fails a tool call when the model invents an argument the tool never declared. Keys the tool's own schema does not list are dropped from the arguments that backend returns, because it accepts `strict: true` and then ignores it.
- A Claude Operation that leaves a workflow running in the background now stays marked as background work until that workflow actually finishes. One workflow call reports a single start but one finish per workflow agent, so the panel used to drop out of `BACKGROUND` the moment its first agent finished and then surface as an arrival in `AWAITING`. The badge now follows the session's live background-task list instead of a running tally. It holds in the other direction too: a named agent stays registered with the session after it finishes so it can be given more work, and the panel no longer mistakes that resident entry for work still in flight, so the Operation returns to `AWAITING` as soon as the turn ends instead of sitting in `BACKGROUND` with nothing running.
- Arrow keys move through the canvas context menu again: the first Down arrow enters the list without pre-selecting anything, Up and Down cycle past unavailable kinds, and Home and End jump to the ends. The menu also reports itself as a menu to screen readers, so its items are announced with their position in the list.
- Opening the canvas control menu near the bottom of the canvas no longer shoves the whole board upward. The board stayed shifted in Cruise, Tactical, and War Room alike until the page was reloaded; the canvas now keeps its position no matter where the menu opens.
- Right-clicking the canvas in Tactical view now offers every launch kind instead of showing them all greyed out with no reason. Launching from the canvas menu matches the sidebar and the launcher, which already launched in that mode, and Tactical keeps gating only canvas gestures such as panning, zooming, and drag-to-create.
- Show release-note entries that a repeated section heading used to hide. The v1.3.0 release listed `Fixed` twice, and only the first block was read, so three fixes were missing from What's new. Entries under a heading this Console version does not recognize are now kept as well, instead of being dropped without a trace.
- Load external plugins written in TypeScript on an installed Console instead of skipping them.
- Reach the rest of Repository history in repositories whose commit messages are large enough to fill the log read buffer. Such a page previously reported that the first commit had been reached, and the commit the read stopped inside was listed with missing details and then skipped by the next page.
- Command band toggles now look pressed while they are on. The state was announced to assistive technology but painted nothing on screen, so pressing one left no visible trace.
- A Claude (Gateway) Operation no longer fails to start on Windows when many gateway models are enabled. Identity definitions moved off the command line into plugin files, so the roster size no longer competes with the Windows command-line limit.
- Turning a model off in the AI Gateway roster now also stops it being served. Starting an Operation on a model left off was already refused, and the model list already hid it, but a request naming it by its exact id was still answered against the full catalog and billed to that provider's subscription.
- Segmented controls in Settings no longer stretch across their whole column. The Console port switch filled the row to hold two short buttons.
- Keep the guided feature tour card opaque in the Carbon, Maritime, and Whites themes, so the canvas and panels behind it no longer show through the guidance text.
- Keep the Repository changed-file list where it already sits when a file is opened. The diff now opens to the right of the list instead of taking the left side and pushing the list across the panel, so the next file is still under the pointer. Dragging the divider right widens the list, and left narrows it.
- Copying by dragging in a terminal panel now works while a full-screen agent CLI is running. A full-screen CLI takes the mouse over, draws its own selection, and reports the copy with `OSC 52`, which the terminal discarded, so a drag highlighted the text and pasting produced nothing. Clipboard writes the running program asks for are now applied; a clipboard read request is still refused, so a program cannot take what it did not put there.
- Watch Deck card previews now fill their card and grow their text with it, and a quick-look opens at actual size. The preview used to be centred when it overflowed sideways, so raising the deck density cut the start of every line; it now anchors to the frame's left edge, so whichever way it overflows every line still begins inside the frame and only the far right runs past it. The output fills the frame at every density instead of sitting under a band of empty backdrop, and because the frame drives the magnification, text grows as the card grows, roughly four times larger at the highest density than at the lowest, with the newest rows anchored to the bottom edge. Hovering a card used to magnify the card and the shrunken preview inside it together, so the same thumbnail simply got bigger and its terminal text stayed under reading size; the quick-look now cancels that magnification and stands at 1:1, putting the text at the size you read it at in the panel itself and showing as much of the latest output as the frame can hold. The fleet map's quick-look window reads at the same size.

#### Removed
- Remove superseded OpenCode Go model generations (MiniMax M2.x, Qwen 3.5 to 3.7, GLM 5 and 5.1, Kimi K2.5 to K2.7) from the AI Gateway roster, keeping each lineup's current generation only.

#### Breaking Changes
- Retire the Claude (Classic) and Claude (Native) launch kinds. New Operations launch as Claude (Gateway), and every existing Classic or Native Operation moves to Gateway once on first start, restored Operations inside the undo window included. The console keeps a one-time `state.json.classic-backup` beside its durable state before it rewrites anything.
- Remove the Carrier surfaces the Classic launch kind carried: the Carrier Streams panel and its companion, the Carrier settings section, and the Carrier deep-link target in Global Settings. Agent session status, attention, and title behavior are unchanged.
- Remove the Metaphor prompt setting. It only shaped the Classic prompt persona, so it no longer appears in Terminal settings and is dropped from stored settings on the next write.

### fleet-desktop

#### Added
- Fleet Desktop opens `fleet://` access links. Selecting one hands it to the console already running in the window, which checks it and adds the host; Fleet Desktop shows no dialog of its own.
- Choosing a remote console inside the console now carries through in Fleet Desktop. It confirms the host's live certificate against the saved fingerprint before the browser engine ever contacts it, exchanges the one-time credential for a session, and only then moves the window; a host that answers with a different certificate does not open. A saved console reopens without a fresh link afterwards, so one that took control back, went idle, or restarted is reachable again from the host list, and a new link is needed only when the console removed this device, took a new certificate, or this device stayed away for about a year. Opening a console that another device already controls explains that, instead of suggesting the access link was bad.

#### Removed
- Remote runtimes over SSH. Fleet Desktop no longer installs or supervises a Node runtime and a console on a remote host over SSH; add that console in Settings with its access link instead. Connecting to a local console, including the managed one Fleet Desktop installs, is unchanged.
- The Connect to Runtime menu and tray entries. Which console to open is chosen in the console itself, so the native menu no longer carries a second copy of that list.

## [1.51.0] - 2026-08-06

### fleet-cli

#### Added
- [fleet-cli] The thin launcher reads the same AI Gateway model selection file as Fleet Console (`~/.fleet/ai-gateway.json`) and serves `gateway_models` with live provider allowances probed in-process.

#### Breaking Changes
- [fleet-cli] `fleet` now launches Claude Code directly as a native child process with AI Gateway injection (the in-process Fleet MCP server over `--mcp-config`, one custom agent per exposed model and reasoning effort, the gateway doctrine prompt, and a loopback Anthropic-compatible endpoint), replacing the embedded two-pane terminal app. The carrier operation surface, the PTY/terminal interception layer, and the `--disable-cursor-sync` option are removed; `fleet auth` and `fleet update` remain, and unrecognized arguments pass through to Claude Code.

### fleet-console

#### Added
- [fleet-console] Show a one-time notice in the operation launch menu that Claude (Classic) is being phased out. It plays once, after the launch-kind intro walkthrough, anchored to the Classic item, and points new Operations at the AI Gateway (now generally available) or plain Claude while existing (Classic) Operations keep working.

#### Changed
- [fleet-console] Crop the War Room live preview above an agent CLI panel's bottom chrome. A Watch Deck card and its quick-look now fill the frame with streaming output instead of the input composer and status lines that never change while a run is working, so roughly seven more rows of live output stay in view at the same card size. A panel whose body streams all the way down, such as a plain shell, keeps every row.
- [fleet-console] Promote the Claude Gateway launch kind to official: the Operation launch menu and canvas context menu now label it `Claude (Gateway)`, and the feature-tour copy no longer calls it experimental.

#### Fixed
- [fleet-console] Reuse a plugin's compiled route bundle across Console server starts within one process, keyed by bundle content, instead of writing it to a fresh temporary directory and registering a separate module copy on every start.
- [fleet-console] Restore side bar resize in War Room mode. The War Room left column was the only mode without the edge handle, so its width could not be dragged and the handle double-click collapse was unreachable even though the column already shared the other modes' width and collapsed state; the handle is now the same shared control in every mode, and the width it sets carries across a mode switch.
- [fleet-console] Reach the canvas control menu from every War Room surface. Right-clicking bare space in the left sidebar, on the deck floor, between Theater bands, or on the queue rail background now opens the same launch menu the map zones already offered, and it names the Theater it will launch into, so the entry point no longer shrinks to a one-line band header at card density and vanish everywhere but the fleet map. Owned surfaces keep their menus, the dormant shelf still opens nothing, and collapsing the sidebar dismisses the menu it opened.
- [fleet-console] Keep the sidebar and Activity Rail toggles in the command band outside the Operations screen, where pressing one returns to Operations and opens that panel.
- [fleet-console] Stop the sidebar and Activity Rail keyboard shortcuts from changing the stored panel state on screens that show neither panel.
- [fleet-console] Launch the Console daemon and update worker with the OS certificate store trusted by default (`NODE_USE_SYSTEM_CA=1`), matching the Desktop sidecar, with `FLEET_CONSOLE_NO_SYSTEM_CA=1` as the opt-out.
- [fleet-console] The OpenCode Go card in Usage limits now shows its session, weekly, and monthly meters in Fleet Desktop instead of reporting that no local usage log exists; the built bundle had lost the `node:` prefix on `node:sqlite`, so reading the local OpenCode CLI log failed and was silently reported as absent.

#### Removed
- [fleet-console] Remove the "Reduce panel motion" toggle from Settings > General. Panel motion now follows only the operating system's Reduce Motion setting, and a stored preference is dropped without affecting other settings.

### fleet-desktop

#### Fixed
- [fleet-console] Trust the OS certificate store by default in Desktop-managed Node processes (the Console sidecar and the Console installer), so Codex usage and Codex gateway calls work on networks with TLS-inspecting proxies. Set `FLEET_CONSOLE_NO_SYSTEM_CA=1` to opt out; an explicitly set `NODE_USE_SYSTEM_CA` value is respected.

### fleet-plugin

#### Added
- [fleet-console] Add a Wire log toggle to AI Gateway settings, off by default, which records the full gateway wire (prompts, tool schemas, model output, and tool arguments) to a local log under the Console data directory that rotates at 16 MiB with one backup. Turning it on applies to the next request and turning it off stops the next write. The setting overrides `FLEET_GATEWAY_WIRE_LOG`, so turning it off stops logging even where that variable is set.
- [fleet-console] Drag the divider between the file list and the diff in the repository commit and compare inspectors, and switch a compare result between list and tree view. The dragged width is remembered, the diff column keeps a readable minimum, and the list/tree choice is shared with the commit inspector so the same files keep one representation across both surfaces. A narrow inspector still stacks the two panes vertically instead of splitting them.

#### Changed
- [fleet-console] Store the AI Gateway model selection as one Fleet-wide file at `~/.fleet/ai-gateway.json`, alongside the global settings file, instead of a per-Console-channel plugin slot. An existing selection is carried over on first use, so the models, per-model reasoning levels, Cursor diagnostics, and wire-log switches stay as they were. Development and published Consoles now share one AI Gateway selection; a Console started with an explicit data-root override keeps its own.
- [fleet-console] A Claude (Gateway) launch now refuses to start when the model-discovery cache cannot be written, instead of warning and starting with a stale model roster.

#### Fixed
- [fleet-console] Hide the tool status line in a carrier stream's activity card when the running tool reports no status, instead of leaving the literal `{status}` placeholder on screen.
- [fleet-console] Surface TLS certificate failures in the quota panel as a dedicated "Certificate verification failed (<code>)" strip instead of a generic provider error, and include the transport cause code in AI gateway 502 error messages.
- [fleet-console] Keep a long commit subject on a single line in the repository history log and in the inspector's detail header, with the full text available as a tooltip. A narrow panel used to wrap the subject onto a second line, which crowded the log and pushed the row out of step with the graph lane it shares a height with.
- [fleet-console] Stop the inspector's file list from overflowing onto the diff pane. The file column now shrinks to its own width, so long paths scroll inside the list instead of being painted over by the diff.

### fleet-core

#### Added
- [core-ai-gateway] Offer Cursor GPT-5.6 Sol through the AI Gateway, with the low through max reasoning ladder Cursor serves, a measured 272000-token context window, and billing against the Cursor API usage pool.
- [core-ai-gateway] Add an explicit in-process wire log target that takes precedence over `FLEET_GATEWAY_WIRE_LOG`, so a host can arm or disarm diagnostic logging without a restart. Only an override target rotates, at its byte limit with one backup; the environment path keeps its unlimited-append behaviour.
- [core-ai-gateway] Record each gateway model's provider-stated capability class (`flagship`/`standard`/`light`) in the model catalog and report it through routing constraints and the `gateway_models` roster; routing aliases stay unclassed and a service-tier sibling must match its base class.

#### Changed
- [fleet-admiral] Assign gateway workflow stages by a judgment/mechanical regime split: judgment roles (decompose, propose, decide, judge, synthesize) keep to the highest reachable capability class and shrink or repeat-seat a thin fan instead of seating a lighter class, while mechanical fans keep the allowance-distribution default; a recorded E4 judgment-floor exception covers the case where no class-eligible identity is reachable, and each gateway agent description now states its model's class.
- [fleet-admiral] Rename the gateway stage skills to `workflow-architecting`, `workflow-research`, `workflow-implementing`, and `workflow-review`, and teach each skeleton which of its stages are judgment seats versus mechanical fans.
- [fleet-admiral] Trim always-on gateway doctrine that restated the Claude Code harness: directory doctrine loading defers to the harness's automatic CLAUDE.md surfacing, Mission Anchor recall lines fire only at re-entry points instead of every decision boundary, the pre-engagement clarification gate is scoped to product-intent ambiguity, and the deferred-tool restatement is removed.
- [core-ai-gateway][fleet-admiral] The Anthropic-compatible AI Gateway router, the provider quota probes, and the gateway launch environment moved into host-neutral packages so Fleet Console and Fleet CLI share one implementation.

#### Fixed
- [core-ai-gateway] Drop image parts only for OpenCode Go DeepSeek V4 requests to its text-only Chat Completions endpoint, preventing `image_url` schema errors while leaving the generic Chat adapter unchanged.

#### Removed
- [fleet-admiral] Drop the measured roleFit table from the `gateway_models` roster and the workflow doctrine; the catalog capability class is the roster's single quality signal, and allowance decides only among class peers.

## [1.50.1] - 2026-08-05

### fleet-core

#### Fixed
- [core-ai-gateway] A Codex-backed session no longer dies with `400 Unknown parameter: 'input[N].reasoning_content'`. Assistant reasoning is kept as replay metadata for the Chat Completions backends that require it, but it was also being written into the OpenAI Responses request body, where an unrecognized input property rejects the entire request, so every turn after the model's first thinking block failed. That metadata now stays provider-private on the Responses path.

## [1.50.0] - 2026-08-05

### fleet-core

#### Added
- [core-ai-gateway] Show OpenCode Chat Completions and Cursor reasoning as Claude Code thinking, with DeepSeek V4 reasoning history preserved across tool turns.

## [1.49.0] - 2026-08-05

### fleet-plugin

#### Fixed
- [fleet-console] Keep AI Gateway response streams active during silent provider reasoning intervals.

### fleet-core

#### Added
- [core-ai-gateway] Stream OpenAI Responses reasoning as Anthropic thinking blocks for Claude Code.

#### Changed
- [fleet-admiral] A gateway session no longer carries the bundled Claude API reference skill. Its trigger fires on Claude model names and on LLM work in general, so it activated readily on the gateway path even though the models a gateway session drives are the third-party backends the gateway brokers, and its body is re-sent every turn once loaded. Fleet now launches the gateway path with that skill switched off, which removes it from the host session and from every subagent it spawns, including the injected gateway model identities. Ordinary Claude sessions keep the skill.
- [fleet-admiral] Gateway hosts now budget bulk parallel work against provider allowances instead of retreating to their own. The roster's pressure verdict outranks raw usage percentages, so a provider reported as healthy is used whatever its percentage reads; branches spread evenly across eligible providers counted per provider rather than per exposed model; a sole remaining provider carries the whole fan-out; an allowance that cannot be read is left out of the split without being treated as exhausted; and role-fit token and tool-call efficiency no longer reads as quota drain. Cross-model verification stays available at one session-lineage seat per verify stage, sized before the roster is read, so a shrinking provider pool can no longer enlarge it.

#### Fixed
- [core-ai-gateway] A Cursor conversation no longer keeps running blind once it fills the model's context window. Claude Code's occupancy meter reads a projection that saturates at that window, so past it every turn reported the same full number and the client could not see itself reaching its own compaction threshold; one measured session sent 31 consecutive requests at a saturated meter before compaction finally fired, minutes late. The gateway now refuses the next turn from the count Cursor itself reported, carrying the 413 that starts reactive compaction, and lets the compacted retry through.
- [core-ai-gateway] Emit Anthropic-compatible SSE keepalive comments for gateway-facing response streams.

## [1.48.0] - 2026-08-05

### fleet-console

#### Added
- [fleet-console] Shelve dormant Operations below the War Room queue. The left column keeps its four living sections and gains a collapsed shelf underneath that always shows how many Operations are parked, so restored work stops disappearing from the mode; the Watch Deck and the fleet map stay live-only, and selecting a shelved Operation resumes it in place without leaving War Room or switching Theater.

#### Changed
- [fleet-console] Make right-click act on every War Room surface. A Watch Deck card, a fleet map marker, a queue rail row and a sidebar chip now open the same Operation menu the other modes already offer, reachable by the Context Menu key and Shift+F10 as well, and empty space is owned by position: right-clicking inside a Theater band or map zone launches into that Theater and names it, while space outside every Theater opens nothing instead of a menu whose actions were all disabled.

#### Fixed
- [fleet-console] Give one Operation one activity colour everywhere in War Room. Idle now reads the same on the Watch Deck card, the fleet map marker, the sidebar and the staged frame instead of falling back to the no-status grey on the deck and the map, an idle arrival is promoted to awaiting by one shared rule so a card can no longer disagree with its own marker, and background gains a hollow marker on every surface so it stays distinct from running and its sidebar marker stops resolving to transparent.

### fleet-plugin

#### Added
- [fleet-console] Expand an AI Gateway model in Settings to choose which reasoning levels it is offered at; each chosen level becomes one delegation identity, and the model's summary chip counts them.
- [fleet-console] Compare two commits directly inside repository History: hover or focus a commit row and pin it with the swap glyph, use the inspector action, or Shift-click a pair; the pinned base stays visible as a toolbar chip, picks auto-order older to newer, and the result opens in the detail dock with merge-base, file list, per-file diff, and swap.
- [fleet-console] Stash rows now open the stash commit in the inspector instead of sitting disabled.

#### Changed
- [fleet-console] Narrowing a model's reasoning levels changes only the identities offered for delegation. The gateway keeps advertising the model's full ladder, so the /model picker and in-session /effort are unaffected.
- [fleet-console] The separate Compare view is retired: branch and tag rows' compare actions and context menus land in the same in-History result dock, tag rows gain the compare action, and the ref filter chip shows a short name with the full refname in its tooltip.
- [fleet-console] History is pinned as the repository's checkout-independent record: only the off-checkout text dimming and the uncommitted row follow the active checkout, dimmed rows carry a "Not in current checkout" tooltip, and the commit count badge explains the legend.
- [fleet-console] Manual repository Sync now reports its outcome: classified failure toasts with a failure dot on the button, and a success summary with new, updated, and pruned ref counts; automatic sync and throttle skips stay silent.

#### Fixed
- [fleet-console] The AI Gateway settings list no longer offers reasoning levels the Anthropic wire cannot carry, so a model such as Codex GPT-5.6-Sol now reads "effort low-max" instead of advertising an unusable "ultra" level.
- [fleet-console] The commit detail dock no longer collapses its main pane to zero width when the history pane is narrower than the fixed file column; it stacks vertically instead.

### fleet-core

#### Added
- [core-ai-gateway] Withhold a skill body a gateway model's context window cannot afford, replace it with a stub naming its size, and drop that skill from the listing from then on so the model stops spending a turn loading what it will never receive. The rule measures size rather than names, because skills ship inside the client binary, change every release, and are not on disk until they load; a window of 1M or more keeps a payload it can afford while every smaller one refuses it.
- [core-ai-gateway] `FLEET_GATEWAY_WIRE_LOG` now records what a Cursor turn actually puts on the wire: `cursor.wire.plan` carries the replay size and root count, and `cursor.wire.blobfetch`, `cursor.wire.blobsummary`, and `cursor.wire.checkpoint` report each blob the server pulls back, the per-run totals, and how far the gateway's own token estimate sits from the count Cursor reports. Cursor keeps no blob between turns, so a turn re-uploads its whole replay and this is the only way to see that cost.

#### Changed
- [fleet-admiral] Gateway doctrine now pins an explicit model for every run that leaves the host, and spends the session's own allowance last instead of first. The `workflow` skill owns two ordered gates - an Execution Surface Gate and a Model Pin Gate - so surface choice and model assignment are no longer duplicated in the always-on system prompt.
- [fleet-admiral] Leaving a run unpinned is now a recorded decision rather than a silent default. Only three labelled exceptions may spend the session's own model - `E1` cross-lineage verification, `E2` last resort, and `E3` empty roster - and an allowance that could not be read is not evidence of exhaustion.
- [fleet-admiral] The `gateway_models` guidance separates lineage from allowance instead of conflating them: `homolineage` marks the blind spots an identity inherits, while the provider entry marks whose subscription it bills. Independence is judged against the subject under examination, not against the host session.
- [fleet-admiral] The gateway_models roster reports effortLadder and agentTypes as the levels this session actually registered, and its revision moves when a model's exposed levels change.

#### Fixed
- [fleet-wiki] Wiki retrieval now tokenizes non-Latin topics, so a multi-word Korean query reaches per-token matching instead of returning nothing from `wiki_briefing`, `wiki_query`, and `wiki_resolve`.
- [core-ai-gateway] A gateway turn that exceeds the model's real context window is now refused as HTTP 413 whose message names the context window, the only shape Claude Code arms reactive compaction from, so the run compacts and continues instead of ending with no compaction attempted.
- [core-ai-gateway] A Cursor conversation is no longer refused at roughly half of its model's context window. The replay carried a local 512 KiB size cap that no upstream limit backed, and its refusal was an HTTP 400 that Claude Code cannot start reactive compaction from, so a session ended with no compaction attempted; a measurement against Cursor accepted 857987 bytes across 117 replay roots without refusing, so the model's context window is now the only ceiling and it already answers with the 413 that does start compaction.

## [1.47.0] - 2026-08-04

### fleet-console

#### Added
- [fleet-console] Triage Watch Deck cards now magnify into a readable quick-look after a 400ms hover dwell, scaling the live preview to legible text without resizing the underlying terminal; keyboard focus opens it instantly, edge cards expand inward, and clicking still stages the operation.
- [fleet-console] Offer the canvas control menu on right-click in triage mode, placed at the cursor with launch actions disabled.
- [fleet-console] Triage mode gains a persisted SPOTLIGHT toggle in the bottom rail (default on): turning it off stops finished runs from auto-staging and keeps a sustained arrival pulse on their Watch Deck cards until reviewed, and queued arrivals that cannot take an occupied stage now pulse in the rail in both states.
- [fleet-console] Zoom the triage Watch Deck with the bare mouse wheel, pinch, or Ctrl/Cmd+wheel (0.35x-2.0x, global persistence; Shift+wheel scrolls the card grid); zooming out past the card-legibility threshold dissolves the deck into a fleet map with one status-colored marker per operation, and a Density chip on the triage rail shows the zoom and cycles presets.
- [fleet-console] Bring the triage fleet map to life inside its theater zones: bare-wheel zoom with Shift+wheel grid scroll, collinear or geometry-less fleets scatter deterministically across each zone instead of collapsing onto a line, every marker keeps its operation name visible (idle names drop to the tertiary text tier), waiting markers - including idle arrivals, matching the queue vocabulary - pulse with an aurora ring (deferred markers stay still; reduced motion falls back to a static ring), and running markers drift on slow deterministic paths that pause on hover or under a staged panel.
- [fleet-console] Make War Room read the same way at every density: the left column drops its queue caption and empty-state line so the awaiting, running, background, and idle sections always stand - each one reporting its own count and its own "none" - while the fleet map drops the dashed zone ring for a Theater status marker set in the middle of its zone, keeps every zone on its own slot so panel status changes never shuffle the plate, drifts every marker in place (running wide and quick, the rest narrow and slow) and clear of both the Theater marker and each other's labels, opens the card Quick-Look at full reading size beside a hovered or focused marker without stealing the pointer from it, lets a marker be dragged to move its panel, and morphs panels into the spots their markers will take when the density threshold is crossed - and back out of them on the way up, with reduced motion skipping the flight entirely.
- [fleet-console] Turning the War Room spotlight off now stops every automatic staging, including the hand-off to the next queued panel once the staged one goes idle; only an explicit pick stages a panel.
- [fleet-console] Add Show the screen guide to the Help menu, which replays the guide for the screen in front of you. It restores only the narrowest guide anchored on that screen, so replaying inside War Room does not restart from the mode introduction, and it stays disabled with the reason when the screen has no guide to replay.

#### Changed
- [fleet-console] Toggle the Settings screen with the command-band Settings button: pressing it again while on Settings returns to the previous page, or to Operations when Settings was opened directly.
- [fleet-console] Triage is now one global mode across every Theater: all theaters stay mounted while triage is active, the Watch Deck splits into Theater bands covering all live Operations, and staging an Operation from another Theater brings it up without switching Theaters (exit returns to the Theater that last held the stage). The sidebar becomes a global list in the familiar status-section chip grammar with full Theater names, and zooming out turns the deck into one fleet map where each Theater is a circular operational zone on a shared chart.
- [fleet-console] Replace the command band's six map controls with one Cruise / Tactical / War Room mode switch that always names the active canvas mode, plus a tray holding only that mode's own tools: view reset and fit-all for Cruise, the grid, columns and rows layouts for Tactical. The three mode names are product terms and stay in English in every locale, so the band, mode curtains, empty-state hints, command palette and shortcut list all use the same word. Every mode change draws the same curtain, headed with the mode it is switching to, and returning to Cruise now draws it too instead of slipping back unannounced.
- [fleet-console] Move the triage Spotlight and deck density controls out of the canvas rail into the War Room tray, so every mode keeps its own tools in the same place on the band. Both are icons now; the density control keeps its zoom readout and drops its label.
- [fleet-console] Replace the single War Room walkthrough with one guide per reworked screen. The canvas mode switch and its per-mode tray are introduced on first visit; War Room explains its queue rail, stage, watch deck, deck density and spotlight, and how to leave with every panel back at its coordinates; the War Room queue sidebar explains that it lists waiting work in staging order, crosses every Theater, leaves dormant panels out, and lets a click jump the queue. Only one guide plays per visit, so entering War Room no longer risks a single unbroken run of steps.

#### Fixed
- [fleet-console] Triage Watch Deck cards now use the same status vocabulary and ordering as the sidebar STATUS axis, so an idle operation no longer reads as awaiting, and background operations sort consistently between the two surfaces.
- [fleet-console] Close the canvas control menu when left-clicking the map, regardless of whether it was opened from the map or the sidebar.
- [fleet-console] Stop a layout button from silently dropping War Room mode: the layout controls now exist only while Tactical is the active mode, so pressing one can no longer end triage without warning.
- [fleet-console] Stop offering Reset canvas view in War Room mode, where the viewport transform is disabled and the control did nothing when pressed.
- [fleet-console] Show the War Room guide even when nothing is waiting. It used to hang on a staged panel that does not exist on an empty queue, so entering the mode with no waiting work explained nothing at all; the guide now opens on the queue rail and simply omits the stage step until something is staged.

### fleet-core

#### Changed
- [fleet-admiral] The gateway model roster now names the agent that runs each model, one name per reasoning level it supports, so a stage can be assigned by that name instead of by a model id that a name field rejects. Each model is grouped under the provider whose allowance it spends, and two fields that no longer carried meaning were removed.

#### Fixed
- [core-ai-gateway] Gateway responses from Kimi and OpenCode's Anthropic-wire models now carry the model id the session requested rather than the provider's own wire id, so resuming such a session restores its model instead of reporting it as unrecognized.

## [1.46.0] - 2026-08-03

### fleet-cli

#### Added
- [fleet-cli] Extend `fleet auth login` and `fleet auth logout` to accept `kimi|opencode`, and list both providers in the mission-control authentication panel.

### fleet-console

#### Added
- [fleet-console] Triage mode now shows a live Watch Deck when the queue is empty: every non-dormant Operation appears as a card with its activity state and elapsed time since the last activity change, kinds that render a panel body get a live scaled-down preview while other kinds show their latest status line, and clicking a card raises that Operation to the stage with a ghost-flight animation. Queued arrivals pulse on their card briefly before growing to the stage so the previous clear's landing flash stays visible.
- [fleet-console] Add a Background operation activity state that keeps an operation visibly active while background subagents or workflows outlive the finished turn, with a hollow warn beacon, a sidebar STATUS slot, and localized labels.
- [fleet-console] Codex search now matches entry body text and shows highlighted context snippets in the result list.
- [fleet-console] Codex reader gains back/forward navigation history, and the last read entry and scroll position are restored per Theater after a reload.
- [fleet-console] The Codex split view shows a collapsible document outline with scroll-tracked current section.
- [fleet-console] Codex entry cards show relative update times, and the list gains newest/name sorting and tag-chip filtering.
- [fleet-console] The command palette lists Codex wiki entries so a document can be opened from anywhere, expanding the Codex rail automatically.
- [fleet-console] The Codex navigator shows a wiki health strip summarizing the last drydock run, conflicts, and pending reviews, with details in a popover that keeps the open document intact.

#### Changed
- [fleet-console] Move the system controls into a persistent command-band cluster: the gear opens Settings in one click and the "?" menu carries What's New, keyboard shortcuts, the update action, and GitHub links, so they stay reachable on every route and while the sidebar is collapsed. The sidebar-footer System Menu and its brand foot are removed, and a pending update now shows as a status dot on the gear.

#### Fixed
- [fleet-console] Dock the command band map controls (Formation view, Triage) to the left control cluster with a hairline divider when the sidebar is collapsed, instead of leaving them floating at the stale sidebar width; the anchor swap glides over 200ms and honors reduced motion.
- [fleet-console] Codex conflict list rows now open their detail view, and code copy buttons work in drydock and schema documents.
- [fleet-console] The Codex reader ignores stale responses during rapid navigation and escapes patch metadata before rendering.

### fleet-plugin

#### Added
- [fleet-console] The Repository Compare view now prefills the base with the repository default branch (origin/HEAD, falling back to main/master) and the head with the current branch, then runs the comparison automatically on entry; a swap button exchanges base and head.
- [fleet-console] Branch rows in the Repository panel gain a hover compare action and a context menu (compare with current branch, compare with base) that open the Compare view prefilled and already run.
- [fleet-console] Quota windows now state their reset period with its provenance (provider-stated or catalog knowledge), mark the Cursor total as an aggregate of its pools, and carry Kimi absolute usage counts, so consumers can compare allowances that reset on different clocks.
- [fleet-console] The terminal plugin reports each session's latest sanitized transcript line through the new statusDetail channel; triage Watch Deck cards fall back to this line when a panel has no live preview body.
- [fleet-console] Track background subagent work through new Claude spawn and stop hooks so agent sessions expose backgroundPending until the pending count drains, a 30-minute TTL expires, or the session leaves the live lifecycle.
- [fleet-console] Generalize the Terminal model-auth card into "API keys for AI Gateway" with per-provider rows, adding OpenCode Go sign-in and sign-out next to Kimi.
- [fleet-console] Show an OpenCode Go card in the Usage limits panel with session, weekly, and monthly meters computed from the OpenCode CLI's local usage logs against the published Go caps, with an explicit note that the figures are local-observed spend (usage from other machines or Fleet's gateway is not counted).

#### Changed
- [fleet-console] Rename the Settings "Carriers" section title to "AI Classic" in both locales.

#### Fixed
- [fleet-console] Stop terminal device-query responses from being typed into the shell prompt when a Shell panel is reopened and its scrollback is replayed; input now arms only after replay is fully parsed, and the server answers queries only while no acknowledged client is attached, so each query gets exactly one answer.
- [fleet-console] The Compare run button no longer clips off-screen at the default rail width; controls wrap on narrow panes and long ref labels ellipsize.
- [fleet-console] Repository hunk endpoints now pass --no-ext-diff and --no-textconv, so repository-local diff drivers and textconv commands can no longer execute from browser-triggered diffs.

#### Removed
- [fleet-console] Remove Cursor Agent from the Terminal plugin analyst and agent-launch catalogs and from CLI detection, matching the SDK provider removal.

### fleet-core

#### Added
- [fleet-admiral] gateway_models now derives per-window verdicts on the server (a normalized cadence, burn pace against the window's own clock, projected exhaustion, recovery cost, and an ok/elevated/critical pressure label), and the workflow doctrine ranks allowances by that verdict instead of comparing raw percentages across windows that reset on different clocks.
- [core-ai-gateway] Add OpenCode Go as an AI Gateway provider serving 22 subscription models over their native wires: Anthropic-native models pass through `/zen/go/v1/messages`, OpenAI Responses models reuse the Responses adapter against `/zen/go/v1/responses`, and Chat Completions models stream through a new canonical Chat Completions adapter.
- [fleet-admiral] Validate OpenCode Go API keys with a live Anthropic-compatible probe before storing them, alongside the existing Kimi validation.

#### Fixed
- [core-ai-gateway] Strip JSON Schema `format` hints (such as `format: "uri"` on WebFetch's `url`) from OpenAI strict tool schemas, and apply the same strict cleanup to `$defs` subschemas, so a format value outside OpenAI's accepted set no longer fails the whole request with a 400 schema error on the Codex path.

#### Removed
- [core-unified-agent] Remove the Cursor ACP provider from the unified Agent CLI SDK: the `UnifiedCursorAgentClient`, its spawn configuration, and the cursor model registry are gone, and the analyst `cliId` narrows to the remaining claude and codex backends. Cursor remains available through the standalone AI gateway adapter.

## [1.45.0] - 2026-08-03

### fleet-cli

#### Removed
- [fleet-cli] Remove Codex CLI from the Fleet launch catalog.

### fleet-console

#### Removed
- [fleet-console] Drop the `@fleet-console/sdk/launch` subpath; `LaunchContext` now ships from `@fleet-console/sdk/plugin`.
- [fleet-console] Remove Codex Agent Operations while preserving legacy session data and Fleet Wiki Codex.

### fleet-plugin

#### Fixed
- [fleet-console] The File Explorer git badges now run git with the same environment denial the Repository panel already used, so an inherited askpass program, terminal prompt, or unknown transport helper cannot run from a badge refresh.
- [fleet-console] Session Analyst routes accept a JSON request whose `Content-Type` carries a charset parameter or uppercase media type, matching the other terminal routes.
- [fleet-console] The AI Gateway now finds the Cursor subscription token on Linux and Windows, not only macOS. It reads the platform auth file (`%APPDATA%/Cursor/auth.json` on Windows, `$XDG_CONFIG_HOME` or `~/.config` under `cursor/auth.json` on Linux) when the macOS keychain is unavailable, so Cursor model calls no longer fail with a 401 that reported no subscription token.
- [fleet-console] The AI Gateway now honors `CODEX_HOME` when it looks for the ChatGPT subscription token, so a relocated Codex home no longer makes Codex model calls fail with a 401 that reported no subscription token while the Usage limits panel found the same login.

#### Removed
- [fleet-console] Remove Codex Agent Operation launch, resume, capture, and activity integration from the Terminal plugin.

### fleet-core

#### Added
- [core-ai-gateway] Add Cursor and Codex credential procurement as shared package API, so every caller resolves a subscription token through one platform-aware implementation instead of its own copy.

#### Fixed
- [fleet-wiki] A queued patch keeps tags containing a newline, quote, or backslash intact, because the inline frontmatter array is now decoded with the same escaping its writer applies.

#### Removed
- [fleet-admiral] Remove Codex CLI profiles, injection, and plugin registration from Admiral.

## [1.44.1] - 2026-08-02

Release v1.44.1

## [1.44.0] - 2026-08-02

Release v1.44.0

## [1.43.0] - 2026-08-02

### fleet-core

#### Changed
- [fleet-admiral] Stop disabling Claude Code's built-in agents in a gateway session. The gateway model agents now sit alongside them instead of replacing them, so delegation to the session's own model is available again.
- [core-unified-agent] Drop live Claude/Codex e2e suites from the default test run and keep the same contracts under mocked unit coverage.

## [1.42.0] - 2026-08-02

### fleet-console

#### Added
- [fleet-console] Let a plugin mark a companion panel as unavailable for a given Operation, so the panel, its keyboard shortcut, and its shortcut-help entry all disappear together for that Operation.
- [fleet-console] Describe each Claude launch kind with a one-line summary in Canvas Controls, so the difference stays readable every time you choose.

#### Changed
- [fleet-console] Walk the three Claude launch kinds in menu order on the first Canvas Controls open, replacing the single Claude Gateway spotlight so Native and Classic are introduced alongside Gateway.

#### Fixed
- [fleet-console] Keep the feature tour progress count within its total when the next button is pressed repeatedly before the card advances.

### fleet-plugin

#### Added
- [fleet-console] Add a Claude (Native) Canvas Controls launch that reuses Claude Code with wiki skills, Console hooks, and wiki MCP only. The Operation carries no Carrier Streams surface, because the session never receives carrier tools.

#### Changed
- [fleet-console] Drop the Carrier Streams panel, its STREAMS handle, the live sortie ribbon, and the Alt+C shortcut from Claude (Gateway) Operations, whose sessions never receive carrier tools and so could never fill that panel.

#### Fixed
- [fleet-console] Drop the (Classic) suffix from the Codex launch entry, which has no Native or Gateway variant to contrast with.

### fleet-core

#### Added
- [fleet-admiral] Introduce a console-only `claude-native` Agent CLI with `native` doctrine that skips the Admiral system prompt and carrier/gateway tools.
- [core-ai-gateway] Add opt-in gateway wire logging behind `FLEET_GATEWAY_WIRE_LOG`, which records the inbound tool catalog, provider request bodies, and every response event to one file so provider behaviour differences can be diagnosed. It stays off unless the variable names a path.

#### Changed
- [fleet-admiral] Hand work to an Agent by default under gateway doctrine and reserve staged workflows for when you ask for one.
- [fleet-admiral] Read the live gateway roster before every delegated run and pick the model by measured fit and provider allowance instead of reusing the session model, so workflow stages spread across models rather than concentrating on one.
- [fleet-admiral] Describe execution in gateway doctrine as a run that returns its result, now that every exposed model is already a named Agent in the session, and drop the `<system-reminder>` preamble that existed to explain background job completion signals.
- [fleet-admiral] Treat an empty or missing return as the normal shape of a failed gateway run, and forbid absorbing a twice-failed run into the host session instead of reporting it.

#### Fixed
- [fleet-admiral] Deny built-in Claude Code agents with legacy and current selectors while simplifying gateway custom agent names.
- [core-ai-gateway] Gateway-backed models no longer fill in optional tool arguments they were never asked to send, so a subagent pinned to a gateway model is no longer rerouted to a Claude model behind your back, and a file read no longer fails on a fabricated argument.

## [1.41.0] - 2026-08-02

### fleet-cli

#### Removed
- [fleet-cli] Remove the `fleet console` and local-only `fleet desktop` subcommands so Fleet CLI no longer depends on or relays into the Console package; use the standalone `fleet-console` binary instead. `fleet update` still stops a running Console beforehand by resolving the independent `fleet-console` executable on PATH, without restoring a package dependency.

### fleet-console

#### Added
- [fleet-console] Guide the first Claude Gateway launch from Canvas Controls while keeping Triage guidance tied to entering Triage mode.

#### Changed
- [fleet-console] Keep agent CLI session capture data only in the Console state file instead of a separate captures directory.
- [fleet-console] Migrate existing capture files into the Console state file on startup and then remove the leftover captures directory.

#### Fixed
- [fleet-console] Resolve npm/pnpm global bin symlinks (and macOS `/var` vs `/private/var` aliases) before the CLI direct-run guard so installed `fleet-console` binaries actually enter `main()` instead of exiting silently.

### fleet-plugin

#### Added
- [fleet-console] The Ledger panel charts device-wide daily cost above the per-CLI totals, covering the whole selected window so days without usage still read as zero, with hover and focus details per day plus peak and daily-average lines, and stays hidden when the selected window covers less than two days.
- [fleet-console] The Ledger daily chart states that each session's cost counts on the day it was last active, so a session spanning midnight is read correctly.
- [fleet-console] Ledger skips usage records whose timestamps cannot form a four-digit local date, so malformed data degrades the report instead of breaking the panel.
- [fleet-console] Show git status badges (M/U/D) on File Explorer rows, refreshed on mount, file-watch events, and manual refresh.
- [fleet-console] Step the Session Analyst composer Escape key through three layers: dismiss the slash-command listbox, clear the draft, then close the Analyst companion cluster while leaving other companions untouched.
- [fleet-console] Inject a theme-token base stylesheet into served Session Analyst artifacts, exposing --fleet-canvas/surface/ink/muted/hairline/accent so artifact content follows the active console theme.
- [fleet-console] Add a right-click context menu to File Explorer rows with Copy Path, Copy Relative Path, Reveal in File Manager, and Open with Default App actions.
- [fleet-console] Make the File Explorer pane divider keyboard-operable with arrow-key resizing and full separator ARIA semantics.
- [fleet-console] Add a Sync action to the Repository panel: one click runs `git fetch --prune --no-tags` against the current repository context, then refreshes branches, history, worktrees, and changes.
- [fleet-console] Opening the Repository panel now auto-syncs when the last fetch is older than 5 minutes; failures always keep showing local data.
- [fleet-console] Add a Claude (Gateway) launch that drives Claude Code through a local AI Gateway, routing each model call to the Codex (ChatGPT subscription), Cursor (subscription), or Kimi (API key) backend while native Claude models pass through untouched.
- [fleet-console] Rework the Terminal settings Agent CLI section into AI Gateway with a per-provider model loadout: only enabled models reach the /model picker (opt-in), sorted by provider (Codex, then Cursor, then Kimi) under Claude Code's built-ins; a starred model becomes the session default, and rows surface context window, effort ladder, Fast, and Max Mode chips. The selection persists in the console's terminal plugin state.
- [fleet-console] Add an opt-in Diagnostics control to AI Gateway settings that records payload-free Cursor transport events for newly started traces, defaults to Off, and preserves existing rotating logs when disabled.
- [fleet-console] The AI Gateway answers a context-exhausted turn with the `Prompt is too long: N tokens > M maximum` signal Claude Code needs to compact and continue, and carries each model's real usable window independently of the `[1m]` accounting coordinate so a native Cursor model is guarded too.
- [fleet-console] A gateway failure that happens after the response headers were sent now ends with a terminal SSE `error` frame carrying the reason, instead of silently truncating the stream.
- [fleet-console] Report Kimi usage in the Usage limits panel as a fourth provider, read with the Kimi API key already registered in Fleet.
- [fleet-console] Track the Cursor Auto and API allowances as separate windows, so a model billed from one pool is judged against that pool rather than the combined figure.
- [fleet-console] Give a Claude (Gateway) session a gateway_models tool that reports the models it may assign to a run's stages, each model's context window, reasoning-effort ladder, quota pool, and measured role fit, plus current provider allowances. The roster is resolved on each call and lists only models enabled in Settings.
- [fleet-console] Claude Gateway Operations inject AI Gateway model and effort Agents at spawn, and disable the built-in Claude Code Agent roster for that path.

#### Changed
- [fleet-console] Open the finished or started operation directly from a scuttlebutt bubble: the bubble body now focuses the operation, and a separate dismiss action closes the announcement.
- [fleet-console] Expand simultaneous scuttlebutt announcements into one focusable row per operation instead of a single summary line.
- [fleet-console] Dismiss the Session Analyst slash-command listbox when a catalog selector gains focus, so the two suggestion layers no longer stack.
- [fleet-console] Distinguish classic Claude and Codex canvas Operations from AI Gateway Operations.

#### Removed
- [fleet-console] Remove the direct Kimi (Claude Code) launch and its default model and effort options; Kimi sessions now run through the AI Gateway, and reasoning effort is controlled inside Claude Code via /effort and the /model picker.

### fleet-core

#### Added
- [core-ai-gateway] Add a core AI gateway package that translates Anthropic Messages requests into Codex Responses, Cursor Connect, and Kimi upstream calls from one model catalog, including streaming, tool bridging, context-window projection, and reasoning-effort clamping.
- [core-ai-gateway] Add a per-trace diagnostics policy seam that remains stable across Cursor tool continuations while allowing each newly started trace to adopt the current setting.
- [core-ai-gateway] The gateway refuses an over-window turn before calling upstream, and sizes only the tools an adapter actually serializes so a large declared tool catalog cannot lock a model out.
- [core-ai-gateway] Derive per-model routing constraints from the catalog: the upstream identity that collapses service-tier variants, the reasoning levels discovery actually advertises, Anthropic lineage, and the quota pool a Cursor model is billed from.
- [fleet-admiral] Direct a Claude (Gateway) host to keep stage model and effort selection as its own decision: inheriting the session model is the default, pinning one requires a stated reason recorded with the run, and the on-demand workflow skill carries the reasoning procedure, the measured evidence behind it, and how a stage skeleton is actually executed.
- [fleet-admiral] Add four on-demand operation skills for Claude (Gateway) sessions (architecture-review, implementation-run, quality-review, codebase-research), each defining the stage skeleton, the contract every stage returns, and the rule that ends the run, so orchestrated work no longer requires naming a model or CLI per stage.
- [core-ai-gateway] Preserve Codex cache and reasoning usage details while keeping Anthropic token accounting consistent across streaming and non-streaming responses.
- [core-ai-gateway] Support Claude Code `Web Search` through Codex Responses with domain filters, source results, and explicit provider search errors.

#### Changed
- [fleet-admiral] Split Admiral prompt doctrine so Claude Gateway sessions run on standing orders alone, without protocol skills, the protocol gate, the carrier roster, the naval persona and tone overlays, or the carrier_dispatch and carrier_jobs tools, while classic Agent CLI sessions keep the protocol gate, metaphor overlays, and carrier_dispatch guidance.
- [fleet-admiral] Gateway Orchestration Policy now requires the `gateway_models` MCP tool before choosing a staged Agent whose model or effort differs from the session default.

## [1.40.0] - 2026-07-30

### fleet-cli

#### Removed
- [fleet-cli] Remove Fleet Plans tools and workspace binding from the terminal host.
- [fleet-cli] Remove the opencode-go carrier color palette entries.

### fleet-console

#### Added
- [fleet-console] Open the command palette directly with Mod+P, pre-seeded with the command-mode prefix.

#### Changed
- [fleet-console] Replace the rail panel header's "Float over Map" text toggle with a picture-in-picture icon button and swap the Solid/90/75/60 opacity presets for a continuous inline slider (40-100) with a live percentage readout; the header now stays on a single row even at the minimum panel width.
- [fleet-console] Retune the Whites light theme from blue-tinted white to a warm oatmeal neutral across backgrounds, ink, hairlines, and surfaces, keeping brass, signal, carrier, and identity colors unchanged.
- [fleet-console] Rebuild the Settings theme picker as a Light|Dark switch whose Dark side slides open the Instrument, Maritime, and Carbon tray and restores the last dark theme remembered per browser.

#### Removed
- [fleet-console] Remove the Plans Activity Rail panel, search integration, and HTTP APIs.
- [fleet-console] Retire the Daywatch and Drydock light themes; stored selections fall back to Whites in every boot path so first paint keeps light polarity.
- [fleet-console] Remove OpenCode Go from Agent CLI detection, launch-path configuration, and Session Analyst provider selection, and drop the opencode carrier theme tokens.

### fleet-plugin

#### Added
- [fleet-console] Scuttlebutt announces operation starts with a warn-channel "Started" bubble, mirroring the finished-work arrival bubble; starts from the operation you are watching stay silent, repeat starts respect a 60-second cooldown, and a new departure bell settings toggle (on by default) controls the signal.
- [fleet-console] Add a Usage limits rail panel that reports Claude Code and Codex subscription rate limits, showing session, weekly, and model-scoped usage bars with reset countdowns plus the remaining Codex rate-limit reset credits.
- [fleet-console] Read usage with the local CLI sign-in only after an explicit connect step for Claude, keeping credentials read-only and sending requests solely to each provider.
- [fleet-console] Add Cursor to the Usage limits panel, showing billing-cycle usage for included, Auto, and API spend with the time left until the cycle resets and the current plan.

#### Changed
- [fleet-console] Warm the Whites terminal paper, ink, and neutral ANSI rungs to match the oatmeal atmosphere while chromatic ANSI colors stay semantic.
- [fleet-console] Connect and disconnect each usage provider independently, so acting on one provider no longer refreshes or disturbs the others.

#### Fixed
- [fleet-console] Sharpen the Korean labels on the in-panel companion handle chips with an integer 10px size and the body sans stack, and remove half-pixel blur from the handle stack and artifacts chip centering.
- [fleet-console] Repository history no longer draws merge commit lane lines protruding above the branch point or dead-end branch stubs toward parents outside the loaded page.
- [fleet-console] Commit rows keep a uniform graph gutter width so subjects no longer shift sideways across merge spans.

#### Removed
- [fleet-console] Remove Plan tool registration and workspace binding from Terminal Agent sessions.
- [fleet-console] Render historical opencode usage rows in Ledger with the default glyph and raw client id instead of a dedicated glyph and color.

### fleet-core

#### Breaking Changes
- [core-agent][fleet-admiral][fleet-carriers] Remove the Fleet Plans package and Plan-specific orchestration contracts.
- [core-unified-agent][fleet-analyst] Remove the opencode-go provider: the CliType union member, CLI_BACKENDS entry, model catalog, and UnifiedOpenCodeAgentClient export are gone, and opencode is no longer detected or launchable as a Fleet backend.

## [1.39.0] - 2026-07-29

### fleet-console

#### Changed
- [fleet-console] Light themes now keep the terminal as the brightest surface: the sidebar and command-band cap sit on a new darker chrome tier, and the canvas and page backgrounds settle below the terminal paper so attention lands on the work area. Dark themes are unchanged.
- [fleet-console] Operation window frames and titlebars in light themes now share the command band's chrome tone instead of holding the darkest tone on screen. Dark themes are unchanged.

#### Fixed
- [fleet-console] Brass-filled primary buttons keep WCAG AA 4.5:1 text contrast in all three light themes.

### fleet-plugin

#### Changed
- [fleet-console] Light terminal backgrounds brighten into the brightest surface on screen while keeping each theme's tinted atmosphere, and bright-white ANSI blocks stay whiter than the page.

## [1.38.0] - 2026-07-28

### fleet-console

#### Added
- [fleet-console] Delete stale plan files from the Plans rail panel with a two-step ARM button (first click arms, second confirms), backed by the new POST /api/v1/plans/delete route; duplicate in-flight deletes are blocked and an open reader closes when its plan is removed.

#### Changed
- [fleet-console] Fuzzy-match command palette queries so typos and abbreviations find commands, ranking exact matches first and highlighting matched glyphs.
- [fleet-console] Bundle Pretendard Variable as the Korean fallback for body, display, and UI font chains, and raise light-theme body weight to 450 to keep Hangul strokes legible on bright backgrounds.

#### Fixed
- [fleet-console] Restore WCAG AA contrast for signal-colored badge and label text on the Daywatch, Whites, and Drydock light themes with a light-only signal ink tier; dark themes are pixel-identical.
- [fleet-console] Darken light-theme tertiary and muted text so small uppercase labels stay readable on bright surfaces.
- [fleet-console] Preserve the codex panel search query, open document, and reading position when switching right-rail panels or reopening the rail, while still resetting them on a real Theater change.

### fleet-plugin

#### Added
- [fleet-console] Agent CLI settings let you point a CLI at its executable path when this machine's PATH does not reach it, verify it on the spot, and see which PATH entries were searched.
- [fleet-console] Pass a COLORFGBG polarity hint to newly spawned shell and agent sessions, and show a one-time hint chip on live terminals when the console theme switches between dark and light.

#### Changed
- [fleet-console] Repository history keeps the pages you loaded, your scroll position, the selected commit, and the filter when you leave the panel and come back, instead of resetting to the first page.
- [fleet-console] The history toolbar gains a refresh control, so reloading commits no longer depends on switching rail panels.
- [fleet-console] Agent CLI detection and launch now share one resolution order: environment override, then a path you set, then PATH. A configured source that fails is reported instead of quietly falling back to another binary.

#### Fixed
- [fleet-console] Enforce a 4.5:1 terminal contrast floor on light themes so dark-tuned agent CLI truecolor and white ANSI text stay readable while hues are preserved.
- [fleet-console] Make the Ledger rail panel scroll when the operation list overflows, so the per-CLI device-wide section stays reachable.
- [fleet-console] Reset the Ledger panel scroll to the top when opening an operation detail and restore the list position on back.
- [fleet-console] Repository changes and compare lists now actually restore their retained scroll position when you return to the panel; the position was previously tracked on a non-scrolling container and always reset to the top.
- [fleet-console] The workspace source tree no longer loses its pending scroll restore when branches, worktrees, or change counts finish loading after the panel appears.
- [fleet-console] The Scuttlebutt completion bubble now carries its "Finished" label on a line of its own and wraps a long Operation title across two lines beneath it, so a long title no longer clips away the part that said an Operation had finished at all.

## [1.37.1] - 2026-07-28

### fleet-plugin

#### Fixed
- [fleet-console] Keep all three Scuttlebutt admiral mascot colors unchanged across Console themes.

## [1.37.0] - 2026-07-27

### fleet-console

#### Added
- [fleet-console] Add three light themes (Daywatch, Whites, Drydock) and group the Settings theme picker into Dark and Light families.
- [fleet-console] Serve the stored theme in the initial console HTML and apply a boot-time hint so light-theme users no longer see a dark first-paint flash.
- [fleet-console] Switch markdown syntax highlighting to follow the active theme's color scheme with a dark fallback for older engines.

#### Fixed
- [fleet-console] Keep idle operations streams connected across local networking environments.

### fleet-plugin

#### Added
- [fleet-console] Add light terminal palettes for all three light themes and follow the active theme in the Global Shell rail and Session Analyst artifacts.

## [1.36.0] - 2026-07-26

### fleet-console

#### Added
- [fleet-console] The command palette's command mode now covers session lifecycle verbs: Undo last close appears at the top while the eight-second undo window is live, Add Theater opens the existing folder picker, and each Theater gets a Forget command at the bottom of the list that routes through the same undo window as the sidebar.
- [fleet-console] Command mode now blends rail panel search results below the command list, so typing a query after the angle bracket reaches Files, Repository, and other panel providers without leaving command mode.
- [fleet-console] The console now reports a lost server link on the command band, in a banner pinning the time values stopped updating, and over rail panels whose values are frozen, each offering to reconnect.
- [fleet-console] While that overlay covers a rail panel, its contents stay out of the keyboard tab order and focus moves to the reconnect control, returning once the link is live.
- [fleet-console] A new "Fit all panels" command frames every visible Operation on the canvas: Shift+1 on the map, a command-band button next to Reset canvas view, or the palette's Fit all panels row animates the viewport so all non-minimized panels fit with comfortable padding. Terminals keep the "!" keystroke, and the command is suppressed while Formation view or Triage mode is active.
- [fleet-console] Alt with the up or down arrow now maximizes or minimizes the active panel on the map and in Formation view.
- [fleet-console] In Triage mode, Alt with the down arrow sets the current item aside; the first press asks for confirmation and a second press within 1.5 seconds carries it out, while Escape cancels.
- [fleet-console] Holding Alt now shows each panel's position number and the two keys available in the current mode, not just its name.
- [fleet-console] Plugins can give a companion panel a keyboard shortcut, and the Console dispatches it and lists it in the shortcut help.
- [fleet-console] The command band breadcrumb now folds away before it can reach the map controls when the window gets too narrow, and returns as soon as there is room again.
- [fleet-console] Host a floating widget layer so a plugin can render across the whole console without taking a panel, and let it read the fleet as aggregate signals only.

#### Changed
- [fleet-console] The shortcut help no longer lists two Esc entries that had no effect.

#### Fixed
- [fleet-console] The Triage mode button no longer overlaps the Formation layout icons in the command band: the map controls (Reset view, Fit all panels, Formation layouts, Triage) now share one flow container with even spacing instead of per-control absolute offsets, so future buttons cannot collide again.
- [fleet-console] Triage mode opens with nothing on stage and nothing focused when no Operation is waiting, instead of surfacing whichever panel was focused before.
- [fleet-console] The command band breadcrumb now centers on the panel area itself instead of the whole window, so the sidebar no longer pushes it off center and collapsing the sidebar keeps it centered.

### fleet-plugin

#### Added
- [fleet-console] The Session Analyst artifacts panel gains an Export menu on the active artifact: download it as a self-named HTML file, copy its source to the clipboard, or open the themed render in a new tab. The menu is fully keyboard-operable and everything stays client-side, so artifact limits and storage behavior are unchanged.
- [fleet-console] Alt+C opens or closes Carrier Streams and Alt+A opens or closes Session Analyst on the active agent Operation.
- [fleet-console] A new Ledger panel in the Activity Rail reports what local agent CLI work cost. Operations show their own token usage and dollar cost, matched by the session id the Console already holds, and a device-wide section totals every local session per CLI regardless of Theater or Operation. Usage is collected by installing a pinned copy of the tokscale CLI under the plugin data directory; nothing is uploaded and no prompt or response text is read.
- [fleet-console] Add Scuttlebutt, three quaker admirals who roam the console and answer quick questions without a Theater or an Operation.
- [fleet-console] Give Tori, Bori and Dori a chat session and a voice of their own, each reachable by clicking that admiral.
- [fleet-console] Let the admirals search the web and read public sources, while file and shell work stays with an Operation in a Theater.
- [fleet-console] Report the fleet through posture: thinking while operations run, an alarm while something waits on approval or the stream is down, and a cheer when an operation finishes.
- [fleet-console] Announce a finished operation in a bubble that follows the admiral carrying it and clears itself.
- [fleet-console] Retire any admiral individually from settings, and pin one where it stands from the head of its chat without stopping its animations.
- [fleet-console] Ship the admirals off by default and mark the settings section experimental, so nobody gets a floating mascot they did not ask for.
- [fleet-console] Freeze the flock into a still formation when the console or the system asks for reduced motion.

#### Changed
- [fleet-console] Repository history continues past the first 200 commits with a load-more control, and says so when the first commit is reached.
- [fleet-console] Repository history renders only the rows in view, so a longer list no longer makes the panel heavier.
- [fleet-console] Repository history graph lanes follow real ancestry even when a filter is applied.
- [fleet-console] Show the idle agent session settings and the agent alerts in the console display language instead of English only.
- [fleet-console] Show each carrier's role and mission in the console display language, switching with the language setting without refetching.

### fleet-core

#### Added
- [core-unified-agent] Allow a system prompt to replace the CLI preset instead of prefixing it, so a caller can define an agent's whole identity.
- [fleet-carriers] Keep display-only carrier translations apart from the canonical English metadata, so the routing roster given to the host agent stays language independent.

## [1.35.0] - 2026-07-26

### fleet-console

#### Added
- [fleet-console] A view mode control in the command band switches between Auto, Mobile, and Desktop, and Auto follows the window width so a narrow window opens the mobile layout on its own.
- [fleet-console] Narrow screens get a dedicated shell that lists Operations by status, opens one session full screen, and returns to the list with the back control or the browser back button, while the desktop canvas layout stays untouched.
- [fleet-console] Add Triage mode, which stows every panel and brings up one waiting Operation at a time on a maximized stage, with a queue rail, Alt+T toggle and Alt+Right defer. An Operation waits when it is awaiting input or has just returned to idle without being seen, and the sidebar shows that queue through its own status sort rather than a separate mode-only list.
- [fleet-console] Add guided feature tours that introduce a new capability at its entry point and walk through it once, remembering what has been seen.

#### Changed
- [fleet-console] An Operation that just went idle without being opened now signals it on every surface: the sidebar shows the unseen mark under any sort order and files it with the awaiting group when sorted by status, and a panel sitting on the Map takes a green rim with an outer glow. Focusing the Operation clears the signal everywhere at once, and the focus highlight always wins over it. While Triage mode is on the signal survives focus, so the panel you are working on cannot drop out of the queue.
- [fleet-console] Rebuild Formation view as a situation board with a brighter survey grid, instrument frame, slot numbers, open-slot guides and an entry sequence.
- [fleet-console] Remember the first-run onboarding in console settings instead of browser storage, so it no longer reappears on another browser or device.

#### Fixed
- [fleet-console] Alt+Arrow panel cycling keeps following the canvas layout order while the sidebar is sorted by status, instead of jumping through the status sections.
- [fleet-console] Join the expanded Theater sidebar to the command band block above it, so the shared column no longer stacks two hairlines at the seam and no longer breaks its right edge across a rounded corner.
- [fleet-console] Stop scrim-backed modals, floating menus, toasts, the command palette, and the right-rail "float over Map" Solid preset from bleeding the canvas through in the maritime and carbon themes, while panels and cards keep those themes' glass design.

### fleet-plugin

#### Added
- [fleet-console] Agent Operations now carry a sortie ribbon along the bottom of the body while carriers stream, naming how many are out, which captains hold them, and what each is doing, so a carrier sortie is no longer indistinguishable from the agent's own turn. Clicking it opens Carrier Streams. The ribbon floats over the terminal instead of shrinking it, so the terminal keeps its full size.

#### Changed
- [fleet-console] Carrier stream rows now share the panel height instead of a fixed cap: a single stream fills what it needs without scrolling, and as more carriers stream the rows shrink evenly down to a readable floor while shorter rows hand their surplus height to longer ones.

#### Fixed
- [fleet-console] Draw repository history graph lanes from real git ancestry instead of branching at commits the log query had silently dropped.
- [fleet-console] Leave a lane unconnected where a filter or the row cap hides the commits in between, rather than asserting an ancestry the visible rows do not prove.
- [fleet-console] EXIT on the Session Analyst handle now closes the artifacts panel together with the chat panel, instead of leaving the artifacts panel on screen with no control able to dismiss it.
- [fleet-console] Make the Skills reading overlay and toast and the Session Analyst artifact menu and slash-command listbox fully opaque in the maritime and carbon themes.

## [1.34.0] - 2026-07-25

### fleet-cli

#### Changed
- [fleet-cli] Let the Admiral host author and mutate Fleet Plans directly while keeping task completion marking exclusive to Ohio.
- [fleet-cli] Unify local and remote codebase intelligence under Vanguard's read-only reconnaissance contract.
- [fleet-cli] Show five default Carriers after retiring Kirov and moving optional Plan assurance to Nimitz.
- [fleet-cli] Show four default Carriers after retiring Ohio and moving direct and Plan-driven implementation to Genesis.

### fleet-console

#### Added
- [fleet-console] Add Solid/90/75/60 opacity presets to the Float over Map rail panel head so the floating panel background can let the Map show through while panel content stays opaque; the choice persists across sessions.
- [fleet-console] Add Operation actions to the command palette: Resume (dormant only), Close, Minimize all, Toggle Formation view, and Toggle status axis, scoped to the active Theater, plus activity badges (awaiting / running / dormant) on search rows.
- [fleet-console] Make the Activity Rail resize handle keyboard operable as a focusable separator, with Arrow keys resizing by 16px, Shift+Arrow by 64px, and Home/End jumping to the minimum and maximum width.
- [fleet-console] Open the Operation chip and Theater row context menus with Shift+F10 or the ContextMenu key, focusing the first item and returning focus to the row on Escape, so group and accent assignment no longer require a right click.
- [fleet-console] Add Rename, Assign group, Set accent and Minimize commands for the active Operation to the command palette, reaching chip menu actions that previously needed a right click.
- [fleet-console] Hold a closed Operation or a forgotten Theater for eight seconds before deleting it for good, with an undo toast and a Mod+Z shortcut to take the action back. Restored Operations come back dormant and start only when relaunched.
- [fleet-console] Search Repository commits, Files paths, Plans and Skills from the command palette, and open the owning panel at that result. The palette previously matched Operation titles only, and no panel could hand a commit or a path to another.
- [fleet-console] Plugins can localize their panel, operation, settings, and notification titles, and rail panels now receive the resolved locale.

#### Changed
- [fleet-console] Pin all four Sort by Status sections with per-section collapse toggles (empty sections stay dimmed and collapsed), replace group color dots with group name pills in the status axis, and switch the Theater actions icon to an ellipsis.
- [fleet-console] Turn the empty Operations map into an actionable surface with standing-by operation chips, a New Operation button, and shortcut hints.
- [fleet-console] Unify the control grammar with three font weights, two icon button sizes, and a shared button variant set, and return control and CTA labels to sentence case while keeping uppercase for structural section labels.
- [fleet-console] Express de-emphasis by stepping text down a tier instead of fading it with transparency, so a dimmed label keeps its guaranteed contrast.
- [fleet-console] Remember Activity Rail width per panel instead of sharing one width across every panel, so widening Repository no longer leaves Alerts occupying the same space and shrinking the map.
- [fleet-console] Open each Activity Rail panel at its own default width, using Repository and Codex at 420px and Plans, Files and Skills at 360px.
- [fleet-console] Answer a delete request for an Operation that no longer exists with a success response instead of a not-found error, so repeating a close is harmless.
- [fleet-console] Describe Vanguard as the unified local and remote reconnaissance specialist in the Carrier roster.
- [fleet-console] Order each sidebar status section by the most recent transition, keeping untouched operations in their manual order.
- [fleet-console] Mark operations that land in IDLE with a session-only unseen dot and section header count until you open them once.
- [fleet-console] Shorten the first status section header from "AWAITING INPUT" to "AWAITING".
- [fleet-console] Rename the Settings > General language card to "Display language" and describe it as the language used across Console surfaces, matching the setting that already drives What's New and plugin panel copy.
- [fleet-console] Present a five-Carrier roster with Nimitz carrying optional Plan assurance and no Kirov entry.
- [fleet-console] The Display language setting now drives the console itself: command band, sidebar, canvas, command palette, keyboard shortcuts, Settings, What's New chrome, and Codex all follow the selected language, and dates and relative times format per locale.
- [fleet-console] Switching the language applies immediately without a reload, and the page language attribute follows the resolved locale.
- [fleet-console] Present a four-Carrier roster with Genesis carrying direct and Plan-driven implementation and no Ohio entry.

#### Fixed
- [fleet-console] Raise dimmed interface text to the readable tier in all three themes, so panel titles, section labels, metadata, and control captions meet the WCAG AA contrast floor instead of fading into the surface.
- [fleet-console] Distinguish the four Operation status beacons by shape as well as color, so the state stays readable without relying on color perception.
- [fleet-console] Apply the intended font family and label sizes in the Codex reading sheet and navigator, which previously fell back to inherited values.
- [fleet-console] Classify restored Operations as DORMANT instead of IDLE in the sidebar status axis and Alt cycling, matching the canvas frame, via a non-sensitive resumeAvailable marker stamped at DTO time.
- [fleet-console] Open the canvas and sidebar right-click menu at the cursor, flipping it above the pointer when there is no room below and sizing its height ceiling from the viewport.

### fleet-plugin

#### Added
- [fleet-console] Collapse and expand Repository panel workspace tree sections, with Tags and Stashes folded by default and fold state kept in memory only.
- [fleet-console] Answer every dormant Resume click: a pending "Resuming..." state, an in-frame failure card with Try again / Start fresh, and a Resume failed Alerts entry. Start fresh relaunches the Operation without the saved provider session.
- [fleet-console] Idle agent terminals now move to DORMANT automatically after a configurable idle period (default 1 hour), reclaiming CLI process resources while keeping the conversation one Resume click away; working sessions and sessions without a saved provider session are never transitioned.
- [fleet-console] Add an "Idle agent sessions" option to Settings > Terminal > General (Off / 30 minutes / 1 hour / 2 hours / 4 hours), persisted on the Console server.

#### Changed
- [fleet-console] Wrap Repository History commit subjects to two lines in narrow panels and show the full subject on hover.
- [fleet-console] Expose host-owned Fleet Plan authoring in Console Agent sessions while keeping Carrier Plan mutation fail-closed.
- [fleet-console] Remove Tempest from Terminal Carrier settings and job identity styling while preserving the neutral fallback for old identities.
- [fleet-console] Replace the agent operation's bottom stream dock and its Details overlay with a Carrier Streams companion: a STREAMS handle stacked above ANALYZE opens a pane where carriers stream as vertically stacked rows, each rendering its request bubble, the streamed markdown message, a reasoning status line, and an analyst-style status card that shows only the latest confirmed tool activity; finished carriers collapse to one-line strips that persist for the session and expand on click.
- [fleet-console] Open Carrier Streams and Session Analyst independently from their own edge handles, show a live aurora pulse badge on the STREAMS handle while carriers stream and on the ANALYZE handle while the analysis engine works (degrading to a static dot under reduced-motion settings), and localize the handle and panel copy for the Korean console language.
- [fleet-console] Keep stale Kirov settings and stream ownership inert while omitting Kirov from registry-driven settings and identity styling.
- [fleet-console] The built-in Terminal, Repository, Files, and Skills panels follow the Display language setting, covering panel titles, carrier and agent settings, file viewers, skill install and reading surfaces, repository sections, and markdown code-copy and diagram controls.
- [fleet-console] Keep stale Ohio settings and stream ownership inert while omitting Ohio from registry-driven settings and identity styling.

#### Fixed
- [fleet-console] Raise dimmed text in the Repository, Skills, Files, and Session Analyst panels to the readable tier, and stop fading commit rows outside the checked-out branch below the contrast floor.
- [fleet-console] Apply the intended font family to the Files panel tree labels, which previously fell back to an inherited value.
- [fleet-console] Walk the Files tree with the Arrow, Home and End keys and keep a single tab stop for the whole tree, replacing a tab stop on every node.
- [fleet-console] An agent panel returns to the running state once the agent resumes work after an input prompt, and drops to idle when a turn is interrupted, resolved from the agent CLI terminal title signal instead of hook events alone.

#### Removed
- [fleet-console] Remove the Codex ACP/App Server launch-mode selector; Console-launched Codex sessions now always use App Server.

### fleet-core

#### Added
- [core-unified-agent] Add Fast Codex model assets for GPT-5.6 and GPT-5.5, mapped to the App Server `priority` service tier.
- [fleet-admiral] A Codex session reports input waiting to the Console through a PermissionRequest hook.

#### Changed
- [fleet-carriers] Merge Tempest's GitHub-focused intelligence into Vanguard's read-only local and remote codebase contract, including public code search, read-only APIs, web research, and temporary clones.
- [fleet-admiral] Route reconnaissance dispatches through Vanguard with generalized `objective`, `search_space`, `hints`, `constraints`, and `depth` request blocks.
- [core-unified-agent] Keep codex sessions out of the codex CLI resume picker by archiving each thread on disconnect and unarchiving it when the session resumes.

#### Fixed
- [core-unified-agent] Stop codex session teardown from hanging when the app-server exits before answering the archive request.

#### Removed
- [core-unified-agent] Remove the `ait` CLI, Codex ACP bridge support, and the GPT-5.4 model family.

#### Breaking Changes
- [fleet-admiral] Keep Fleet Plan authoring and mutation host-owned, expose optional Plan assurance through Nimitz, and keep task completion marking exclusive to Ohio.
- [fleet-carriers] Remove Kirov from the default Carrier contract and exports without an alias, and add optional exact-PlanRef assurance to Nimitz.
- [fleet-admiral] Remove Kirov dispatch routing and expose optional `plan_ref` assurance through Nimitz while preserving host and Ohio ownership.
- [fleet-carriers] Remove Ohio from the default Carrier contract and exports without an alias, and extend Genesis to execute optional same-Lane TaskRefs without mutating Plan state.
- [fleet-admiral] Give the host sole ownership of Plan mutation and completion, exposing `plan_mark_tasks` to the host for use after artifact inspection and Lane QA.
- [fleet-plans] Require the Carrier-neutral host-completion policy for new Plans while keeping the exact legacy Ohio policy lint-compatible only for existing Plans.

## [1.33.0] - 2026-07-23

### fleet-cli

#### Removed
- [fleet-cli] Remove Chronicle from the built-in roster and report seven default Carriers.

### fleet-console

#### Added
- [fleet-console] Add a theater-row status-axis toggle (Alt+S) that regroups the sidebar into AWAITING INPUT / RUNNING / IDLE / DORMANT sections while keeping group identity via the operation spine and a group mark dot; the mode is session-only and always reopens on the group axis.
- [fleet-console] The console Language setting (Settings > General) now also drives Session Analyst, delivering the resolved locale to plugins through the operation render context.

#### Changed
- [fleet-console] Replace the sidebar Add Theater chrome row with a quiet New Theater ghost row at the end of the Theater list, matching Theater row grammar with a dashed anchor that wakes in brass on hover and focus.
- [fleet-console] Move the Reset view and Formation layout toggles from the sidebar to a command band cluster docked just right of the sidebar edge, so they stay reachable while Formation view is active and no longer appear on utility routes such as Settings.
- [fleet-console] Replace the theater-row operation count with the status toggle, absorb the collapse chevron into the row click gesture, and merge the actions and new-operation buttons into a single split control.

#### Fixed
- [fleet-console] Stop the right rail from replaying its open/close spring when the "Float over Map" behavior is toggled; the panel now stays frozen and only the Map reflows, in both directions.
- [fleet-console] Render the sidebar Operation status dot in green for idle panels, matching the panel header beacon.
- [fleet-console] Prevent Plan files from remaining stuck on Loading during live list refreshes.

#### Removed
- [fleet-console] Remove Chronicle identity styling and use a neutral brass fallback for removed or unknown Carrier identities.

### fleet-plugin

#### Added
- [fleet-console] Rebuild the Repository rail panel around a Full Workspace layout as its default presentation: a persistent, resizable source tree (repository discovery, worktrees, branches, tags, stashes) sits beside an always-visible commit graph with ref badges leading each subject, commit details dock below with file list and diff, and columns yield progressively (time, then sha, then badges) as the panel or tree is resized.
- [fleet-console] Session Analyst now follows the console Language setting: panel copy and analysis answers render in English or Korean, with "auto" resolving from the browser language.
- [fleet-console] Session Analyst CLI/Model/Effort selections now persist across reloads and restarts; Reset restores the saved default instead of the catalog guess, and the selectors stay locked while a reset is in flight.

#### Fixed
- [fleet-console] Keep Session Analyst responsive across multiple Operations by sharing one browser event stream.

#### Removed
- [fleet-console] Align Terminal Carrier settings and status surfaces with the seven-Carrier roster.

### fleet-core

#### Added
- [fleet-analyst] Analyst sessions accept a response-language option and append a Korean response-language directive to the system prompt when Korean is selected.

#### Breaking Changes
- [fleet-admiral] [fleet-carriers] [fleet-wiki] Remove the Chronicle persona and its public defaults from the built-in Carrier catalog; documentation synthesis and Fleet Wiki mutation are now host-owned.

## [1.32.0] - 2026-07-22

### fleet-console

#### Added
- [fleet-console] Add a "Float over Map" pill toggle to the right rail panel head that switches rail panels between the default push layout and an overlay mode where the panel floats over the Map without resizing it; the choice persists across sessions.
- [fleet-console] Add a "Reduce panel motion" toggle to Settings > General. Off (default) follows the operating system's Reduce Motion setting as before; on suppresses all panel animations (open, move, minimize, and restore). Stored server-side with Console settings.
- [fleet-console] Add shared Select and useSelect listbox primitives to the SDK react browser surface with token-styled themed popups.

#### Changed
- [fleet-console] Replace all native <select> dropdowns across Console settings, What's New, and Cowork with the shared themed Select for readable dark-theme popups.
- [fleet-console] Replace native <select> dropdowns in Terminal carrier, model, effort, and Task Force settings, the Session Analyst composer, and Repository compare controls with the shared themed Select.

#### Fixed
- [fleet-console] Keep Alt+Left and Alt+Right navigation from selecting or restoring minimized Operation panels while Session Analyst, maximized, or Formation views are active.
- [fleet-console] Carrier completion System Reminder messages now submit reliably when multiple jobs finish close together while browser payload redaction remains intact.

### fleet-plugin

#### Added
- [fleet-console] The Session Analyst composer grows with the question up to six rows instead of clipping everything past one line, and the draft now lives in the per-operation analysis store so it survives closing and reopening the panel.
- [fleet-console] Questions can be queued while the analyst is working: Enter stacks the question as a cancellable QUEUED chip, queued questions fire in FIFO order when each run completes, and Stop or Reset clears the queue.
- [fleet-console] Follow-up suggestion chips (Go deeper, Check for intent drift, Turn this into an artifact, What is the agent doing now?) appear after every completed answer so the analyst's capabilities stay discoverable past the first question.
- [fleet-console] Typing "/" in the composer opens an analysis command palette (/now /drift /brief /risks /timeline) with keyboard navigation, IME-safe guards, and combobox ARIA wiring; choosing a command fills the composer with its template question.
- [fleet-console] Show a live authoring card in the Session Analyst chat while an artifact is being generated, resolving into a published card with an Open in Artifacts action.
- [fleet-console] The Repository panel's Repositories source gains a discovery bar: fuzzy search with highlighted matches, Enter to open the first hit, and a scan-depth stepper with the result count in one row.

#### Changed
- [fleet-console] Carrier settings now save on change instead of per-carrier Save/Discard: Runtime CLI/model/effort, display name, and Task Force row edits persist immediately, CLI switches commit as one atomic update, and Task Force backend removal requires a two-step confirm that warns when the removal would deactivate the Task Force.
- [fleet-console] Switching carrier chips no longer discards unsaved edits, because carrier settings hold no draft state.
- [fleet-console] Repository panel selections now use a neutral ink wash with a brass spine, reserving brass for location cues such as the current branch label and HEAD badge.
- [fleet-console] Repository panel bands and inputs consume the core surface tokens so each theme's material carries through the panel interior.
- [fleet-console] Added and deleted diff rows now read in a single state color; syntax decoration stays on context rows only.
- [fleet-console] Repository History keeps the all-branches graph while sizing each commit row only for lanes active at that point, so older branches no longer widen or collapse newer HEAD rows.
- [fleet-console] Selecting a repository or worktree now lands in History, matching how branch and tag picks already navigate; the bottom scan-depth footer is retired.
- [fleet-console] The agent panel's carrier stream strip becomes an ambient capsule: stacked captain dots, a live scan line, a per-track segment meter, and the latest output line with elapsed time and token estimate.
- [fleet-console] The expanded stream deck lists a phase card per carrier track - an identity spine, live phase verbs such as Reasoning, Using a tool, and Writing, and a one-line preview replace the log rows.
- [fleet-console] The Details Activity tab renders carrier output as streamed markdown with tool status chips that name their target, replacing the raw text dump; thinking stays behind a collapsible fold and completed jobs still clear after the short retention window.

#### Fixed
- [fleet-console] Keep the Session Analyst chat pane free of horizontal scrolling at narrow widths by scrolling wide markdown content inside its own block.
- [fleet-console] The Terminal plugin serializes delayed System Reminder input and cancels stale submits when a PTY session closes or a write fails.

### fleet-core

#### Changed
- [fleet-admiral] Hosts can now split PTY message text from its submit key with an optional delivery delay while existing callers retain their current behavior.

## [1.31.0] - 2026-07-21

### fleet-console

#### Added
- [fleet-console] Typing > in the command palette switches it to a command mode that runs curated Console actions from the keyboard: switch theater, launch a new Operation, open rail panels, toggle the rail or sidebar, switch theme, and open Settings, keyboard shortcuts, or What's new.
- [fleet-console] Switch the active Theater and Operation directly from the command band breadcrumb: each segment opens an anchored dropdown listing every Theater (with operation counts and Add Theater) or the active Theater's operations (with Rename and New Operation rows), with full keyboard navigation and viewport-aware positioning.

#### Changed
- [fleet-console] Paint sidebar group identity through the full spine, mark, and wash grammar: a persistent color dot and tinted header (stronger when collapsed) plus a faint group-zone wash, while the 3px left rail stays unchanged.
- [fleet-console] Panel transitions now share one motion layer: Formation switches, maximize, and restore glide smoothly, minimize fades toward its sidebar chip with a ghost flight and an arrival pulse, and Formation entry staggers panel placement. All motion honors reduced-motion preferences.

#### Fixed
- [fleet-console] The command band breadcrumb no longer shows an operation from a different Theater after switching Theaters from the sidebar; it now offers a Select operation trigger instead.

### fleet-plugin

#### Added
- [fleet-console] The Repository panel gains a read-only Compare source: pick any two refs (branches, tags, or HEAD) and browse their merge-base diff as a changed-file list with per-file hunks.

#### Changed
- [fleet-console] Show the Repositories list as a collapsible directory tree of nested repositories, sorted alphabetically with single-child folders compressed, while the Theater root stays pinned on top.
- [fleet-console] Retune the Repository panel palette to the design channels: history graph lanes and diff syntax highlighting use the theme-tuned identity tones, and decorative signal-color accents are removed.

#### Fixed
- [fleet-console] Unify Repository panel borders on the rim token so edges keep the same weight in the Maritime and Carbon themes, and restore the history tab transition that an undefined easing token had disabled.

### fleet-core

#### Changed
- [fleet-wiki] The host now stages and approves Fleet Wiki entries directly; all wiki mutation, staging, lint, and schema tools are host-only, leaving only the read-only tools shared with carriers.
- [fleet-carriers] The Chronicle carrier no longer handles Fleet Wiki entries and focuses solely on codebase documentation.
- [fleet-admiral] Require Carrier dispatches to carry settled decisions as literal values.
- [core-unified-agent] Refresh the OpenCode Go and Cursor Agent model catalogs from the live CLIs: OpenCode Go lists 11 current-generation models with `opencode-go/deepseek-v4-flash` as the default, and Cursor Agent covers 90 models via 29 effort-expanded registry entries; superseded generations are retired.

## [1.30.0] - 2026-07-20

### fleet-console

#### Added
- [fleet-console] Companion panels can declare a hidden-by-default slot, and plugins can toggle per-panel visibility through the render context while the canvas animates slot changes with a reduced-motion cutoff.

#### Fixed
- [fleet-console] Move keyboard focus to the target Operation terminal after command palette navigation, so it accepts typing right away instead of leaving focus on the previously focused control.
- [fleet-console] Activate the selected Operation on the first command palette navigation after a reload, so its panel surfaces and accepts typing instead of only leaving the minimized state.

### fleet-plugin

#### Added
- [fleet-console] Add a Kimi provider default model and effort selection to Settings for Kimi, applied to newly launched Kimi sessions that carry no explicit carrier model.
- [fleet-console] Point the Repository panel at a repository under the Theater from the Repositories list, or at a worktree of the active repository from the Worktrees list, and keep the selection per Theater.
- [fleet-console] Show the active repository and its branch above the Repository panel, marked while a sub-context is selected.
- [fleet-console] Choose how deep the Repositories list scans, from one to eight levels, and see when a scan limit was reached.

#### Changed
- [fleet-console] Session Analyst now opens with two panes and reveals the Artifacts pane on its own only when the analyst publishes the first artifact, instead of always reserving a third empty slot.
- [fleet-console] An ARTIFACTS edge chip on the chat pane opens or hides the Artifacts pane, shows the artifact count, pulses on new arrivals while hidden, and stops auto-opening after a manual close until the artifacts are cleared.

#### Fixed
- [fleet-console] Remove the Session Analyst session cap while preserving each Analyst until its Operation closes.
- [fleet-console] Keep File Explorer responsive on Linux by watching only opened directories.
- [fleet-console] Restore the Repository panel source navigation background that an undefined theme token left transparent.

### fleet-core

#### Added
- [core-agent] [core-infra] [fleet-admiral] [fleet-carriers] Derive the Kimi launch environment (model slots including fable, subagent model, auto-compact window, and effort level) from the selected provider default model, used only when no per-carrier model is set.

#### Changed
- [core-unified-agent] Align the Kimi model registry with the official Kimi Code docs: K3 effort levels low/high/max with a high default, the fable tier mapping, and per-model context windows.

#### Fixed
- [fleet-wiki] Fix the wiki workspace migration failing on Windows with an EPERM fsync error on a read-only file descriptor, which blocked every wiki tool.
- [fleet-wiki] Normalize wiki_read source and related entry paths to forward slashes on Windows, matching the store index convention.

## [1.29.0] - 2026-07-19

### fleet-console

#### Added
- [fleet-console] Reorder Theaters by dragging their sidebar headers, persisting the manual order on the server.

#### Changed
- [fleet-console] Render Fleet Wiki Cowork assistant replies as compact Markdown with streamed updates, code blocks, and diagrams.
- [fleet-console] Keep Cowork annotation instructions structurally separate from untrusted selected Wiki text.

#### Fixed
- [fleet-console] Restore legibility of minimized sidebar Operation names, which stacked a dim color with 55% opacity and fell below WCAG contrast; minimized names now use a dedicated readable ink tier and clear WCAG AA across all three themes.
- [fleet-console] Keep Session Analyze active while switching Operations and restore the previous Map, Formation, or maximized view on exit.

#### Removed
- [fleet-console] Remove the Context Chip and Theater sub-path context controls from the Command Band and Activity Rail.

### fleet-plugin

#### Changed
- [fleet-console] Session Analyst artifacts now render as full web pages, so SVG, inline CSS, canvas, and inline JavaScript all run like a normal browser page instead of a stripped-down static subset.
- [fleet-console] Render Session Analyst assistant replies as selectable compact Markdown while keeping user prompts plain.
- [fleet-console] Run every Activity Rail plugin at the active Theater root with Theater-specific Shell sessions.

#### Fixed
- [fleet-console] Give the Kimi (Claude Code) launch entry its own Kimi symbol instead of the Claude icon it shared.
- [fleet-console] Keep Session Analyst artifact canvases aligned with the active Console theme.

### fleet-core

#### Changed
- [fleet-admiral] Load Fleet Wiki operating policy on demand while keeping the default Admiral prompt focused.
- [fleet-carriers] Keep Chronicle routing metadata concise while preserving Wiki authority boundaries in the on-demand skill.
- [fleet-analyst] Require Session Analyst intent-drift reviews to cite both settled user intent and conflicting agent behavior, abstain on incomplete evidence, and remain non-binding.
- [fleet-admiral] Install frozen dependencies inside new worktrees and require package typecheck and build preflight before Carrier dispatch.
- [fleet-analyst] Let Session Analyst answer identity and capability questions without reading session history, while retaining evidence-backed analysis for session questions.
- [fleet-wiki] Let Fleet Wiki Cowork answer direct questions without reading the draft and use only the tools required by the requested draft task.

## [1.28.0] - 2026-07-19

### fleet-cli

#### Changed
- [fleet-cli] Show Task Force configuration only for source-enabled Carriers.

#### Fixed
- [fleet-cli] Keep Fleet Plan storage bound to the invocation workspace while Carriers run in worktrees.

### fleet-console

#### Added
- [fleet-console] Plans panel updates live: the list, progress bars, and the open plan reader refresh automatically when plan files change, with a one-shot pulse on changed rows.
- [fleet-console] Plans wave and lane chips jump to their section in the plan document, and the plan list supports ArrowUp/ArrowDown, Enter, and Escape keyboard navigation.
- [fleet-console] Plans list gains search, ALL/IN PROGRESS/COMPLETE status filters, a REFRESH action, and per-plan relative-path copy.
- [fleet-console] Let Codex wiki entries be edited with AI directly inside the reading view: drag-select text to add floating comment annotations, batch-send them from a floating dock with CLI, model, and effort selectors, then review AI changes as a rendered document diff with highlighted and removed blocks before applying or discarding the draft in place.
- [fleet-console] Run Cowork editing through terminal-free one-shot agent runs whose edits accumulate in one in-memory draft per entry, then apply them once through the audited wiki patch pipeline with base version and revision checks.
- [fleet-console] Add Request and Activity tabs to Stream Deck Details with browser-safe Request Block rendering.
- [fleet-console] Add a companion panel layout: an agent operation can open dedicated side panels next to its terminal while peers stay preserved, and closing the layout fully restores the Map state.
- [fleet-console] Add Wiki schema catalog browsing to the Codex sidebar.

#### Changed
- [fleet-console] Migrate persisted diff or history active panel selections to the unified repository panel.
- [fleet-console] Refresh Cowork revision feedback with a collapsible streaming activity panel, unified composer controls, and clearer progress and stop states.
- [fleet-console] Move operation identity color from the panel border to a left spine and nameplate mark, reserving borders and glows for status signals, with an 8-tone palette that retunes per theme, a named tone picker shared across the accent popover and context menus, identity dots on the minimap, and automatic mapping of previously saved accent and group color keys.
- [fleet-console] Quiet the chrome color language: environment and info badges drop signal colors for neutral ink, the stream follow button becomes a brass outline action, the minimap loses its always-on brass glow and radar rings, carrier captain colors join the theme-tuned identity palette with distinct tones per captain, and buttons across settings, What's New, and menus converge on one control grammar with tokenized heights and radii.

#### Fixed
- [fleet-console] Keep the in-panel Close button focus ring fully visible.
- [fleet-console] Keep Fleet Plans visible in the active Theater when Agents run from Carrier worktrees.
- [fleet-console] Keep in-panel names visible while editing them.
- [fleet-console] Keep Command Band progressive behavior tied to the viewport when resizing the Activity Rail.

### fleet-plugin

#### Added
- [fleet-console] Add a read-only refs endpoint listing local and remote branches, tags, stashes, and worktrees with current markers.
- [fleet-console] Switch the theater path context by selecting a worktree row in the Repository panel.
- [fleet-console] Preserve Carrier request observations through Terminal Agent snapshots and reloads.
- [fleet-console] Add Session Analyst to the terminal plugin: an in-panel ANALYZE handle opens a transcript-grounded analysis chat with Claude, Kimi, Codex, OpenCode, or Cursor selection, compact model and effort setup, streaming progress, resettable history, event citations, and sandboxed static HTML artifacts.

#### Changed
- [fleet-console] Unify the Diff and History rail panels into one read-only Repository panel with WORKING and REFS source navigation.
- [fleet-console] Pin an uncommitted-changes row atop History and filter history by validated branch or tag refs with a clearable chip.
- [fleet-console] Limit Console Task Force settings to Nimitz, Vanguard, and Tempest, and reject unsupported updates.
- [fleet-console] Conform repository, skills, and terminal carrier surfaces to the neutral badge and unified control grammar: branch and worktree badges drop signal colors, captain dots lose their glow, and plugin buttons adopt the shared mono uppercase control style.
- [fleet-console] Group the Terminal plugin settings into a new General section holding Metaphor, Terminal Font, and Terminal Renderer, and rename the Kimi sign-in card to Settings for Kimi, moving it below Agent CLI Available.

#### Fixed
- [fleet-console] Bind Terminal Agent Plan storage to its server-resolved Theater without exposing filesystem paths to the browser.
- [fleet-console] Keep Session Analyst chat pinned to the latest streamed message and activity update.

### fleet-core

#### Added
- [fleet-wiki] Add a cowork subpackage housing the terminal-free AI draft-editing engine: an in-memory session store, a one-shot agent service, a scoped MCP runtime, and session-scoped draft tools kept out of the global wiki tool registry, consumed by Fleet Console through its HTTP adapter.
- [fleet-carriers] Emit structured request observations without changing executor input or model usage.
- [fleet-analyst] Add the fleet-analyst package: a session analysis runtime with defensive transcript indexing, credential redaction, bounded MCP analysis tools, and an in-memory multi-turn analyst session.
- [fleet-wiki] Add schema list, read, and create-only template MCP tools.
- [fleet-admiral] Assign schema lookup to Chronicle and template creation to Admiral.

#### Changed
- [fleet-carriers] Enforce an explicit Carrier capability for Task Force configuration, status, and launch.
- [fleet-admiral] Adjudicate Codex review feedback against frozen product context and roll back review-driven scope drift before merge.

#### Fixed
- [core-agent] Carry immutable server-only bindings through dedicated and one-shot MCP sessions.
- [fleet-plans] Require hosts to bind Plan storage explicitly instead of deriving it from the execution directory.
- [fleet-admiral] Auto-name Claude Console panels from the first prompt before provider summaries refresh them.
- [fleet-analyst] Reject missing or unexpected publish_artifact parameters, require non-empty html, and clarify the exact HTML and contrast contract.

## [1.27.0] - 2026-07-18

### fleet-cli

#### Added
- [fleet-cli] Add Kimi via Claude Code sessions, shared sign-in commands, System Menu authentication, and Carrier backend selection.
- [fleet-cli] Expose workspace-scoped Fleet Plan read and verification tools to the host and authority-scoped Plan tools to Carrier executors.

#### Changed
- [fleet-cli] Resolve Wiki tools and knowledge counts from each project's durable workspace.

### fleet-console

#### Added
- [fleet-console] Add Kimi API key registration and sign-in-aware launch availability to Agent CLI settings.
- [fleet-console] Hold Alt to raise a glance HUD that shows every visible panel's session title at once.
- [fleet-console] Auto-hide the command band in fullscreen with edge, keyboard, pin, and reduced-motion controls.
- [fleet-console] Show a Local channel chip in the Command Band on development-channel consoles, with an Environment popover that reveals the console version, port, data root, and runtime lock paths with copy buttons; production channels render no indicator.
- [fleet-console] Desktop shells add a derived Desktop data path row to the Environment popover, and macOS Desktop abbreviates the chip label to Local to fit beside the window controls.

#### Changed
- [fleet-console] Move Carrier Settings from the System Menu standalone page into Settings > Plugins > Terminal > Carriers, keep `/carrier-settings` as a one-release redirect, and support `?section=` deep links in Settings.
- [fleet-console] Show complete Operations and Groups for inactive Theaters while preserving Group collapse state.
- [fleet-console] Move the operations panel session identity onto a hull nameplate that rides the panel border, keeps the name visible on active panels, and tucks window controls behind hover or keyboard focus.
- [fleet-console] Name Operations from provider session identity metadata while preserving Console user rename precedence.
- [fleet-console] Read Console Plans from the Theater root workspace in the shared Fleet data directory instead of repository-local `.fleet/plans` directories.
- [fleet-console] Provide theater-wide Codex knowledge per project with copy-only on-demand migration from legacy `.fleet/knowledge`.

#### Fixed
- [fleet-console] Keep Alt+Left and Alt+Right navigation within non-minimized panels.
- [fleet-console] Preserve the underlying Map or Formation state when focusing, restoring, or minimizing a panel.

### fleet-desktop

#### Added
- [fleet-console] Connect to a remote runtime over SSH: Desktop installs and runs Fleet Console on the remote machine and connects through an SSH tunnel, supporting Linux and macOS hosts.
- [fleet-console] Show remote connection progress on the bootstrap screen, return to the local runtime from a menu action, and report connection failures in a dialog.
- [fleet-console] Relay native window fullscreen state so Console chrome follows Desktop fullscreen.
- [fleet-console] Keep a signature tray icon resident in the macOS menu bar as a monochrome template image, and show the Desktop window when it is clicked.

#### Fixed
- [fleet-console] Stop parenting the update dialog to a destroyed window after the Desktop window is closed while the app stays alive.

### fleet-plugin

#### Added
- [fleet-console] Host the Carriers settings section in the Terminal plugin as a Captain chip strip with a single detail card that follows the Settings column rhythm, including the runtime editor, Task Force editing, and draft SAVE and DISCARD semantics.
- [fleet-console] Keep Kimi credentials server-side while exposing browser-safe sign-in state and guarded Terminal launches.
- [fleet-plans] Equip Terminal-launched host and Carrier agents with workspace-scoped Fleet Plan tools.

#### Changed
- [fleet-console] Keep provider session identity markers server-only and refresh titles safely across turns and session replacement.
- [fleet-console] Route Terminal agent Wiki tools to the same per-project durable workspace.

#### Fixed
- [fleet-console] Make the Terminal agent runtime follow the Console data directory override when reading Carrier state.
- [fleet-console] Keep History commit details and changed-file scrolling within the full inspector height.

### fleet-core

#### Added
- [core-infra] [core-unified-agent] [fleet-admiral] Add the shared claude-kimi backend, current model metadata, credential validation, and Carrier authentication injection.
- [core-infra] Resolve stable cross-platform workspace directories under the Fleet data directory and guard their cwd identities against collisions and unsafe paths.
- [fleet-plans] Add deterministic PlanRef and TaskRef storage, linting, compact execution reads, task completion marking, and Plan-state verification tools.
- [fleet-carriers] Make Kirov author validated Plans through Plan tools and make Ohio execute explicit same-Lane TaskRefs with one compact Plan read per dispatch.
- [fleet-wiki] Add a host-injected Wiki workspace resolver with one-time copy migration.

#### Changed
- [fleet-admiral] [fleet-carriers] Slimmed the always-injected Admiral system prompt by a further 11%: the Carrier Operations Policy standing order keeps only its judgment kernel, while dispatch composition rules moved into the on-demand carrier-operations skill (renamed from carrier-contracts) alongside the per-carrier request-block contracts.
- [core-unified-agent] Bind provider-neutral session identity resolvers at Agent CLI launch while preserving Codex prompt auto-naming.

#### Removed
- [fleet-carriers] Remove the process-wide concurrency limit from Carrier dispatches.

## [1.26.2] - 2026-07-15

### fleet-core

#### Fixed
- [fleet-admiral] Use `command_windows` PowerShell overrides for Fleet-managed Codex hooks on Windows.

## [1.26.1] - 2026-07-14

### fleet-desktop

#### Fixed
- [fleet-console] Open terminal HTTP and HTTPS links in the external browser while blocking non-web schemes.

### fleet-plugin

#### Changed
- [fleet-console] Upgrade Console terminal rendering to xterm 6 while preserving manual scrollback and themed viewport fill.

#### Fixed
- [fleet-console] Pass validated OSC 8 destinations in the initial browser request while preserving the navigation warning.
- [fleet-console] Copy local terminal selections to the clipboard after mouse dragging.
- [fleet-console] Copy selected terminal text on Windows with Ctrl+Shift+C without opening browser DevTools or interrupting the active CLI.

### fleet-core

#### Fixed
- [fleet-admiral] Restore multiline input for Codex sessions on Windows.

## [1.26.0] - 2026-07-13

### fleet-cli

#### Fixed
- [fleet-cli] Submit carrier-result reminders to the Codex TUI on Windows instead of leaving them unsent in the prompt.

### fleet-console

#### Added
- [fleet-console] Expose a stable loopback pairing identity for optional Desktop supervision without a separate Console feature mode.
- [fleet-console] Add a Grid / Columns / Rows layout selector to Formation view; Columns splits panels into full-height vertical columns for ultrawide monitors, and the choice is remembered per machine.

#### Changed
- [fleet-console] Restore the minimap collapse controls while hiding Map surfaces during Formation and panel maximization.
- [fleet-console] Show sidebar action controls only on hover or keyboard focus so Operation names have more room.
- [fleet-console] Float the carrier stream dock as an overlay so expanding it no longer resizes the terminal.
- [fleet-console] Enter Formation view from the layout buttons, move Reset view to an inline sidebar button, and unify the canvas right-click menu with the sidebar menu as a single Launch list.

#### Fixed
- [fleet-console] Restore mouse-wheel scrolling for long Codex Wiki entry lists in the right rail.
- [fleet-console] Keep Command Band context progressively centered while resizing the Console and side chrome.

#### Removed
- [fleet-console] Remove the Alt+Shift+F shortcut that opened Formation view including minimized panels.
- [fleet-console] Remove Cursor from interactive Operation launch controls and Console session capture.

### fleet-desktop

#### Added
- [fleet-console] After Desktop completes its normal Console startup, connect to a running local Fleet Console from the macOS app menu or Windows and Linux tray using a Desktop-owned sandboxed prompt.

### fleet-plugin

#### Changed
- [fleet-console] Improve File Explorer responsiveness when listing large directories by prefetching the bounded directory window.

#### Fixed
- [fleet-console] Restore macOS Terminal PTY startup when the node-pty helper is installed without execute permissions.
- [fleet-console] Submit terminal carrier-result reminders to Codex reliably on Windows ConPTY.

### fleet-core

#### Removed
- [fleet-admiral] Remove Cursor launch injection and plugin rendering from Fleet Admiral while retaining the Cursor backend for Carriers.

## [1.25.0] - 2026-07-12

### fleet-console

#### Added
- [fleet-console] Add `Mod+B` and `Mod+Alt+B` shortcuts to toggle the left sidebar and right Activity Rail.
- [fleet-console] Add a minimize button to left sidebar operation chips so a panel can be minimized directly from the sidebar; it appears on hover to the left of the close button, and is hidden on already-minimized chips and on inactive-Theater preview chips.
- [fleet-console] Show inactive Operation names beside their panel status beacons with inline rename controls.

#### Changed
- [fleet-console] Split the sidebar Formation view toggle into a two-segment control, giving open-panel and include-minimized formation each their own button.
- [fleet-console] Organize What's New into Overview and product tabs while preserving legacy and mixed release updates.
- [fleet-console] Formation view's open-panel segment now leaves minimized and maximize-docked panels in the dock, arranging only the currently open panels; the include-minimized segment still restores every panel first.
- [fleet-console] Start existing Operation panels minimized the first time each Theater opens in a session, and reveal a selected panel on its own.
- [fleet-console] Keep the minimap visible in the default canvas view and remove the Map collapse button.

#### Fixed
- [fleet-console] Keep What's New controls visible when release notes overflow the modal body.

### fleet-desktop

#### Added
- [fleet-console] Synchronize the Fleet Desktop Windows title bar overlay with the saved Fleet Console theme and live theme changes.
- [fleet-console] Add native Console zoom and reload controls with persistent zoom levels.

#### Fixed
- [fleet-console] Restore Agent CLI discovery from the macOS login-shell PATH.
- [fleet-console] Prevent back navigation from reopening the bootstrap page after Console handoff.

### fleet-plugin

#### Changed
- [fleet-console] Rework the Diff History commit view into a Segmented Commit Inspector: a Details tab with author, relative and absolute timestamps, a copyable full SHA, clickable parents, ref chips, and the message body, and a Changes tab with per-file navigation, a list or tree view of changed files, and syntax-highlighted diffs.
- [fleet-console] Keep the commit subject legible at the default History rail width, keep the branch graph as the left master, and add resize dividers between the graph, inspector, and file panes.
- [fleet-console] Default new Codex Agent CLI settings to App Server while preserving explicit ACP selections.

#### Fixed
- [fleet-console] Align the Diff History commit graph nodes with their commit rows so each graph marker no longer sits half a row below the commit it belongs to.
- [fleet-console] Preserve terminal scroll intent when streaming status panels or other layout changes resize the terminal.

### fleet-core

#### Changed
- [fleet-carriers] Retain finalized carrier job information for 6 hours.
- [core-unified-agent] Use App Server for Codex connections when no launch-mode override is configured.
- [core-unified-agent] Deliver Claude and Codex Carrier instructions with the submitted prompt and require Kirov dispatches to name and produce their plan file.
- [fleet-carriers] Run each Carrier dispatch in a fresh CLI process, return a `context_id`, and resume its real provider session when callers pass it back as `resume_context_id`.

## [1.24.0] - 2026-07-11

### fleet-cli

#### Added
- [fleet-cli] Apply the saved Codex launch choice when opening new carrier sessions.

#### Removed
- [fleet-cli] Remove the deprecated `--native` terminal-only launch mode so Fleet CLI always opens the embedded two-pane app.

### fleet-console

#### Added
- [fleet-console] Add a Typography Font Browser with atomic UI font and size preferences.
- [fleet-console] Add a server-saved global UI font preference with curated Manrope, JetBrains Mono, and Source Code Pro choices.
- [fleet-console] Add a Plans activity rail panel that lists the active Theater's execution plans with wave/task progress and parallel-lane dispatch readiness, and opens them in a hardened in-panel markdown reader.
- [fleet-console] Add a temporary Formation view for supervising visible Operations.
- [fleet-console] Add a shared Activity Rail path context for selecting a Theater root, worktree, or directory.
- [fleet-console] Unify window chrome into a 44px Command Band: sidebar and Activity Rail toggles, Operation search, and the Formation view toggle now live at fixed window positions that never move when panels collapse.
- [fleet-console] Animate sidebar and Activity Rail collapse and expand with a 200ms width transition that is fully disabled under prefers-reduced-motion.
- [fleet-console] Retire the floating edge expand tabs and the sidebar header button row; Add Theater moves to a full-width row at the top of the sidebar.
- [fleet-console] Move the Fleet brand mark into the Command Band as the Operations home button and widen the macOS traffic light inset.
- [fleet-console] Reinterpret the band center as a breadcrumb of the active Theater, the active panel name with double-click rename, and the panel CLI shown as an icon and text tag.
- [fleet-console] Minimize the panel hover controls to the status dot plus minimize, maximize, and close, with the dot resting in the close slot and sliding left on hover.
- [fleet-console] Surface the Activity Rail path context chip in the Command Band as a second synchronized surface.
- [fleet-console] Replace the sidebar brand foot with System Menu and Help drop-ups, move Keyboard Shortcuts into a Help modal, and remove it from the canvas context menu.
- [fleet-console] Keep the Command Band on the Settings and Carriers routes with brand and search only, and retire their back-to-Operations links.
- [fleet-console] Add English and Korean What's New release notes with a server-persisted language preference.

#### Changed
- [fleet-console] Redesign Fleet Console with the Instrument visual system and full-height progressive navigation.
- [fleet-console] Split Formation shortcuts for open panels and restoring minimized panels.
- [fleet-console] Operation panels drop the separate title bar for an integrated single surface; each panel shows only a status dot at rest and reveals a top-right cluster with its name, CLI badge, and window controls on hover, which also serves as the drag handle.
- [fleet-console] Replace the sidebar Canvas controls button with a Formation view toggle and swap the search and collapse buttons.

#### Fixed
- [fleet-console] Restore the Theme section in General settings with Instrument (default), Maritime, and Carbon themes.
- [fleet-console] Command Band background now follows each theme's chrome palette, fixing the overly dark center and right segments in the Maritime and Carbon themes.
- [fleet-console] Restore user-selected accent perimeters on Map Operation panels and side ticks on Operations SideBar chips.
- [fleet-console] Activity Rail resize drag now tracks the cursor 1:1 instead of easing behind it and catching up only after the pointer stops.
- [fleet-console] Require confirmation before closing a Map session panel.
- [fleet-console] Clean stale plugin bundles at startup and current-run bundles at shutdown without disturbing active Console processes.

#### Removed
- [fleet-console] Remove the English fallback badge from localized What's New release notes.

### fleet-desktop

#### Added
- [fleet-console] Introduce Fleet Console Desktop 0.1.0, an optional native home for the full Fleet Console experience.
- [fleet-console] Set up and maintain the managed Console runtime automatically, including first-run installation, launch-time updates, offline fallback, and safe recovery from interrupted installs.
- [fleet-console] Provide native desktop lifecycle controls with single-instance window restore, platform title-bar integration, tray and menu actions, update prompts, and clear startup conflict guidance.
- [fleet-console] Keep the desktop shell lightweight by downloading Console code only when needed while preserving Fleet Console data independently from the removable managed runtime.

### fleet-plugin

#### Added
- [fleet-console] Add an Agent CLI setting to choose ACP or App Server for new Codex carrier sessions, defaulting to ACP.
- [fleet-console] Add a Terminal Font Browser with built-in and installed monospace font choices, preview, and durable server settings.
- [fleet-console] Filter changed files and history commits directly in the Diff rail.
- [fleet-console] Let supported Activity Rail panels follow the selected Theater root, worktree, or directory context.

#### Changed
- [fleet-console] View repository history in its own right-rail panel across all branches and linked worktrees.

#### Fixed
- [fleet-console] Restore per-theme terminal color palettes so Operation terminals follow the selected theme.
- [fleet-console] Fix Diff panels for file selection, non-Git Theaters, and narrow History layouts.
- [fleet-console] Search unopened File Explorer folders recursively and resize History detail panes by dragging.
- [fleet-console] Hook-provided panel names now apply only once per running panel while preserving operator renames.

### fleet-core

#### Added
- [core-infra] [core-unified-agent] [fleet-admiral] Persist the Codex ACP or App Server launch choice and route carrier sessions accordingly, defaulting to ACP.
- [fleet-carriers] Add a machine-readable checkbox task contract to plan authoring and wave-completion progress write-back, so execution progress becomes visible in plan files and the Console Plans surface.

#### Changed
- [fleet-carriers] [fleet-admiral] A single Kirov plan can declare safe parallel Ohio lanes; Ohio accepts an execution_scope to run one Dispatch Manifest lane for Parallel plans and preserves full sequential execution for legacy or Sequential plans.

#### Fixed
- [fleet-admiral] [fleet-carriers] Make naval role-playing follow the metaphor option while keeping the default prompt and carrier metadata neutral.

## [1.23.0] - 2026-07-10

### Changed
- [fleet-console] Carrier Stream keeps reasoning out of the dock while preserving it in collapsible Details and showing a thinking state.
- [fleet-console] Carrier Stream Details can stay pinned to the latest output with a Follow control.
- [fleet-console] Carrier Stream keeps completed jobs visible in Details and briefly in the dock.
- [fleet-console] Carrier Stream makes error tracks coral and treats connecting tracks as live.
- [fleet-admiral] Cursor Agent sessions now receive Fleet doctrine through a sessionStart hook additional_context injection instead of an alwaysApply rules file.

### Fixed
- [core-unified-agent] Codex system prompts and config overrides are now reliably applied on new ACP sessions across all platforms; previously they were silently dropped.
- [fleet-console] Update Available badge now appears in open tabs without a page refresh when a new console release is detected.

## [1.22.1] - 2026-07-10

### Added
- [core-unified-agent] Switch Codex ACP to the official bridge, add GPT-5.6 Codex model support with updated reasoning effort levels, and preserve deprecated ACP model type aliases for migration compatibility.

## [1.22.0] - 2026-07-08

### Changed
- [fleet-console] Codex wiki documents now render flat on the reading surfaces: the rounded glass card around the document body is removed while the document header (breadcrumb, title, tag chips, updated chip) is preserved.
- [fleet-console] Replaced the console's primary navigation with a bottom command status bar, Theater tree, and right-rail route controls.

### Removed
- [fleet-console] Remove the copy-context action buttons (Compact context, Provenance, Context pack, Why this matched) from the bottom of Codex wiki entries.

## [1.21.0] - 2026-07-06

### Changed
- [fleet-admiral] [fleet-carriers] Slimmed the always-injected Admiral system prompt by about 19%: the carrier roster now carries selection and routing metadata only, while per-carrier request-block contracts moved to a new on-demand carrier-contracts skill loaded before the first dispatch of a session.
- [fleet-admiral] Unified duplicated Downward Guard trigger lists into the Protocol Gate as the single source, compressed the Context Confidence and Result Integrity Standing Orders without changing their rules, and moved the cross-carrier feedback pattern table into the frontline protocol skill.
- [fleet-admiral] The Protocol Gate now declares skill loading idempotent per session, so already-loaded skill content is applied without reloading.
- [fleet-carriers] Dispatch requests rejected for missing required request blocks now echo the target carrier's full request-block contract in the error, allowing recomposition without a prior contract lookup.

## [1.20.0] - 2026-07-06

### Added
- [fleet-admiral] Add the Command Integrity Standing Order: the Admiral now pushes back on technically flawed orders with reasoned objections, clarifies decision-shaped requirement ambiguity before starting work, refuses to assume permissions beyond the explicitly granted scope, and arbitrates conflicting directives by safety, correctness, clarity, then efficiency.
- [fleet-admiral] The Admiral system prompt now instructs recursive AGENTS.md doctrine loading for every touched directory across all protocol modes, with the deepest applicable file taking precedence.
- [fleet-console] Add drag-to-reorder for Operation groups by dragging group headers in the Operations sidebar.

## [1.19.0] - 2026-07-05

### Added
- [fleet-admiral][fleet-cli][fleet-console] Cursor Agent can now be launched as a first-class Agent CLI runtime with rules-delivered Fleet doctrine, MCP, and session-capture support.
- [fleet-console] Diff panel now shows a collapsible "History" section under Changes, listing recent commits with a single-lane graph gutter (Flat/Graph toggle). Selecting a commit renders its full multi-file patch in the extended diff pane. A multi-lane topology (up to three active lanes, with overflow collapsed) visualises merges and branches within HEAD-reachable history.
- [fleet-console] Added bundled Nerd Font symbol fallback support for terminal glyph rendering.
- [fleet-console] Added a Theater-independent Global Shell panel in the right rail.

### Changed
- [core-process][core-agent][core-unified-agent] Windows executable path resolution and child-process console-window suppression are now provided by a shared internal core-process package, replacing the logic that was previously duplicated across the agent CLI and console runtimes.
- [core-unified-agent] Renamed the Claude and Codex provider display names to "Claude Code" and "Codex".
- [core-infra] Renamed the Fleet infrastructure package to reflect its domain-agnostic role; all consumers are updated transparently with no behavior change.
- [fleet-admiral] [fleet-carriers] Data directory resolution is now self-contained, so carrier storage and marketplace assets always resolve to the single Fleet home directory no matter which host launches them.
- [fleet-console] [fleet-cli] Removed host-side data directory injection, fixing duplicate marketplace rendering and carrier settings that previously failed to persist when changed from the console.
- [fleet-console] Removed the raw data directory path from the plugin host contract so plugins no longer receive it.
- [fleet-console] Terminal launch menus and SideBar chips now show distinct official-style brand icons for Claude and Codex agent sessions instead of one shared glyph.
- [fleet-console] Terminal launch menus and SideBar chips now show the official-style Cursor brand icon for Cursor agent sessions instead of the neutral fallback glyph.

### Fixed
- [fleet-console] Restore README images and file links in File Explorer markdown previews.
- [fleet-console] Terminal Shell sessions now preserve raw TUI cursor movement so nvim-style fullscreen apps repaint reliably.
- [fleet-console] Diff and File Explorer rail panels now keep the right-hand list or tree column at a fixed width when opening a file or diff, assigning all extra panel width to the left document or viewer pane.
- [fleet-console] Narrow or aggressively resized rail panes progressively hide secondary labels and badges instead of clipping content, so extreme drags and tight panel widths no longer collapse the layout.
- [fleet-console] File Explorer expands the rail panel only while a file preview is open, returning to a single-column tree when the viewer is closed.

### Removed
- [fleet-cli][fleet-console] Removed the System Prompt Injection option (the Append/Replace toggle in Console Terminal settings and the CLI Mission Control "System prompt" row, plus the `FLEET_REPLACE_SYSTEM_PROMPT` environment override). Fleet doctrine is now always layered on top of Claude Code's built-in system prompt (Append) and always delivered to Codex through its profile's developer instructions.

## [1.18.0] - 2026-07-04

### Added
- [core-unified-agent] OpenCode Go model selection now includes GLM-5.2 and Kimi K2.7 Code.

### Changed
- [fleet-carriers] Carriers now wrap their final output in a `<report>` block; `carrier_jobs(format:"full")` extracts and returns only that block, falling back to the full archive when absent, and a new `format:"raw"` option returns the unprocessed archive for debugging.
- [fleet-carriers] Removed redundant echo fields (`action`, `format`, `summary_available`) from `carrier_jobs` responses, and removed derived fields (`attribution`, `available`, `statLine`) from the workspace-changes DTO to reduce response payload size.
- [fleet-console] Carrier streaming in the Agent panel is now a resident collapsible stream dock pinned to the panel bottom: live output, elapsed time, and a token estimate are always visible without clicking; the dock collapses to a single-line tail and its state persists per browser. Clicking "Details" in the dock header opens the existing full-stream overlay for complete track history. For single-carrier jobs, the dock border and background are tinted with the CLI signature color (claude, codex, opencode-go, cursor, or taskforce), the carrier name is colored by the captain token, and the dispatch request label is shown below the dock header.
- [fleet-admiral][fleet-cli] Codex launches now use a fixed Fleet-managed profile with hooks enabled instead of session-scoped profiles or hook trust bypassing.
- [core-unified-agent] Cursor Agent model selection now includes Kimi K2.7 Code and GLM 5.2 while removing older Sonnet and Opus 4.7 options.
- [fleet-console] Selecting a file in the Diff panel now extends the panel into a two-pane bridge with an inline diff document view, replacing the draggable split divider.
- [fleet-console] Diff panel file rows now lead with the file name, and the repository picker opens as an opaque in-panel deck with inline worktree rows.
- [fleet-console] Diff panel repository dropdown now groups linked worktrees under their parent repository with a collapsible disclosure, instead of listing them as independent entries.
- [fleet-admiral] The Artifact Inspection Gate now requires evidence before an Admiral classifies a carrier-diff deviation as harmless: a deviation is treated as a defect unless it is confirmed to change no observable behavior, contract, or output and to be unreachable by any real execution path.
- [fleet-console] Repeated alerts from the same Operation panel now replace the previous alert instead of accumulating a count; ALERTS badges and Theater group tallies show the number of panels with an active alert, and the per-row repeat-count badge is removed.
- [fleet-console] Skills panel shows update and install progress in a collapsible status dock docked to the bottom of the panel, keeping the skill list unobstructed; the dock auto-dismisses on success and keeps a Retry action on failure.
- [fleet-console] Compacted the Agent panel carrier stream dock into a single-row signal strip (live pulse, carrier name, latest output line, elapsed time, and token estimate in one line) that expands to one compact row per track; the duplicated carrier name, redundant live badges, and the large fixed dead space below the stream are removed, and multi-carrier tracks now show captain-colored names.

### Fixed
- [fleet-admiral][fleet-cli] Fleet Codex profile rewrites now preserve persisted hook trust state for unchanged hooks.
- [fleet-console] Restored the drag-to-resize divider between the diff document pane and the changed-files list in the Diff panel.
- [fleet-console] Session rename panel names now stick: user-set names are never overwritten by auto-name, auto-name fires on every subsequent prompt (not just the first), and renames are reflected in the browser in real-time via a new SSE channel without requiring a page refresh.

### Removed
- [core-unified-agent][fleet-infra][fleet-admiral][fleet-cli][fleet-console] Removed Claude Kimi, Claude GLM, and Claude ZAI alias providers from active catalogs, launch profiles, authentication flows, Console model sign-in, and documentation while preserving OpenCode Go support.
- [fleet-carriers] [fleet-admiral] [fleet-cli] [fleet-console] Remove Native Subagent mode; carriers always run in CLI dispatch mode while carrier_dispatch and Task Force remain unchanged.

## [1.17.1] - 2026-07-03

### Fixed
- [fleet-console] Terminal text on the Operations canvas no longer renders blurry after panning or zooming; panels snap to whole pixels, and maximizing a panel renders at the default zoom so the terminal stays crisp regardless of the current map zoom.

## [1.17.0] - 2026-07-02

### Added
- [fleet-console] Console plugins can now persist their own settings on the console server, stored per plugin, so plugin settings survive browser changes and console restarts.
- [fleet-console] Terminal font name and size now persist across browsers and console restarts; existing per-browser font preferences are migrated automatically on first load.
- [fleet-console] File Explorer now offers a manual refresh button in the toolbar, re-reads folder contents every time a directory is expanded, and live-updates the file tree as files change on disk.
- [fleet-console] Add a built-in Skills plugin to the Activity Rail for searching the skills.sh registry, installing skills with inline progress streaming, updating, removing, and reading SKILL.md in an overlay.

### Changed
- [fleet-console] The Diff panel can now target any Git repository nested under the current Theater instead of only the Theater root; pick one from the toolbar, with its current branch shown and a selectable scan depth.
- [fleet-console] The Diff panel now shows a single combined Changes list (staged and unstaged together) instead of separate Staged and Changes sections.

### Fixed
- [fleet-console] Fixed the Diff panel repository picker dropdown not appearing when clicked because it was positioned outside the panel and clipped.
- [fleet-console] The Diff panel no longer auto-selects a nested repository when the Theater root is not a Git repository; pick one explicitly from the toolbar picker instead.
- [core-unified-agent] [fleet-carriers] Include redacted Codex ACP stderr diagnostics in failed carrier jobs without adding stderr to successful results.
- [fleet-console] Hid unsupported Claude Kimi and Claude GLM launch aliases from Operation Controls.
- [fleet-console] YAML frontmatter at the top of a Markdown document (such as a SKILL.md preview) now renders as a labeled metadata card instead of collapsing into one oversized heading.
- [fleet-console] Fixed the Skills SKILL.md reading overlay collapsing to only a few lines tall; it now opens at a stable reading height with a scrollable body.

## [1.16.1] - 2026-07-02

### Fixed
- [fleet-console] Restored the Codex Drydock patch review flow: pending patches now render as a compact, clickable list, each opens its proposed wiki document in the Codex reading view, and can be approved or rejected with a reason from the rail or the expanded reading overlay.
- [fleet-console] Disabled unsupported Claude Kimi and Claude GLM launch options in Operation Controls.
- [fleet-console] Korean IME input now keeps composed text together when Shift+Enter inserts a newline in terminal panels.

## [1.16.0] - 2026-06-30

### Added
- [fleet-console] Add a collapsible, resizable right-side Activity Rail that docks workspace tools as icon tabs beside the Operations map; selecting a tool slides its panel in and reflows the map, clicking the active icon collapses it, and the rail remembers its active tool, width, and open state across reloads.
- [fleet-console] Add a File Explorer tool that browses and filters the active Theater's files and, on selecting a file, splits the panel into a resizable file view beside the tree with syntax-highlighted code, rendered markdown, image previews, and a binary fallback; large trees stay smooth via row virtualization.
- [fleet-console] Add a Diff tool that lists the active Theater's changed files and shows their unified diffs, switchable between working-tree and staged changes.
- [fleet-console] Fleet Console now discovers and loads third-party client plugins installed under `~/.fleet/plugins`, rendering their Operation panels and Settings sections alongside the built-in Terminal.
- [fleet-console] Plugins declare an `apiVersion` for compatibility; an incompatible or failing external plugin is skipped without breaking the console.
- [fleet-console] External plugin client code shares the console's React and SDK singleton through runtime shims, while plugin routes run in the host Node process under dedicated `/plugin-runtime/` endpoints.
- [fleet-console] Rename an Operation directly from the left Operations SideBar by double-clicking its name.
- [fleet-console] Operations SideBar now supports named groups: create, rename, recolor, and dissolve groups from a right-click menu, drag chips between groups, and collapse or expand a group's member chips. Group membership is shown by a colored rail that stays independent of the accent and in-progress status channels.
- [fleet-console] Added a side bar map setting for turning Operation panel pulse animation on or off while preserving the running-state signal.
- [fleet-console] Right-click an empty area of the left Operations SideBar to open the New Operation launcher at the cursor, the same overlay as the New Operation button.

### Changed
- [fleet-console] Set an Operation's accent color by clicking its status indicator - on the panel title bar or on its side bar entry - which opens a color popover; the dedicated accent button is gone, and clicking the side bar indicator lets you accent any Operation including minimized ones.
- [fleet-console] An Operation's accent color now outlines its canvas panel as well as its side bar entry, taking over the focus outline in the chosen hue and staying visible whether or not the Operation is focused, running, awaiting, or minimized.
- [fleet-console] Carrier output now streams inside the Agent panel as a summary banner at the top that opens a detail modal on click, instead of spawning a separate child streaming panel.
- [fleet-console] Codex moves into the right-rail as a built-in panel; the /console/codex full route, the side-overlay edge handle, and the codex view-mode toggle are removed.
- [fleet-console] Codex client no longer mutates browser history or reads the URL; workspace selection is driven by Theater state.
- [fleet-console] Codex server drops the admin workspace registration endpoint and the bearer-token surface; Theater registration and restart restoration remain the only mount paths.
- [fleet-console] Standalone fleet-wiki CLI removed; Codex enters via the Theater-scoped right-rail panel only.
- [fleet-console] Redesigned the Codex knowledge panel for the right rail: a compact single-column navigator (search, entry list, Drydock badge, conflicts) replaces the cramped three-pane layout. Selecting an entry opens an inline two-pane split - the document on the left, the navigator still browsable on the right - and an Expand control opens a centered, comfortably wide reading overlay with a table-of-contents rail. The Codex markdown reading style is preserved throughout.
- [fleet-console] Streamlined the Codex backend to four REST resources (search, entry, drydock, conflicts); raw source is now embedded in the entry response and the retired endpoints return 404.
- [fleet-console] Replaced the bottom Operations taskbar and the canvas launcher button with a collapsible, resizable left side bar that lists every open Operation vertically by its kind icon. Click a chip to focus its panel (right-click a chip to set its accent colour), drag or use Alt+Shift+Up/Down to reorder, and use the "+ New" button to create Operations. A settings button beside "+ New" holds map fullscreen, radar sweep, panel pulse, and the keyboard-shortcut reference; the "+ New" and settings menus open as overlays beside their buttons. Side bar width and collapsed state persist per browser, and at its narrowest the bar collapses to a centred icon rail.
- [fleet-console] The right Activity Rail and the File Explorer and Diff split panels now track the pointer immediately while resizing, instead of easing behind the cursor and only catching up when the drag stops.
- [fleet-console] The ambient radar sweep and panel pulse animations now default to off when the console runs from a local unpublished build (`pnpm`), so development restarts start quiet; published builds keep them on by default, and an explicit per-browser toggle preference always wins over the channel default.
- [fleet-console] The Diff panel now shows a clear English message when the selected folder is not a Git repository or when Git is not available, instead of a cryptic raw error.
- [fleet-console] All File Explorer panel text is now in English.
- [fleet-console] All console backend routes are now served under a unified `/api/v1` prefix, with settings consolidated under `/api/v1/settings/*` and updates under `/api/v1/updates/*`.
- [fleet-console] Carrier settings now accept partial updates through a single `PATCH /api/v1/settings/carriers/:id` endpoint, replacing the four separate single-field mutation routes.
- [fleet-console] Console Settings General (theme and console port) is now persisted server-side in the console data directory; the selected theme is shared across browsers and survives restarts instead of being remembered only per browser.
- [fleet-console] Settings now groups console-owned controls separately from plugin-owned controls, with the self-contained Terminal Agent CLI section unifying system prompt controls, model sign-in, and CLI availability.
- [fleet-console] Merge Appearance settings into General (Theme card + Console Port card); remove the Appearance nav item from the Settings left rail.
- [fleet-console] Move Terminal Font and Terminal Renderer settings from core to the Terminal plugin; the Agent CLI settings section now owns these two cards, and all terminal panels react instantly via a module-scoped store.
- [fleet-console] Fleet Console self-update now applies immediately regardless of active terminal sessions; the update no longer blocks while a terminal session has a live PTY.
- [fleet-console] The Diff and File Explorer rail panels now use self-contained plugin-local backend routes (`/plugins/diff/*`, `/plugins/file-explorer/files/*`) instead of core console server routes, completing the plugin platform architecture.
- [fleet-console] Diff panel now shows staged and unstaged changes as two simultaneously-visible collapsible sections (VS Code Source Control style), surfaces newly-created (untracked) files that were previously invisible, and adds a List / Tree view toggle in a plugin-owned toolbar.
- [fleet-console] The Diff panel's file-tree and hunk views are now separated by a draggable divider, and the split ratio persists per browser.
- [fleet-console] Extract shared markdown renderer and Mermaid hydrator into the `@fleet-console/markdown` workspace package so Codex reading and built-in plugin previews share one implementation.
- [fleet-console] file-explorer `.md` preview now uses the same markdown engine and styles as Codex (GFM, syntax highlighting, Mermaid diagrams, code toolbar).
- [fleet-console] File Explorer now opens as a persistent two-pane split (preview left, tree right) with a placeholder when no file is selected, widens the activity rail slot while active, and retains the in-session preview and split position when switching Theaters.
- [fleet-console] File Explorer now shows colorful, file-type-specific icons - distinct shapes and per-language colors across code, data, style, document, image, shell, config, database, archive, and binary files - replacing the previous single-color glyphs. Directories now use open/closed folder icons with accent colors for well-known folders (such as src, test, node_modules, dist, docs, and .git), replacing the plain disclosure chevron. The whole icon palette adapts to the active Maritime or Carbon theme.
- [fleet-console] Reworked Operation status indicators: removed the unused live state, so carrier streaming now shows as running.
- [fleet-console] Recolored Operation status: awaiting is now aurora (teal) and idle is now green, and an idle panel no longer animates its perimeter.
- [fleet-console] An Operation whose agent turn has ended keeps the running indicator while a carrier job is still streaming, then settles to idle once streaming finishes.
- [fleet-console] An Operation raises an alert when it transitions into idle or awaiting.
- [fleet-console] Terminal session panels no longer append a `#N` sequence number to their titles, so multiple sessions in the same Theater can share the same name.
- [fleet-console] Theaters and terminal sessions saved by an earlier console version are now automatically migrated and preserved when upgrading instead of being reset.
- [fleet-console] Removed the parent/child Operation tree concept; the Operations canvas no longer renders the command tether and every Operation is a top-level item.
- [fleet-console] Console durable state is simplified to a single `operations` collection. The on-disk schema is bumped without a migration path, so existing `state.json` files are reset on first boot and previously registered Theaters and Operations are forgotten.
- [fleet-console] The plugin SDK API version is bumped for the operations contract change, so external plugins built against the previous SDK are now rejected as incompatible instead of failing at runtime.
- [fleet-console] Operation groups in the Operations left sidebar are now marked by a continuous colored rail down the group's left edge and a tinted group header, replacing the small per-entry color stub, so a group reads as one bounded run at a glance.
- [fleet-console] Moved Theater folder selection into the console while making Terminal plugin sessions, tickets, and WebSocket transport self-contained for Shell and Agent operations.
- [fleet-console] Reset the external plugin API compatibility version to 1; built-in plugin manifests now declare apiVersion 1 to match.
- [fleet-console] Reset the console durable state schema version to 2.

### Fixed
- [fleet-console] Agent operation panels now enter the awaiting state for every input-waiting hook event, including AskUserQuestion prompts that previously left the panel inactive; idle prompts are no longer treated as a blocking signal.
- [fleet-console] ALERTS now surfaces Awaiting and Complete notifications for every operation except the one you are actively viewing, regardless of its Theater or minimized/maximized state; previously notifications were suppressed for all operations while the Operations canvas was open, so the rail stayed empty.
- [fleet-console] Opening an alert from ALERTS - or a result from the Operation quick-search - while an Operation panel is maximized now keeps the maximized view and switches it to the target Operation, instead of collapsing the maximized view.
- [fleet-console] Creating a new Operation while a panel is maximized now keeps the maximized view and makes the new panel the maximized one, instead of dropping out of the maximized view.
- [fleet-console] Fix the globally installed Fleet Console failing to start with a missing-React module error; the published package is now self-contained again, so the console and its built-in plugins load correctly after an npm install.
- [fleet-console] Cycling Operations with Alt+Left/Right now follows the order shown in the Operations side bar - including any manual drag reordering - instead of a fixed creation-time order, so focus moves to the panel you expect.
- [fleet-console] The Operations canvas surface (map background and sea wash) now follows the active theme instead of being locked to the Maritime palette, so the Carbon theme renders a neutral dark canvas; the Maritime appearance is unchanged.
- [fleet-console] The Operations canvas radar sweep now animates whenever Radar sweep is enabled, no longer requiring Panel pulse to be on; Panel pulse independently controls the remaining ambient animations.
- [fleet-console] Double-clicking an Operation's name in the Operations Left SideBar now reliably opens its inline rename editor.

### Removed
- [fleet-cli] Remove the Mission Control Wiki Server panel and the `fleet wiki` subcommand; the standalone fleet-wiki binary they relayed to was decommissioned.
- [fleet-cli] The bundled `fleet-wiki` package is retained for wiki tool specs and entry count used by the MCP runtime and Mission Control status line.

## [1.15.0] - 2026-06-26

### Added
- [fleet-console][fleet-infra] Add a Settings -> General control to pin a static console port, with automatic fallback to a dynamic port and Settings feedback when the chosen port is unavailable.

### Changed
- [fleet-console] An in-progress operation no longer animates the running-light perimeter ring in both its canvas panel and its dock chip at the same time. The rotating ring now shows on the canvas panel while the panel is visible, and on the dock chip only while the panel is minimized, lowering GPU usage. The dock chip keeps its progress glow and beacon in both cases.

## [1.14.0] - 2026-06-26

### Added
- [fleet-console] Added per-browser terminal font family and size controls that apply live to all open terminals.

### Fixed
- [fleet-console] Preserve maximized Operation panel state independently across Theaters.

## [1.13.0] - 2026-06-25

### Added
- [fleet-console] Add a favicon so the console shows a distinct icon in the browser tab and bookmarks.
- [fleet-console] Reorder dock taskbar panels by dragging a chip to a new position, or with Alt+Shift+Arrow while a chip is focused; the arrangement persists per Theater.
- [fleet-console] Mark a dock taskbar panel with a custom accent color from a 16-color palette; the color rings the whole panel perimeter (the same edge the in-progress indicator rides) while system status signals stay intact, and the choice persists per Theater.

### Changed
- [fleet-console] Dock taskbar close now requires a second confirming click, preventing accidental panel removal.

### Fixed
- [fleet-admiral] Launching the Codex CLI no longer fails to start on Codex 0.142.0 and later; Fleet was passing a Codex feature flag that newer versions removed, which made Codex abort on startup.

## [1.12.0] - 2026-06-23

### Added
- [fleet-console] Add Theater directory browser can now reach other drives through a drive rail (C:, D:, and so on) and jump straight to an absolute path via a direct path input, so projects outside the home drive can be registered; the picker is also enlarged for more visible folders.

### Fixed
- [fleet-console] Keep maximized mode when adding a new Operation or shell panel from the launcher while a panel is maximized; the newly created panel now takes over the maximized overlay instead of exiting maximized mode.

## [1.11.0] - 2026-06-23

### Changed
- [fleet-console] Show every open panel in the Operations dock taskbar (not just minimized ones) and highlight the currently focused panel's chip; clicking a chip brings that panel to the front, and keeps maximized mode when a panel is maximized.
- [fleet-console] Widen the Operations dock taskbar up to the radar minimap so the chip pager no longer appears too early.
- [fleet-console] Add a "+" launcher button at the bottom-left of the Operations canvas that opens the new-panel menu, usable even while a panel is maximized.
- [fleet-console] Move the Alerts notification toggle and panel to the right edge, above the Codex side handle.
- [fleet-console] Hide the floating canvas controls (minimap, shortcuts, and the fullscreen and background-animation toggles) while a panel is maximized, and highlight the maximized panel's maximize button.
- [fleet-console] Reworked the Operations canvas panels into an OS-style window system with a persistent taskbar, panel maximize, Shell parity, and stable panel cycling.

## [1.10.2] - 2026-06-21

### Changed
- [fleet-console] Clicking the already-active Carriers or Settings navigation button now returns to the Operations canvas.
- [fleet-console] What's new now loads all release notes at runtime from the server-proxied main changelog.
- [fleet-console] The What's new version selector now shows ten releases per page with previous/next pagination.

## [1.10.1] - 2026-06-21

### Fixed
- [fleet-console] All backend API catalog descriptions in the Settings page are now shown in English; the remaining Korean entries have been translated.

## [1.10.0] - 2026-06-21

### Added
- [fleet-console] Settings now lists the console's backend HTTP API catalog in a collapsible card, populated dynamically from backend introspection so newly added routes appear automatically.
- [fleet-console] The collapsed Alerts dock now plays a one-shot outline pulse when a new alert arrives, giving peripheral feedback without expanding the dock; the pulse color follows the alert state (amber for awaiting, emerald for completed) and adapts to the active theme.
- [fleet-console] Canvas-mode operations now raise Alerts even when their panel is not minimized, so a visible canvas panel no longer suppresses its own alert.
- [fleet-carriers] carrier_dispatch now accepts an optional absolute `cwd` argument so a delegated carrier's CLI spawns at a specified working directory (such as a git worktree) instead of always the host session directory.

### Changed
- [fleet-console] The root path `/` and unknown paths now redirect to `/operations`.
- [fleet-console] The console version is now shown beneath the top-bar "Research Preview" label.
- [fleet-console] The commissioning guide now auto-appears only on the first visit.
- [fleet-console] The Alerts notification dock now collapses on outside clicks, Escape, and when navigating to a different Operation.
- [fleet-console] Settings is now a two-pane master-detail layout with Model Sign-in grouped under Agent CLI and the Backend API section expanded by default.
- [fleet-console] The backend API catalog descriptions shown in the Settings page are now in English.

### Removed
- [fleet-console] Remove the Welcome dashboard page; Operations is now the sole entry surface.
- [fleet-console] Remove the Operation and Codex navigation items from the global navigation bar; Codex is now reached only through the right-edge Side handle.
- [fleet-console] Remove the Research Preview indicator dot from the top bar.
- [fleet-console] Remove the Helm (classic) Operations mode and the Map/Helm view toggle; the Operations view is now the single Map canvas.
- [fleet-console] Remove the Operations left sidebars (the classic fixed session list and the Map floating session list).
- [fleet-console] Remove the global navigation Shell button, its overlay, and the local-shell keyboard shortcut. The in-canvas shell panel remains available.

## [1.9.0] - 2026-06-20

### Added
- [fleet-console] Fleet Console adds a Model Sign-in section to the global Settings screen to register, verify, and remove a provider API key so carriers can run on that model, starting with Moonshot Kimi; keys are validated against the provider, stored locally, and never shown back in the browser.
- [fleet-console] Installing Fleet Console globally via npm now automatically opens the console in the browser when the install finishes, limited to interactive desktop installs and skipped in CI, headless, or non-global installs; set `FLEET_CONSOLE_NO_AUTO_OPEN` to opt out.
- [core-unified-agent][fleet-admiral][fleet-infra][fleet-cli] Add Claude GLM (ZhipuAI GLM) as a selectable Claude-family provider across the CLI and Console, including `fleet auth` login/logout support.
- [fleet-console] The Settings Model Sign-in section now lists ZhipuAI GLM alongside Moonshot Kimi, so its API key can be registered, validated, and signed out directly from the Console.
- [fleet-console] Settings now shows whether each Agent CLI (Claude Code, Codex CLI, OpenCode, Cursor Agent) is installed and its detected version.
- [fleet-console] The Codex Side panel can be opened from a right-edge handle on any non-Codex view
- [fleet-console] The Codex Side panel header offers manual collapse toggles for its left (Nav) and right (ToC/Manifest) panes
- [fleet-console] The Codex Cmd+K search palette is scoped to the Side panel region in Side view instead of covering the full screen
- [fleet-console] The Codex Wiki reading view caps the body to a single reading measure and reclaims wasted whitespace on wide screens, drops the empty rail on browse and index views, and folds the raw source view into the same shell
- [fleet-console] The Codex Wiki reading rail lists the table of contents first with active-section highlighting above a collapsible manifest, adds a contents drawer on narrow viewports, and shows breadcrumbs on entries
- [fleet-console] Console self-update flow applies a global `fleet-cli` + `fleet-console` update directly from the topbar button instead of opening an npm registry link.
- [fleet-console] Self-update blocks while a terminal Operation has a live PTY and rejects local/unpublished builds, then restarts the console on a fresh random loopback port and opens it in a new browser window.
- [fleet-cli] CLI update subsystem now shares the generic core-agent package-updater substrate while preserving CLI-specific shutdown and messaging lifecycle.
- [core-agent] Generic global package updater factory for package-manager detection, global-root checks, version resolution, install spawning, and manual fallback messages.
- [fleet-console] Fleet Console now shows a What's new popup that lists the installed version's changelog entries grouped by Added/Changed/Fixed/Removed; it opens automatically once after a version update and can be reopened anytime from a What's new control in the global navigation bar.
- [fleet-console] Add a GitHub repository link and live star count beside the GNB Research Preview badge
- [fleet-console] Fleet Console Operations Map panels can now be minimized to a collapsible bottom dock and restored to their original position and size by double-clicking the dock entry or its restore button; the dock collapses to a single expand/collapse handle, each entry shows the panel's status light, name, Agent CLI, and active job count, and both the collapsed handle and the entries pulse while a minimized panel is busy.
- [fleet-console] Operations are now automatically named from the first meaningful line of each submitted prompt (for both Claude and Codex sessions), so a new Operation no longer stays as the generic "#N Operation" once work starts. A manual rename always takes over and is never overwritten by auto-naming, and clearing the name re-enables it.

### Changed
- [fleet-console] Fleet Console no longer raises an Operation's completion toast while that Operation still has a carrier job running, since the work is still in progress and the live Operation panel already reflects it.
- [fleet-console] Replaced running Operation attention motion with a consistent perimeter signal across open panels and minimized Dock controls.
- [fleet-console] Aligned minimized Operation labels with open panel title typography.
- [fleet-console] The Operations Map minimized-panel dock now expands upward from a centered bottom handle (an up/down chevron), laying its entries out centered and growing them to fit the available screen width (kept clear of the left shortcuts and right radar instruments) before paging overflow behind previous/next controls with a page indicator, so existing entries no longer shift when the count changes.
- [fleet-console] A busy minimized-panel entry now signals progress with a running light that travels around its full outline instead of an outward breathing pulse, and the dock handle's attention animation only plays while the dock is collapsed.
- [fleet-console] A minimized operation now restores with a single click anywhere on its dock chip (previously a double-click), and the redundant per-chip restore button has been removed.
- [fleet-console] Operation completion and input-waiting alerts now group by Theater in a left-docked notification panel that stays available and opens or closes from an edge handle instead of a flat stack of separate toasts, showing only Operations that are not currently visible.
- [fleet-console] The notification cluster distinguishes completion and input-waiting per Operation, counts repeated input-waiting attention, and adds global mute, do-not-disturb, and per-Theater mute controls.
- [fleet-console] Cluster alerts clear automatically when an Operation resumes work, and are removed when its session or Theater is deleted, so stale rows no longer linger.
- [fleet-console] The Operation launch menus now disable an Agent CLI choice when its CLI is not installed, or when a sign-in-gated model is not signed in, labeling each disabled choice with the reason, and the server rejects session-creation requests for those CLIs.
- [fleet-console] Theme selection and terminal renderer controls move out of the global navigation bar into a new Appearance section at the top of the Settings screen, decluttering the navigation bar; both still apply immediately and are remembered per browser.

### Fixed
- [fleet-console] A Fleet Console run from source (`pnpm fleet-console`) now stores its persisted Theaters, Operations, and session captures under the project workspace instead of the shared home directory, so a development console no longer mixes its state with a globally installed Fleet Console.
- [fleet-console] Operation auto-naming now updates only from the first submitted prompt unless the operator clears the name to re-enable automatic naming.
- [fleet-console] Stopped a carrier-dispatch idle pause from raising a false "Awaiting orders" notification while the dispatched carrier job is still running; genuine input-waiting prompts (permission requests, questions, elicitation dialogs) still notify as before.
- [fleet-console] The Operations sidebar collapse state in the Map view now persists when navigating to Codex full mode and back, instead of resetting to expanded.
- [fleet-console] Operations Map panel positions and sizes now persist across a browser refresh instead of resetting to defaults.
- [fleet-console] Map shell panels now survive a browser refresh instead of disappearing.
- [fleet-console] Fixed other open Operations terminals showing a corrupted display when an additional terminal was opened or a minimized terminal was restored from the dock.
- [fleet-console] Mouse clicks and drag selections inside an Operations Map terminal now land on the correct cell after zooming the map in or out, instead of being offset until the view was reset.

### Removed
- [fleet-console] Fleet Console no longer raises a toast when a carrier sorties; the live Operation panel already reflects the active job.
- [fleet-admiral] Fleet no longer renders user-global (`~/.fleet`) or project-local (`.fleet`) skills, agents, and hooks into Agent CLI sessions; only the built-in Fleet plugin is activated.
- [fleet-admiral] Deprecated user-global and project plugin registrations and their leftover marketplace directories are pruned from Codex and the Fleet marketplace on launch.
- [fleet-infra] [fleet-cli] [fleet-console] Removed the automatic migration of legacy auth credentials from the old `~/.fleet/agent/auth.json` location; Fleet now reads and writes only `~/.fleet/auth.json`, so credentials left in the old location are no longer picked up and must be re-added with `fleet auth login`.

## [1.8.0] - 2026-06-18

### Added
- [fleet-console] Fleet Console now guides first-time operators with a commissioning walkthrough — registering a Theater, opening an Operation, and observing carriers — shown automatically on the first empty-bridge launch, reopenable anytime from the Welcome dashboard, and surfaced as a setup action in the empty Theater state.
- [fleet-console] Fleet Console adds a global Settings screen to choose the system prompt injection mode (Append or Replace) and toggle the naval metaphor tone overlay, matching the options previously available only in the Fleet CLI; changes apply to newly launched sessions.
- [fleet-console] Fleet Console raises a global top-centre toast when a background Claude Operation pauses for operator input, naming its Theater and Operation with a control to jump there; unlike the sortie toast it stays until dismissed, and the Operation currently in view is suppressed.
- [fleet-console] The Fleet Console Codex (Fleet Wiki) surface can now open as a resizable side panel beside the current view in addition to its full-page route; a navigation-bar toggle switches between Full and Side and the choice is remembered, the panel resizes freely, and it shows only the Codex content when narrowed.

### Changed
- [fleet-console] The Fleet Console Operations Map fullscreen no longer exits on the Esc key; it can now only be exited with the maximize/restore control.
- [fleet-console] The Fleet Console global navigation bar now separates global Settings from per-carrier configuration, renaming the existing carrier entry to "Carriers" and adding a dedicated "Settings" entry.

### Removed
- [fleet-console] The Fleet Console Operations Map panel title bar no longer has a focus button for zooming a panel to fit, and the title-bar double-click that triggered the same zoom is removed along with it.

### Fixed
- [fleet-console] Fleet Console now keeps a Theater's Codex (Fleet Wiki) view available after the console is restarted; previously a restart made Theaters that have wiki data incorrectly appear to have no Codex until they were removed and added again.

## [1.7.1] - 2026-06-17

Release v1.7.1

## [1.7.0] - 2026-06-17

### Added
- [fleet-console] The Fleet Console Operations Map now zooms smoothly with interpolated wheel zoom while panning stays immediate.
- [fleet-console] The Fleet Console Operations Map can open plain user-shell terminal panels in the active Theater's directory; activating one brings it to the front and highlights it as the active panel just like Operation panels, and they are not tracked as Operations or kept across reloads.
- [fleet-console] The Fleet Console Operations Map adds a right-click canvas menu to start a new Operation, open a shell, or reset the view at the cursor position.
- [fleet-console] Fleet Console Operations Map panels can now be focused by double-clicking an empty area of their title bar, in addition to the focus button.
- [fleet-console] Fleet Console Operations Map panels can now be renamed inline by double-clicking the panel name, reusing the same rename flow as the Operations list.
- [fleet-console] The Fleet Console Operations Map adds a bottom-right minimap showing all panels and the current viewport, draggable to navigate the canvas, and collapsible to a single bottom-right button that restores it when clicked.
- [fleet-console] Fleet Console Operations adds Alt+Left / Alt+Right to focus the previous / next Operation within the active Theater, working in both the Map and Helm views.
- [fleet-console] The Fleet Console Operations Map adds a collapsible bottom-left shortcut reference panel that collapses to a "?" button.
- [fleet-console] The Fleet Console Operations Map adds a maximize control next to the radar toggle that hides the global navigation bar with an animation and auto-collapses the Operations sidebar; exit with the control or Esc, remembered per browser.
- [fleet-console] Fleet Console Operation indicators now reflect the live Agent CLI turn state — grey before the first turn, amber while the agent is processing a turn, green once the turn ends, and the existing live colour whenever a carrier job is running.
- [fleet-console] Fleet Console raises a global top-centre toast when a background Operation reports a carrier sortie or stands down, naming its Theater and Operation with a Go control to jump there; it dismisses on close or after ten seconds, and the Operation currently in view is suppressed.

### Changed
- [fleet-console] Fleet Console now uses an in-console directory browser for Theater and workspace folder selection — a focused single-column folder list with breadcrumb path navigation, type-to-filter, full keyboard navigation, and single-click descent — replacing OS-native folder dialogs (PowerShell/COM, osascript, zenity/kdialog, WSL); folder browsing works from remote and headless browser sessions.
- [fleet-console] The Fleet Console Operations radar sweep animation now consumes far less CPU and pauses automatically while the browser tab is hidden.
- [fleet-console] The Fleet Console Operations Map now shows each panel's in-progress carrier job stream below the panel instead of above it.
- [fleet-console] Collapsing the Fleet Console Operations Map sidebar now hides the whole panel, leaving only a fixed expand control on the left edge.

### Fixed
- [fleet-console] The Fleet Console global navigation bar no longer overlaps the centered Theater selector with the toolbar at narrower window widths; the toolbar now progressively collapses its labels to icons and wraps onto a second row as the window shrinks, keeping the Theater selector centered.
- [fleet-console] Forgetting a Fleet Console Theater now always succeeds and removes it from the list, even when the Theater's directory was already deleted or the Theater was no longer registered, instead of failing with a "Not Found" error.

## [1.6.0] - 2026-06-16

### Added
- [fleet-console] Added a Fleet Console carrier settings page to edit each carrier's CLI, model, SubAgent mode, Task Force backends, and display name, committed with a single per-carrier save.
- [fleet-console] Fleet Console Operations now opens as a freeform terminal canvas for arranging live operation sessions.
- [fleet-console] The Fleet Console Operations canvas now has a dark deep-sea backdrop with an ambient radar sweep that operators can toggle on or off, remembered per browser.
- [fleet-console] Fleet Console Operations adds a Map/Helm view toggle to switch between the free-placement terminal canvas (Map) and the classic fixed-sidebar single-terminal layout (Helm), remembered per browser.
- [fleet-console] The Fleet Console Operations Map now floats each panel's in-progress carrier job stream above its terminal, with live stream-line previews that open the full carrier stream when selected.
- [core-unified-agent] Added explicit Claude Opus 4.7 [1M] and Opus 4.8 [1M] models to the Claude provider's selectable model list.
- [fleet-console] Fleet Console now offers a console-wide Operation quick-search via Cmd/Ctrl+K, searching across all Theaters and switching to the selected Operation's Theater and the Operations route, then zooming the Map canvas to that Operation's panel and focusing its terminal for input; the shortcut yields to Codex's own search when on the /codex path.
- [fleet-console] Fleet Console's global navigation bar now has a keyboard-shortcuts button that opens a reference map listing every console, Operations, and Codex shortcut with a short description of what each one does.
- [fleet-console] Fleet Console now syncs an Operation rename to its running Agent CLI by injecting a `/rename <name>` slash command into that session's terminal, reusing the same terminal prompt injection path as carrier completion reminders.
- [fleet-console] Persist Fleet Console theaters and operations across restarts and lazily resume dormant agent CLI sessions on open.

### Changed
- [fleet-admiral] Agent CLI sessions now append the Admiral system prompt to the CLI's native system prompt by default instead of replacing it; fleet-cli's System prompt option can still switch back to replace mode.
- [fleet-console] Fleet Console now isolates its runtime directory under the project's `.fleet/console` when run from source (pnpm/dev), instead of the OS temp directory; an explicit `FLEET_CONSOLE_DIR` still overrides it and published builds are unchanged.

## [1.5.5] - 2026-06-15

### Added
- [fleet-console] Fleet Console's Operations sidebar now lets operators choose which Agent CLI to launch — Claude, Claude Kimi, or Codex — when starting a new terminal session.
- [fleet-console] Fleet Console terminal sessions now deliver carrier job completion reminders to the originating session's Agent CLI, matching the existing fleet-cli behavior.
- [fleet-console] Fleet Console Operations can now expand a terminal to full width, hiding the Operations sidebar, and overlays the session's in-progress carrier jobs as compact one-line rows with live streaming status; each Operation remembers its expanded state across navigation and reloads.

### Changed
- [fleet-console] Fleet Console terminal sessions now launch Agent CLIs through the shared fleet-admiral runtime instead of spawning a fleet-cli wrapper.

### Removed
- [fleet-cli][fleet-console][core-agent] Removed the `fleet --headless` flag and the Fleet Console fleet-cli registration channel; observation is now only through console-owned terminal sessions.
- [core-agent] Removed the shared CLI registration contracts from the public surface.

## [1.5.4] - 2026-06-14

### Fixed
- [fleet-console] Fleet Console's local shell overlay now keeps its running shell, scrollback, and working directory when closed and reopened, instead of starting a brand-new shell each time.

## [1.5.3] - 2026-06-14

### Added
- [fleet-console][core-agent] Fleet Console now shows an "Update available" badge in the global navigation bar when a newer console release has been published to npm.

### Changed
- [fleet-console] Fleet Console's local shell overlay now spans 80% of the console width instead of being capped at a fixed maximum, so it no longer looks narrow on wide displays.

## [1.5.2] - 2026-06-14

### Fixed
- [fleet-console] Fleet Console job overlay no longer clips its content on the right edge; long tool-call labels now truncate with an ellipsis and stay within the card.
- [fleet-console] Fixed Fleet Console terminal sessions failing to start on Windows when launched from an npm-installed stable package.
- [fleet-cli][fleet-console] `fleet update` now stops a running Fleet Console before reinstalling, so the update no longer fails intermittently on Windows when the running console holds locks on files from the previous install.

## [1.5.1] - 2026-06-14

### Removed
- [fleet-admiral] The redline and frontline protocol modes no longer include a working-branch isolation readiness check before their workflow begins.

### Fixed
- [fleet-console] Fleet Console now reports its actual installed package version instead of always showing a placeholder development version.
- [fleet-console] Fleet Console no longer terminates a terminal session when its browser view disconnects; sessions now persist across operation switches and console-web closure, ending only on explicit close, the underlying process exiting, or server shutdown.

## [1.5.0] - 2026-06-14

### Added
- [fleet-console] Fleet Console now organizes Admiral sessions and Codex wiki context by Theater, a project root directory selected from the top bar; Operations lists only Admirals for the active Theater.
- [fleet-console] Fleet Console, a standalone fullstack control surface, ships as its own runtime package with navigable workspace and job rails, smooth incremental streaming of carrier output with reasoning folds and inline tool-call activity, job finalize summaries, and a raw event timeline.
- [fleet-console] Fleet Console now opens on a Theater readiness Bridge — surfacing the active Theater's command brief, operations readiness, and a capability matrix across registered Theaters — with carrier streaming on a dedicated Operations route reachable from top-bar navigation.
- [fleet-console] Fleet Console now shows a Carrier Readiness Matrix sourced from the fleet-carriers read-model.
- [fleet-console] The Fleet Console CLI gains `start`, `stop`, `restart`, and `status` subcommands for managing the local console server, a banner-style help consistent with the other Fleet CLIs, and a `pnpm fleet-console` root script; `fleet console` relays every subcommand to the standalone binary.
- [fleet-console] Fleet Console gains a free local shell terminal, opened as a centered overlay with Cmd/Ctrl+` or a top-bar shell action, that runs the operator's own login shell over the existing console terminal stack.
- [fleet-console] Fleet Console now owns the Codex/Fleet Wiki web surface under the shared Console GNB, with `fleet wiki` and `fleet-wiki` compatibility routed through the console package.
- [fleet-cli] Added `fleet --native` boot option to run the selected Agent CLI in terminal-exclusive mode, passing keyboard, mouse, drag, and scroll events natively to the child CLI, skipping the bottom Fleet PTY, and injecting a mid-session reminder into the child session when carrier work completes.
- [fleet-cli][fleet-console] Added `fleet --headless` flag to opt a session into registration with a running Fleet Console for live observation.
- [fleet-console] Fleet now runs Fleet Console as the local fullstack control surface, removes the global gateway daemon, and returns MCP connectivity to per-CLI in-process servers.
- [core-agent] Added shared CLI registration contracts and generic in-process MCP server primitives for Fleet runtimes.
- [fleet-console] Fleet Console's Operations sidebar now has a close control on each operation card that terminates the underlying session and removes it from the rail.

### Changed
- [core-unified-agent] Claude Code with Moonshot Kimi now runs the Kimi K2.7 coding model as the default, slot-mapped, and subagent model.
- [fleet-console] The Fleet Console server now binds to an OS-assigned random loopback port instead of a fixed one, and `fleet-console start` reopens an already-running healthy daemon in the browser without erroring or spawning a second server.
- [fleet-console] Fleet Console adopts the fleet-wide maritime visual identity — deep-water ink and brass/aurora accents, serif display type, glass surfaces, and codex motion — replacing its previous carbon-and-lime look.
- [fleet-console] Observability events now retain carrier output text in memory with a per-event retention cap instead of redacting it to length metadata, so the console can render live streams; exposure stays loopback-only.
- [fleet-console] Fleet Console registration is now opt-in: only fleet-cli sessions started with `--headless` register with the console; standard and `--native` runs no longer appear as console workspaces.
- [fleet-console] Fleet Console's Admirals sidebar now lists console-owned terminal sessions, each showing its carrier job history in registration order; selecting a job opens a centered streaming overlay over that session's terminal, keeping job management scoped to the active terminal session.
- [fleet-console] Fleet Console now ends a terminal session and removes it from the Admirals rail when its underlying process exits, instead of respawning it on reconnect.
- [fleet-console] Fleet Console's Admirals rail now lists in-progress carrier jobs above finished ones, marks completed jobs with a green status indicator, and labels each job with its carrier name and status instead of an update timestamp.
- [fleet-console] Fleet Console replaces the top-bar connection chip with a brand-mark alert — the console sigil turns red and a bottom-right toast surfaces only when the console link drops, both clearing automatically on reconnect.
- [core-agent] The generic MCP registry, routing, and tool snapshot primitives formerly in `@dotobokuri/core-mcp-server` are now owned by `@dotobokuri/core-agent`.
- [fleet-admiral] Renamed the Admiral protocol-mode skills to `protocol-baseline`, `protocol-midline`, `protocol-redline`, and `protocol-frontline`, and the auxiliary gap-audit skill to `assumption-audit`, dropping the redundant `fleet-` prefix from built-in skill identifiers.
- [fleet-console] Fleet Console's native folder picker now opens the modern Windows Explorer-style folder dialog (address bar, search, path paste) instead of the legacy folder-tree dialog on both native Windows and WSL, and under WSL it starts in the Linux filesystem so WSL folders are reachable from the navigation pane without typing the path.
- [fleet-console] Fleet Console browser payloads no longer expose raw working-directory paths; observer Theater and workspace rows now carry display labels only.
- [fleet-console] Fleet Console's Operations launch (+) control now adopts the Theater selector's glass-well instrument styling with a vector plus mark.

### Removed
- [fleet-console] Removed the standalone `fleet-wiki-ui` runtime package; Fleet Wiki browsing is now served by Fleet Console.
- [fleet-wiki][fleet-console] Removed the Korean/English language toggle from the Codex/Fleet Wiki web surface; the interface is now English-only.
- [fleet-console] Removed the browser token gate from Fleet Console; local loopback access no longer requires handed-off observer or terminal tokens, while CLI ingest authentication and the terminal origin check remain in force.
- [fleet-cli] Removed the raw-CLI Native launch mode; dedicated CLIs now always launch with the Fleet persona injected.
- [fleet-cli] Removed Fleet global shortcuts (Ctrl+C, Ctrl+Q, Ctrl+T) and the MIRROR/DEDICATED input mode toggle from both native and non-native sessions; Fleet exit is now handled through the launcher Exit action or child CLI termination.
- [core-agent] Removed the `@dotobokuri/core-mcp-server` workspace package; consumers should import generic MCP APIs from `@dotobokuri/core-agent` instead.

### Breaking Changes
- [core-agent] The `@dotobokuri/core-mcp-server` package is no longer published or resolvable; migrate imports to `@dotobokuri/core-agent`.

### Fixed
- [fleet-cli] Claude Code on Windows now shows the terminal cursor and accepts Korean/CJK IME input correctly in the default (non-native) mode; previously the cursor was hidden and stray spaces were inserted while composing. Pass `--disable-cursor-sync` or set `FLEET_CURSOR_SYNC=0` to opt out on terminals where cursor projection still misbehaves.
- [fleet-console] Fleet Console now preserves active CLI sessions across local server health refreshes until an explicit restart.
- [fleet-wiki][fleet-console] Fixed Fleet Wiki web opening automatically in the browser when agent CLI sessions start.
- [fleet-console] Fleet Console's native folder picker now works under WSL by opening the Windows folder dialog through interop and translating the chosen Windows or WSL path back to a native Linux path.

## [1.4.0] - 2026-06-10

### Added
- [fleet-admiral] Protocol-mode skills now declare checkpoint boundaries and use a two-report cadence with normalized report tokens.
- [fleet-admiral] A protocol sync check now guards protocol mode drift, duplicated Downward Guard wording, and report-token grammar.
- [fleet-admiral] Admiral result integrity now requires artifact inspection before accepting mutating carrier job results.
- [fleet-carriers] Carrier job results now include best-effort workspace change manifests for inspection.
- [fleet-wiki] Wiki entry writes now automatically strip duplicate leading frontmatter from the body, and `wiki_drydock` detects this condition with an optional `fix` parameter for opt-in auto-cleanup.

### Changed
- [fleet-admiral] Admiral prompt policy now treats live carrier tool descriptions as the authority for carrier request mechanics.
- [fleet-carriers] Carrier rosters now show the optional prior-jobs context hint once instead of repeating it under every carrier.
- [fleet-admiral] Context Confidence planning thresholds now scale by protocol mode, with standard work requiring sufficient confidence.
- [core-agent][core-unified-agent][fleet-infra][fleet-admiral][fleet-carriers][fleet-wiki][fleet-console][fleet-cli] Consolidated duplicated helpers and resolved internal module import cycles across all workspace packages with no behavior change.
- [fleet-cli][fleet-console][fleet-wiki] Realigned the root structure map, developer reference documents, and bilingual READMEs with the current workspace layout and public APIs.
- [core-unified-agent] The package is now marked private to prevent accidental publication to npm.

### Fixed
- [fleet-console] The global `fleet-wiki` command now relaunches the repository-local build when invoked inside a monorepo checkout or git worktree, as originally intended.
- [fleet-console] Web client request-failure messages now follow the selected interface language instead of always appearing in Korean.
- [fleet-console] The wiki daemon health endpoint now reports the real package version instead of a hard-coded placeholder.
- [core-unified-agent] System prompts containing control characters are now fully escaped when serialized into the Codex TOML profile.

### Removed
- [fleet-carriers] Removed dead code and unused public API surfaces across all workspace packages; no CLI, MCP tool, carrier, or stored-configuration contracts changed.

## [1.3.1] - 2026-06-07

### Fixed
- [fleet-cli][fleet-console] Fixed the globally installed `fleet` command failing to launch with a module-not-found error, caused by renamed internal core packages being omitted from the published bundle.

## [1.3.0] - 2026-06-07

### Added
- [fleet-admiral] Fleet sessions now include an auxiliary Context Confidence path for resolving decision-shaped planning gaps before planning proceeds.
- [core-agent] Dedicated Agent CLI sessions now render a project-local Fleet Project plugin from the working directory's `.fleet/` folder, activating its hooks, skills, agents, and MCP servers alongside the built-in Fleet plugin whenever that folder is present.
- [core-agent] Dedicated Agent CLI sessions now render a user-global Fleet Global plugin from the home `~/.fleet/` folder, activating its hooks, skills, agents, and MCP servers across every project whenever that folder holds any of them.
- [core-agent] The project-local and user-global Fleet plugins now expose skills, agents, hooks, and `.mcp.json` as symlinks instead of deep-copying them, so changes in `.fleet/` or `~/.fleet/` are reflected instantly without slowing session launch; broken links are skipped.
- [fleet-admiral] Dedicated Agent CLI sessions now ship built-in protocol-mode skills while the Admiral prompt selects modes through a small protocol gate.
- [fleet-admiral] Each protocol-mode skill now opens with a readiness checklist that confirms the mode's prerequisites before its workflow begins, scaled per mode from a light single-surface check up to multi-carrier ownership and dependency staging.
- [fleet-admiral] Each protocol-mode skill now follows a reporting cadence — plan, readiness checks, briefing, then execution start — so operators can follow how the Admiral runs each mode.

### Changed
- [fleet-cli] Project-local Fleet Project plugins now render flat under `CWD/.fleet/plugin/` instead of a nested `marketplace/` directory, with both project and global plugin assets exposed as symlinks rather than deep copies; the built-in Fleet and user-global Fleet Global plugins remain in the home marketplace.
- [fleet-cli] `fleet update` now prints situation-specific guidance instead of a single generic message: local development builds report that there is nothing to update; up-to-date installs skip reinstall with an already-on-the-latest-version notice; undetectable global installs, non-writable install locations, and unreachable registry checks each receive a distinct message before manual fallback instructions.
- [fleet-cli] Extracted generic agent execution into core-agent and renamed the unified-agent and MCP server workspaces to core packages with enforced core-to-Fleet dependency boundaries.
- [fleet-wiki] Dedicated Agent CLI sessions now use a single Fleet MCP server named fleet while preserving carrier and wiki tool IDs.
- [fleet-wiki] Dedicated Agent CLI launches now activate Fleet through a shared generated marketplace directory with provider-specific marketplace metadata and official Codex CLI plugin registration, while the carrier and wiki MCP servers stay injected directly at session launch instead of through the plugin bundle.
- [fleet-cli] Fleet system prompt injection for dedicated Agent CLI sessions now occurs at CLI launch time through temporary prompt files and a dedicated Codex profile instead of session plugin hooks; session plugins continue to render skills and subagent definitions.
- [fleet-admiral] Claude-family dedicated sessions now inject live native-subagent guidance through a Fleet SessionStart hook while keeping subagent guidance out of the static Admiral system prompt.
- [fleet-carriers] Job Bar carrier names and Task Force backend rows now show the actual model and effort used for each dispatch.
- [fleet-cli] The Fleet Codex plugin is now activated only within Fleet-launched Codex sessions via the per-session Codex profile, and is kept disabled in the global Codex configuration so ordinary Codex sessions are no longer affected; stale Fleet plugin entries from earlier marketplace names are disabled during registration.
- [fleet-cli] The generated per-session Codex profile now stores the Fleet system prompt as a multi-line TOML string with real line breaks instead of a single escaped line, making the profile human-readable.

### Fixed
- [fleet-cli][fleet-console] Fixed Windows `fleet update` only printing manual install instructions instead of running the automatic global npm or pnpm update; package manager shims are now resolved and invoked correctly on Windows, with manual instructions shown only when detection or installation fails.

### Removed
- [fleet-admiral] Admiral system prompts no longer inline per-tool guide blocks; tool-specific guidance remains available through Fleet MCP tool metadata.
- [fleet-cli] Removed Codex role-file generation and direct prompt and inline agent injection from dedicated Agent CLI sessions.
- [fleet-wiki] Removed the fleet-usage skill from the Fleet plugin bundle, which now ships only the wiki-usage skill.

### Fixed
- [fleet-carriers][core-unified-agent] Codex carrier ACP child processes are now reliably terminated when Fleet CLI exits on POSIX—including terminal-close and fatal-error exits—so they no longer linger as orphaned processes.
- [fleet-cli] Claude-family dedicated sessions on Windows no longer fail to launch with a SessionStart hook module-loading error; the Fleet native-subagent hook now runs through a shell-independent invocation.
- [fleet-cli] Codex dedicated sessions on Windows now register and activate the Fleet plugin correctly instead of silently skipping activation.

## [1.2.0] - 2026-06-03

### Added
- [fleet-cli] Job Bar backend rows now display per-backend elapsed execution time inline, using actual backend start and finish timestamps when available.

### Changed
- [fleet-cli] Mission Control now uses a flat LAUNCH/OPTION/SYSTEM root with automatic global option persistence.
- [fleet-cli] Mission Control now ignores legacy `presets.json`; operators may delete stale preset files manually after the global options rollout.
- [fleet-cli] Unified menu and information row alignment across all Mission Control panels using shared block-level layout primitives; key:value rows are now colon-aligned within each group.
- [fleet-cli] Job Bar token estimates now animate with a smooth frame-by-frame count-up instead of jumping to the final value.
- [fleet-carriers] Job Bar carrier strip tiles no longer render a per-backend progress indicator; activity is conveyed by the job-level status icon alone.
- [fleet-cli] The active-job indicator in the Job Bar now blinks the filled `●` on and off instead of alternating between `●` and `○`.

### Breaking Changes
- [fleet-cli] Fleet preset storage and the preset public API were removed in favor of global options.

## [1.1.3] - 2026-06-03

Release v1.1.3

## [1.1.2] - 2026-06-03

### Added
- [core-unified-agent] Cursor Agent provider now supports the Claude Opus 4.8 (thinking) model.
- [fleet-cli] Job Bar job rows now show each job's elapsed execution time to the left of the token estimate, displaying seconds only under one minute and minutes plus seconds beyond.

### Changed
- [fleet-carriers] Native(SubAgent) mode carriers are now eligible for carrier_dispatch in addition to their native CLI path, while remaining mutually exclusive with Task Force.
- [fleet-carriers] Carrier Roster and Job Bar rows for Native(SubAgent) carriers now render in their respective CLI signature color instead of a dedicated SA color, while preserving the [SA] badge.
- [fleet-cli] Job Bar token estimates now account for tool result output size in addition to streamed text and tool labels.

### Removed
- [fleet-carriers] Removed the per-carrier active job and track count badge ([N:M]) from Job Bar carrier strip tiles; live activity is still conveyed by the breathing carrier icon, and the [TF:N] and [SA] badges remain.

### Fixed
- [fleet-carriers] Carrier Roster and other Mission Control panels now keep the focused item visible when the terminal height is reduced; selected rows that would be clipped are scrolled into view automatically.

## [1.1.1] - 2026-06-02

### Changed
- [fleet-cli] Mission Control now uses a launcher-root and action-list navigation model with zero domain hotkeys across root and nested panels.
- [fleet-cli] Fleet gradient banner now animates with a right-to-left shimmer on inactive screens.
- [fleet-cli] Inactive Mission Control UI is vertically centered when content is shorter than allocated rows, while active Agent CLI PTY output remains top-aligned.
- [fleet-cli] Mission Control panels now share a consistent visual treatment with frame utilities, accent markers, and selected-row highlighting.
- [fleet-cli] Conditional actions are omitted from menus when unavailable instead of shown as disabled rows.
- [fleet-infra][fleet-carriers][fleet-cli] Introduced a single durable-I/O primitive (`fs-store`) in `fleet-infra` that unifies atomic writes, advisory directory locks with quarantine-based stale recovery, and secure filesystem guards; preset, auth, and carriers storage now consume this primitive instead of maintaining independent implementations.
- [fleet-cli] Auth storage is now protected with atomic writes, directory lock, and 0600 file permissions, matching the security level of preset storage and resolving the prior sensitivity inversion.
- [fleet-cli] Auth service converted to a pure DI factory (`createAuthService({ authPath })`); module-level mutable singleton and `setAuthPath` removed.
- [fleet-cli] Auth service is now wired through the Composition Root; all auth command paths receive an injected `AuthService` instead of creating one per call.
- [fleet-cli] `fs-store` `sensitivity` field is now required on `CreateDurableJsonStoreDeps` to prevent accidental 0644 creation for sensitive data.
- [fleet-carriers] `carriers.json` write mode explicitly set to 0644 to reflect its non-sensitive status and align with the sensitivity model.

### Fixed
- [fleet-cli] Fixed the host TUI leaving stale characters and rows on screen when the terminal is resized or split.

### Removed
- [fleet-infra] Removed the `@dotobokuri/fleet-infra/log` public subpath, runtime log store, carrier debug-log hooks, executor stderr log attachment, and Mission Control log viewer.

## [1.1.0] - 2026-06-01

### Added
- [fleet-carriers] Job-bar strip now shows an `[SA]` badge for carriers in Native(SubAgent) mode.
- [fleet-cli] Restored the `claude-kimi` dedicated Agent CLI profile for Claude-family native subagent sessions.
- [fleet-carriers] Added per-carrier Native(SubAgent) toggles for Claude-family dedicated CLI sessions.
- [fleet-carriers] Added per-carrier Claude Native(SubAgent) effort defaults to startup agent payloads.
- [fleet-carriers] carrier_dispatch now rejects carriers in native subagent mode, returning an accepted:false response that instructs the host AI to invoke the carrier via its CLI's native subagent path instead.
- [fleet-carriers] Codex dedicated CLI hosts now support Native(SubAgent) mode, running a toggled carrier as a native Codex subagent with its own model and reasoning effort.

### Changed
- [fleet-carriers] TaskForce carrier job-bar labels, strip tiles, and header now render in the signature TaskForce blue while preserving per-backend row colors.
- [fleet-carriers] Enabling Native(SubAgent) mode and committing a TaskForce config are now mutually exclusive, with a warning surfaced when one would overwrite the other.
- [fleet-carriers] Carrier Status is now reached from Mission Control's `C` shortcut as Carrier Roster.
- [fleet-carriers] Moved default carrier persona settings into each persona module while preserving deterministic carrier registration order.
- [fleet-cli] Claude-family Agent CLI native subagents injected via inline startup payloads now default to `background: true` and run as background tasks.

### Fixed
- [fleet-cli] Enabled Agent CLI app-mouse drag forwarding while preserving existing Fleet scroll fallback behavior.

### Removed
- [fleet-carriers] Removed the `Alt+O` host shortcut for opening carrier configuration.
- [fleet-carriers] Removed legacy default persona registry exports and unused carrier config renderer hooks.
- [fleet-cli] Removed the `claude-zai` dedicated Agent CLI profile from the upper-pane selection; the underlying auth and provider backend remain supported.
- [fleet-infra] Removed the unused `@dotobokuri/fleet-infra/settings` package subpath along with dead settings.json persistence and adjacent log-injection code.

## [1.0.2] - 2026-05-26

### Added
- [core-unified-agent] Added Cursor Composer 2.5 and Composer 2.5 Fast models.

### Changed
- [fleet-cli][fleet-console] Consolidated the release pipeline onto the `main` branch: stable releases now run automatic version bumping, CHANGELOG promotion, npm publish, and GitHub Release creation in a single workflow triggered by pushes to `main`.
- [fleet-cli][fleet-console] Mission Control welcome readout now labels published builds uniformly as `stable`; unpublished working copies remain labeled as `local`.
- [fleet-console] Aligned `fleet wiki --help` with the Fleet-branded English help style and primary `fleet wiki` command spelling.

### Removed
- [fleet-cli][fleet-console] Removed the `canary` npm dist-tag and the auto-publish workflow that fired on every push to the `canary` branch. The `canary` branch is retained as the PR integration target but no longer publishes any artifacts.
- [fleet-cli][fleet-console] Removed the manual workflow_dispatch release workflow that targeted the `canary` branch.
- [fleet-cli][fleet-console] Removed the `canary` runtime channel from the Fleet CLI release type, update channel, mission-control welcome label, and prerelease detection logic.

## [1.0.1] - 2026-05-25

### Fixed
- [fleet-cli] Fixed global installation of `@dotobokuri/fleet-cli` failing at startup with `ERR_MODULE_NOT_FOUND: @xterm/headless` by including the package as a runtime dependency in the published metadata.

### Changed
- [fleet-cli] Documented `@dotobokuri/fleet-cli` as a global-only CLI tool in the package README with explicit `npm`, `pnpm`, and `yarn` install commands, and added the `preferGlobal` flag to the published `package.json`.

## [1.0.0] - 2026-05-25

Release v1.0.0

## [0.22.2] - 2026-05-25

### Added
- [core-agent] Added Mission Control for starting or relaunching the upper Agent CLI after exit.
- [core-agent] Added native Mission Control Fleet Menu panels for authentication, wiki server control, diagnostics, and about information.
- [fleet-cli] Added persistent Fleet CLI startup presets with Mission Control option editing and explicit save/reset controls.
- [fleet-cli] Added double-tap Ctrl+C confirmation before exiting the fleet CLI.
- [fleet-cli][fleet-console] Mission Control now checks the npm registry asynchronously for the latest version on the user's channel and surfaces an update-available notice on the welcome screen.
- [fleet-cli][fleet-console] Added `fleet update` subcommand that auto-detects global installation, determines the package manager, and upgrades both `fleet-cli` and `fleet-wiki-ui` together; falls back to printing the install command when the installation scope cannot be confirmed.

### Changed
- [core-agent] Changed Carrier Status to open as a Mission Control panel while preserving active Agent CLI input pass-through.
- [fleet-cli] Mission Control idle screen now renders a Fleet-branded welcome with the gradient banner, amber accent, a carrier/wiki/queue readout, and a version line tagged as `local`, `canary`, or `stable` (unpublished working copies are detected via the package `private` flag; published prereleases by the version suffix) in place of the bare CLI picker.
- [fleet-cli] Renamed the CLI launch/profile terminology to Agent CLI, including the `agent-cli` path and `FLEET_AGENT_CLI` selector.
- [fleet-admiral] HUD label is now a compile-time constant tied to the single immutable Fleet Action Protocol; the protocol switching abstraction and dynamic protocol state have been removed.
- [core-agent] fleet CLI now rejects unknown subcommands and options with an error message on stderr and exits with status 1 instead of silently ignoring them.
- [fleet-admiral] Extracted Admiral prompt and Fleet tool policy into the new `@dotobokuri/fleet-admiral` workspace package; the fleet CLI now consumes it as a typed dependency through the package's root barrel instead of owning the policy modules in-tree.
- [core-agent] Added `createExecutorSessionManager(deps)` factory and `Executor*` session types; the multi-runtime MCP session lifecycle helper formerly named `createDedicatedMcpSession` is now owned by the generic MCP server package.
- [fleet-carriers] Unified `fleet-carriers` internal module topology into `personas/`, `store/`, `dispatch/`, `stream/`, and `jobs/`; removed obsolete `job/` and `events/` directory split.
- [fleet-cli] Unified the Mission Control welcome banner with the `fleet --help` ASCII banner so both surfaces share a single Fleet wordmark.
- [fleet-wiki][fleet-console] Wiki Server panel now reuses an existing healthy background daemon, opens the browser on Enter in any state (start or reopen), exposes daemon stop on the dedicated `S` shortcut, and aligns its default port with the `fleet wiki` CLI.

### Fixed
- [core-agent] Fixed executor pool busy session isolation, stale pooled client lookup, and internal MCP tool signature drift.
- [fleet-wiki][fleet-console] Fixed Wiki Server panel failing silently when a previous daemon held the lock, mis-reporting running daemons as stopped on panel re-entry, and swallowing permission errors during daemon shutdown.

### Removed
- [fleet-carriers] Removed unused carrier runtime, TUI primitive, and agent model helper APIs that were no longer consumed by workspace packages.
- [core-agent] Removed carrier session persistence runtime; session reuse is now driven exclusively by in-memory executor client pool state without JSONL custom entry tracking.
- [fleet-cli] Removed the top-level `-rsp` / `--replace-system-prompt` Fleet CLI flag; the option is now toggled via the Mission Control options drawer, the `FLEET_REPLACE_SYSTEM_PROMPT` env var, or a saved preset.
- [fleet-cli] Removed the top-level `-n` / `--native` and `-em` / `--enable-metaphor` Fleet CLI flags; both options are now toggled via the Mission Control options drawer, the `FLEET_NATIVE` / `FLEET_ENABLE_METAPHOR` env vars, or a saved preset.

### Breaking Changes
- [core-agent] Removed `@dotobokuri/fleet-tui/input` and `@dotobokuri/fleet-tui/pty`; primitive component contracts now use `@dotobokuri/fleet-tui/components`, layout resize contracts use `@dotobokuri/fleet-tui/layout`, and the xterm-backed Agent CLI viewport is owned by fleet CLI controls.
- [core-agent] Removed the in-tree Grand Fleet policy modules (IPC framing, mission reporter, status source, tool specs, ACP prompt builders, runtime access, and text sanitizer) along with their tests; this code was already unreferenced by the fleet CLI runtime.

## [0.22.1] - 2026-05-24

Release v0.22.1

## [0.22.0] - 2026-05-24

Release v0.22.0

## [0.22.1] - 2026-05-24

Release v0.22.1

## [0.22.0] - 2026-05-24

### Added
- [fleet-infra] Added `@dotobokuri/fleet-infra` as the host-agnostic infrastructure package for auth, data-dir, job, log, and settings services.
- [fleet-carriers] Per-carrier builtin external MCP allowlist; Tempest now exposes the grep.app code search MCP.
- [core-agent] Added auth login, list, and logout commands with migrated auth storage and Claude-family alternate backend support.
- [core-agent] Added `--model` option to forward a model name to the selected dedicated CLI, and reorganized `--help` output into Fleet Agent and underlying CLI option categories.
- [fleet-console] Command palette can now be toggled with the Cmd+K (or Ctrl+K) keyboard shortcut.
- [fleet-console] Command palette now locks page scroll while open and restores it on close.
- [fleet-console] Keyboard focus is now trapped within the command palette while it is open, restoring the previous focus on close.
- [fleet-console] Hovering over a search result now synchronizes the active selection.
- [fleet-console] Search matches in result titles are now visually highlighted.
- [fleet-console] Search results now display body match excerpts with markers stripped for readability.
- [fleet-console] Command palette results are now grouped under section headers for recent and matched entries.

### Changed
- [fleet-console] Inline mermaid diagrams now scale to fit the container as a miniature overview instead of rendering at intrinsic size with overflow scroll; the lightbox retains full-size pan/zoom.
- [fleet-console] Removed raw relevance scores from command palette search results.
- [fleet-carriers] Split Fleet internal MCP access into independent `fleet-carriers` and `fleet-wiki` servers with isolated tokens.
- [fleet-carriers] carrier_jobs full responses for auto-promoted Task Force jobs return per-backend results keyed by CLI type instead of a single full_result string.
- [fleet-carriers] Completed migration of carrier runtime, dispatch, jobs, store, and Task Force implementation to `@dotobokuri/fleet-carriers` while removing obsolete compatibility facades.

### Fixed
- [core-agent] Anchored CJK IME preedit to the dedicated CLI input cursor and added `--disable-cursor-sync` for terminals that need to opt out.

### Breaking Changes
- [core-agent][core-unified-agent][fleet-infra][fleet-admiral][fleet-carriers][fleet-wiki][fleet-console][fleet-cli] Removed the standalone Fleet Admiral and Fleet Admiralty workspace packages; Fleet Agent then owned the integrated single-fleet and Grand Fleet policy modules.
- [fleet-infra] Removed obsolete root infrastructure re-exports; consumers must import infrastructure APIs from `@dotobokuri/fleet-infra`.
- [fleet-carriers] Removed the carrier_taskforce tool; carrier_dispatch now auto-promotes carriers with configured Task Force to multi-backend execution.
- [fleet-carriers][core-agent] Removed the sortie toggle feature, eliminating the ability to toggle individual carriers offline, the 'd' keybinding in the carrier status overlay, offline carrier states/persistence, and all associated UI indicators (such as dimmed roster lines, inactive HUD tiles, and footer hints).
- [core-agent] Fleet-world tone overlay is now disabled by default; the previous `--disable-metaphor` flag is removed and replaced by an explicit `--enable-metaphor` opt-in.
- [core-unified-agent] Removed Gemini CLI provider support; users and API consumers must migrate to other supported CLI backends.

## [0.21.0] - 2026-05-20

### Added
- [core-agent] Added `--replace-system-prompt` (`-rsp`) CLI flag that overrides instead of appending the system prompt when launching the Claude dedicated CLI.
- [fleet-cli] Added Fleet Wiki tools to dedicated CLI MCP sessions through fleet-agent boot registration.
- [fleet-admiral][fleet-cli] Added dedicated CLI launch injection for Fleet Admiral prompts, Fleet MCP access, and native permission bypass flags for Claude and Codex.
- [fleet-wiki] Added `wiki_patch_edit` for approval-gated in-place edits to pending wiki patches.
- [fleet-cli] Absorbed Job Bar functionality from former harness into fleet-agent, including a dynamic job status section, active-only frame ticker, and programmatic PTY input bridge.
- [fleet-wiki] Implemented approve-time stale-base guard using content hash and version checks to prevent concurrent modification conflicts.
- [fleet-wiki] Added automatic `rawSourceRefs` accumulation and deduplication to preserve complete provenance history across entry updates.
- [fleet-wiki] Enforced POSIX target validation and `realpath`-based approval locks to prevent path traversal and symlink/case-alias attacks.
- [fleet-wiki] Enhanced `wiki_compile_source` with improved update provenance and related entry tracking for batch operations.
- [fleet-wiki] English localization of all tool prompts, schemas, and guidelines in `prompts.ts`.

### Fixed
- [fleet-carriers] Resolved an issue where concurrent dispatches from the same carrier shared a single PanelRun and collapsed into one line by enforcing unique run identifiers.
- [fleet-wiki] Unified patch hash calculation to cover the entire `patch.md` content, ensuring `summary` frontmatter changes are correctly reflected in `changed_fields`, `patch_hash`, and `base_patch_hash`.
- [fleet-wiki] Introduced per-`patch_id` in-process mutex and snapshot atomicity to prevent race conditions during concurrent `wiki_patch_edit`, `approve`, and `reject` operations.
- [fleet-wiki] Integrated `lastEditHash` as the single source of truth (SSoT) for the actual written patch hash to ensure consistent stale-base detection during interleaved edits.
- [fleet-console] Large Mermaid diagrams are no longer clipped by the document container width.
- [fleet-cli] Prevented persistent JSONL session files from being written when an agent session is opened but never receives a user prompt, eliminating accumulated "(no messages)" entries in the session selector.
- [fleet-cli] Hardened session commit integrity by enforcing cross-session token guards to prevent stale state updates.
- [core-agent] Improved session engine stability by implementing FIFO fatal error handling for ACP tool-call queues.
- [fleet-cli] Grand Fleet now re-registers with Admiralty when the bound ACP session ID changes or the client auto-reconnects after a socket drop, preventing stale registration state on session switches and reconnects.
- [fleet-cli] Fixed type-checking issues in status overlay tests by correcting state property access.
- [core-agent] Fixed resource leaks by adding explicit executor pool disconnection wiring to `runtime.shutdown()`.

### Changed
- [core-agent] Carrier strip stays always visible while the Job Bar detail now auto-shows only when at least one carrier job is active, replacing the prior toggle shortcut and empty-state placeholder.
- [fleet-carriers] Redesigned the Job Bar expanded view into a hierarchical structure featuring a carrier header and independent dispatch sub-lines.
- [fleet-carriers] Enabled parallel execution for `carrier_dispatch` on the same carrier, eliminating the "carrier busy" rejection for concurrent requests.
- [fleet-carriers] Deprecated `squadronEnabled` persistence key in `fleet-store`; the field is now ignored during runtime initialization.
- [fleet-console] Fleet Wiki Web now runs as a single per-user daemon that can open multiple registered workspaces with workspace-scoped URLs.
- [fleet-console] Made the `fleet-wiki` CLI entry point worktree-aware; it now automatically detects and executes the appropriate worktree-local distribution when running within a git worktree.
- [fleet-console] Relocated Table of Contents to a sticky rail card for wider document readability. The card hides when empty and hoists above content on mobile.
- [fleet-console] Added interactive Mermaid diagram lightbox with zoom controls (25–400%), drag-to-pan, mouse-wheel/keyboard shortcuts, auto-fit on open, and navigation-preserving anchor-link guards.
- [fleet-cli] Prompt templates are now invoked with the `/prompt:{name}` prefix, aligning with the `/skill:{name}` convention for consistent slash-command naming and eliminating namespace collision risk with built-in commands.
- [fleet-admiral][core-agent] Extracted Fleet MCP server and tool registry internals into a leaf package (`@dotobokuri/core-mcp-server`) and hardened with 1MiB body caps, 5m timeouts, and snapshot cleanup while preserving fleet-admiral facade compatibility; see `MIGRATION.md` in the package for details.
- [core-agent] Enhanced session and executor engines to capture and validate origin tokens during state transitions and execution to ensure transactional integrity.
- [fleet-cli] Improved Grand Fleet registration stability by utilizing in-flight guards for session identifiers and generations instead of synthetic IDs.
- [fleet-cli] Refined Grand Fleet registration state fields to include explicit status tracking for better observability.

### Removed
- [fleet-cli] Removed unused legacy panel hint constants.
- [fleet-cli] Eliminated obsolete `visibleRunIdByCli` payload from status sources and the `_streams` parameter from status updates.
- [fleet-carriers] Removed squadron-specific UI elements including the `[SQ]` badge, `→SQ` filtering, `S` toggle special handling, and Sortie-Squadron mutual exclusion logic.
- [fleet-cli] Removed Gemini and Cursor Agent from dedicated CLI support.
- [fleet-cli] Removed 'metaphor' domain (worldview, operation naming, directive refinement) and 'request_directive' tool.
- [fleet-console] Removed the Constellation (backlinks) panel and Outgoing references along with the backend backlink indexer and associated API.
- [core-agent] Removed service status UI and refresh logic.

## [0.20.0] - 2026-05-16

### Added
- [fleet-carriers] Added `@dotobokuri/fleet-carriers` as the default carrier persona catalog and self-registration package.
- [fleet-carriers] Added carrier metadata-based executor MCP tool scoping while preserving tool-centric registration.
- [core-unified-agent] Added 1M context models to the Cursor provider catalog with robust effort/reasoning parameter combination via ACP

### Changed
- [fleet-carriers] Enabled parallel execution for `carrier_dispatch` on the same carrier, eliminating the "carrier busy" rejection for concurrent requests.
- [fleet-carriers] Deprecated `squadronEnabled` persistence key in `fleet-store`; the field is now ignored during runtime initialization.
- [fleet-carriers] Carrier prior-job access now requires explicit persona `carrier_jobs` tool and `<prior_jobs?>` request-block declarations instead of inherited defaults; `CarrierMetadata.commonRequestBlocks` removed.
- [fleet-carriers] `PRIOR_JOBS_REQUEST_BLOCK` constant moved from fleet-admiral to fleet-carriers/constants.ts for better domain isolation.
- [fleet-wiki] Five read-only wiki tools (`wiki_briefing`, `wiki_orient`, `wiki_query`, `wiki_read`, `wiki_resolve`) are now registered globally, making the wiki knowledge base available to all carriers by default.
- [fleet-cli] Enforce `canary` as the only allowed PR base; non-canary PRs, including from forks, are auto-closed with guidance.
- [fleet-cli] Auto fast-forward `canary` to match `main` after each push to `main` so release commits propagate automatically.
- [fleet-cli] Removed the `fleet-dev` binary; use `pnpm dev` for CWD-routed development launches instead.
- [fleet-wiki] Wiki tool rendering is now consistent with carrier tools, featuring a transparent background in the TUI for improved visual integration.

### Fixed
- [fleet-wiki] Carrier executor MCP tool whitelist decoupled from wiki module load order; domain packages self-register tools into the executor whitelist so fleet-admiral no longer throws when invoked without fleet-wiki imported
- [fleet-cli] Fixed missing frontmatter on the pr-creates skill that prevented it from loading.

### Removed
- [fleet-carriers] Removed squadron-specific UI elements including the `[SQ]` badge, `→SQ` filtering, `S` toggle special handling, and Sortie-Squadron mutual exclusion logic.
- [fleet-cli] Removed the `/scoped-models` slash command and associated configuration UI, along with related keybindings (`Ctrl+S`, `Ctrl+A`, `Ctrl+X`, `Alt+Up/Down`) for customizing model cycling scope.

## [0.19.0] - 2026-05-13

Release v0.19.0

## [0.18.5] - 2026-05-12

### Fixed
- [fleet-console] Removed unused `canvas` devDependency and dropped its `allowBuilds` entry to prevent `pnpm install` failures on platforms without prebuilt binaries or a C++ toolchain (e.g., Windows arm64 + Node 25)

## [0.18.4] - 2026-05-12

### Fixed
- [core-unified-agent] Codex legacy app-server exits are now classified as graceful, intentional, or abnormal so false turn-completion crashes are suppressed while real child exits include diagnostics.

## [0.18.3] - 2026-05-12

Release v0.18.3

## [0.18.2] - 2026-05-12

### Added
- [core-unified-agent] Added dual-transport support for Codex with a validation toggle (`CODEX_USE_ACP`), enabling both the new npx bridge (`codex-acp`) and legacy app-server connections

### Changed
- [fleet-carriers] Enabled parallel execution for `carrier_dispatch` on the same carrier, eliminating the "carrier busy" rejection for concurrent requests.
- [fleet-carriers] Deprecated `squadronEnabled` persistence key in `fleet-store`; the field is now ignored during runtime initialization.
- [core-unified-agent] Default Codex transport reverted to the legacy app-server path pending a Windows compatibility fix for the ACP npx bridge route
