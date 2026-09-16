# Changelog

All notable changes to this project will be documented in this file.
This format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.96.0] - 2026-09-16

### fleet-console

#### Changed
- The Operation Browser preview is now sharp when the page is still: text and colors are shown losslessly once scrolling or animation stops, and the frame is drawn pixel-for-pixel instead of being stretched to the panel.
- Opening a stowed panel whose session has ended now resumes it right away, instead of leaving you to press Resume again.

#### Fixed
- Clicks, hovers, and annotations in the Operation Browser land on the right spot when the canvas is zoomed in or out, and the preview is captured at the zoomed sharpness.

## [1.95.0] - 2026-09-15

### fleet-console

#### Added
- View the automatically detected browser engine or enter a Chrome or Chromium executable path in Settings > Experimental features > AI extensions.
- Choose Cua Driver or SkyComputerUse in Computer Use settings, with SkyComputerUse remaining the default. Changing backends stops current use and requires enabling the feature again.
- Reduce repeated app observations with Cua Driver by limiting the returned tree, reusing element handles on unchanged screens, and checking specific conditions without a full tree.
- Operation Browser: each agent Operation can open its own browser panel beside the session, and the agent gets Fleet browser tools (navigate, read the page, click, type, screenshots, console and network logs) on the same tabs you see.
- Annotate the page in the browser panel: click an element to leave a numbered comment on it, or draw with the pen, arrow and rectangle, then attach. The marked screenshot goes to the clipboard and is pasted into that Operation's own input - the chat composer or the terminal's CLI - and you press Enter to send.
- While the agent is using the browser, the Operation's browser button and the companion panel show it - the button turns the agent-control color with a spreading ring, the panel gets a moving outline and a tinted caption - from the first browser call until the turn ends.
- Console Use and Computer Use show the same way: while the agent uses them, the Operation's window outline carries a moving light in that channel's color, the caption is tinted, and the caption badge pulses - in every layout including War Room cards. Computer Use lets go of the device when the turn ends.
- The companion caption is the tab strip: favicons, a new-tab button, cookie import from a Google Chrome profile, and a viewport glyph with a tooltip.
- Requires a local Chromium (Google Chrome, Chromium, Microsoft Edge, or a Playwright Chromium). In WSL, Chrome installed on Windows is used when none is installed inside WSL (this needs Node.js on Windows; Fleet Desktop's runtime counts). When no Chrome is found, the browser button is dimmed and its tooltip says what to install.

#### Changed
- The Session Analyst panel now gives its whole height to the conversation and artifacts: the caption strip is gone, and reset, artifacts, back-to-chat, export, and clear live as icons in one row above the message box. Reset and clear ask for a second press before acting, and you can keep asking questions while viewing an artifact.
- Grouped Operations now show their group as a colored chip in the panel caption, so you can tell which group a panel belongs to at a glance; the sidebar group header drops its color dot.
- The Cruise, Tactical, and War Room switch at the top of the Console now uses a glyph for each mode, with search and Zen mode set apart on the right; a mode's own tools appear beneath the active glyph when you hover or press it, and a small dot on the glyph shows when one of those tools is switched away from its default.
- Every Operation now shows its branch in the sidebar and opens a status, location, and start-time card on hover. Show Operation location left Experiments and needs no setting.
- Right sidebar panels and expanded work surfaces no longer show a title bar; each panel's content now fills the surface, and expanded surfaces keep only a floating close button.

## [1.94.1] - 2026-09-15

### fleet-console

#### Changed
- War Room's sidebar rows no longer carry a group badge, because the staged panel's caption already names the group, so long Operation titles get that space back.

## [1.94.0] - 2026-09-14

### fleet-console

#### Changed
- Refine Repository into a continuous review workspace with separate navigation and Git tools, persistent commit context, and next-file selection after staging.
- War Room's sidebar rows no longer carry a Theater badge, because the deck already groups Operations by Theater, so long Operation titles get that space back.

## [1.93.0] - 2026-09-13

### fleet-console

#### Added
- Let agents check whether a Mac app has an open window and explicitly reopen it before continuing Computer Use.

## [1.92.0] - 2026-09-13

### fleet-console

#### Added
- Choose which Operations may use your Mac, and grant or withdraw access without restarting the session.
- Let agents read and control Mac apps with Computer Use, and see which Operations are using the computer or Console.
- Let authorized agents and Quaker Aides start and direct Operations, check results, and automate recurring work with Console Use. Manage agent access from each Operation's menu.
- Keep Quaker Aides on the top bar and open their answers or conversations when needed.
- Allow Console use and Computer Use for each Quaker aide from its own menu, off by default, and see what each aide is allowed to do as access chips.

#### Changed
- Choose the model and effort for Cowork and Session Analyst once in Settings > Experimental features > AI extensions (default Sonnet, medium) instead of in each conversation.
- The chat, Cowork, Session Analyst, and aide message boxes are a single row with the send button inside the box; the chat box shows its model and effort above the box.
- Manage Session watch, Console Use, and Computer Use from each Operation's menu.
- Check Console and Desktop versions in Help, apply Console updates, or open the latest Desktop download.
- With "Show Operation location" enabled, hover over an Operation in the sidebar to see its status, working folder, and start time.
- With "Show Operation location" enabled, see each Operation's branch and working folder in Cmd+K search results.
- Keep aide answers and follow-up conversations in a consistent reading view.
- Read completed aide answers with keyboard focus, then return to your previous input when you close the answer.
- Conversations in Chat view, Session Analyst, Cowork and Quaker aides show the latest exchange first, with earlier exchanges one click or scroll above.
- While an answer is in progress, Session Analyst, Cowork and Quaker aides show a single quiet line of what is happening now instead of a growing list of steps.
- Quaker aide answers read like the rest of Console, with proper tables, quotes and code blocks.

#### Fixed
- Keep Claude Code model selection consistent when switching between Chat and Terminal views.

#### Removed
- Remove the one-time Liquid glass welcome card; the appearance option remains available in Settings.

### fleet-desktop

#### Added
- Follow the agent's work in a live app preview that you can move, resize, or maximize within its Operation.

#### Changed
- See your Desktop version and available updates in the Help menu.

## [1.91.0] - 2026-09-12

### fleet-console

#### Added
- See each Operation's branch and working folder with Show Operation location. Opt in under Settings > Experiments.

## [1.90.0] - 2026-09-12

### fleet-cli

#### Changed
- Get model routing guidance and live model availability from fleet-ai-gateway MCP resources.
- Use Wiki tools as `fleet-codex` and gateway model lookup as `fleet-console-use`, without a running Console.
- OpenCode Go's DeepSeek Flash is now DeepSeek V4.1 Flash, with a 1M-token context window.

#### Removed
- Remove Ox Alpha Free from OpenCode Go model selection.

### fleet-console

#### Added
- Use Theater, Operation, and gateway model tools through `fleet-console-use`; plugin agents can attach this host MCP with their own tools.
- Plugins can offer Admiral MCP tools as `fleet-{pluginId}`. Codex supplies Wiki tools as `fleet-codex`.
- Toggle Global Shell with Ctrl+Backquote and Repository with Cmd/Ctrl+Shift+E from anywhere. Rebind them in Settings.
- Rebind Console keyboard shortcuts in Settings. Help, the command palette, and panel hints follow; swap conflicts or restore defaults.
- Zen mode hides navigation chrome and expands Map while keeping open work. A shortcut and an always-available exit are included.

#### Changed
- Agent sessions get model routing guidance and live model availability from fleet-ai-gateway MCP resources.
- Flatten agent turns in Chat, Analyst, and Codex cowork. The working clock, fold line, and outcome already show that state.
- The Chat thinking tail now animates: dots cycle, and the thinking glyph spins between tool calls.
- With no Theater yet, the sidebar explains what one is, opens the folder picker, and links the setup guide. The guide is also in the command palette.
- OpenCode Go offers DeepSeek V4.1 Flash in place of DeepSeek V4 Flash.
- The Cmd+K palette is labeled Go to, and reaches Operations, files, and Codex documents. Rows in Cmd+K and Cmd+P are tighter.

#### Fixed
- The Repository staged section no longer draws over a long unstaged list.

#### Removed
- Remove Ox Alpha Free from the OpenCode Go model catalog.
- Remove the experimental launch context pack, including its settings and automatic Wiki and commit collection.

## [1.89.0] - 2026-09-11

### fleet-cli

#### Added
- The `fleet` launcher honors the built-in subagent opt-out chosen in Console Settings.

### fleet-console

#### Added
- Settings > Harness > Claude Code lists built-in subagents from the installed Claude Code and lets you turn them off for new sessions.
- The search palette has an Operations / Commands switch. Operation rows open inline actions, and a legend shows the palette keys.
- The Commands empty screen is a grouped home with glyphs, shortcut hints, and a marked destructive close.

#### Changed
- `Cmd/Ctrl+K` closes an open palette or returns Commands to Operations. `Cmd/Ctrl+P` switches an open palette to Commands.
- Commands match in English and Korean. Operation search uses the same fuzzy rule, with the active Theater first and recent Operations on top.

#### Fixed
- The Repository panel no longer flickers on refresh, sync, staging, branch selection, or commit navigation.

## [1.88.0] - 2026-09-09

### fleet-console

#### Changed
- Switching between chat and CLI views interrupts the current response instead of waiting for it to finish.
- Repository refit: the repo/worktree switcher leads the tree, and Fetch/Pull/Push/Stash share one work bar that collapses as the panel narrows.
- The Repository tree lists Worktrees, Branches, Remotes, Tags, and Stashes as sibling sections, with a check on the current branch and ahead/behind counts.
- Repository controls share one glyph set. Results appear as a brief toast instead of an always-on status bar.
- Changed-file lists are single-line rows that keep the file name visible when the path is cut.
- The commit inspector File Tree uses File Explorer grammar and opens a diff, or the file as it was in that commit.

#### Fixed
- Quick Launch `@` and `/` decks and Theater/model popovers blur the screen behind them.
- Repository picker rows keep the intended size for repository names and branch labels.

## [1.87.1] - 2026-09-08

### fleet-cli

#### Fixed
- Claude Code sessions on Codex (GPT) gateway models answer again.

### fleet-console

#### Fixed
- Chat in an Operation on a Codex (GPT) gateway model works again.

## [1.87.0] - 2026-09-08

### fleet-console

#### Changed
- Rebuild the Repository commit dock with snappable collapsed, half, and full heights. Compare stays open: click a row to finish, Esc to cancel.

## [1.86.0] - 2026-09-07

### fleet-cli

#### Added
- Offer Cursor's Fable 5.1 as a gateway model, with Low through Max reasoning and a Max Mode 1M variant billed on the Cursor API pool.

#### Changed
- GPT-6 Astra can overlap read-only tools with other work in streaming Claude Code sessions, still honoring permissions and sequential calls.
- gateway_models omits signed-out providers and providers with no models, and ranks quota spend in numbered order.

### fleet-console

#### Added
- Offer GPT-5.6 Luna (Codex) in the Cowork model menu when it is enabled in Settings > AI Gateway.
- Offer Cursor's Fable 5.1 as a gateway model, with Low through Max reasoning and a Max Mode 1M variant billed on the Cursor API pool.
- Quaker aides share a model and effort picker, a first-duty intro bubble, and Ctrl/Cmd+Shift+Q to reopen the last aide you spoke with.
- Aide chat keeps the whole conversation, with a multi-line composer, Stop, Copy, Send to Quick Launch, source chips, and a cost line.
- Aides announce Operations waiting for your input with a bubble that opens that Operation.
- Move a focused aide with the arrow keys and moor it with Space. Chirps are announced to assistive technology.

#### Changed
- Group the AI Gateway model roster by provider, with spend rank on the heading and a resizable Add model palette.
- GPT-6 Astra can overlap read-only tools with other work in streaming Claude Code sessions, still honoring permissions and sequential calls.
- The Operation menu shows the nine accent tones as one row of swatches, with the aimed tone's name beside the label.
- A panel's accent now colors the caption title. The accent bar before the title is gone.
- The caption more button matches the window-control hover and stays lit while its menu is open.
- The Codex Cowork dock is a revision thread: each instruction is a turn with a live step ledger, a review dock, and notices for failures, timeouts, and disabled models.
- The Cowork composer and model menu use the Console composer grammar, with an effort track beside the model chip.
- The Codex composer floats over both reading surfaces. Inline suggestions collapse while you type and return when the input is cleared.
- Drydock proposers show as readable provenance marks instead of raw tool identifiers.
- Quick Launch prompt refinement supports Operation mentions. Follow-up edits keep the conversation, destination, and attachments until you apply the draft.
- Aides fly out from under Settings, Quick Launch, and dialogs instead of covering their controls.
- After Console quietly ends an aide session, the next question starts a new one with a short notice instead of failing.
- The plugin is named Quaker Aides wherever it appears. Aides answer in the Console language by default.
- The Quick Launch image-attach button sits at the top-right of the prompt, next to refine. Mention and dock toggles sit beside Run.
- Quaker mention answers render as Markdown in the bubble and grow before scrolling. Ask a follow-up and Copy replace Open the full answer.
- Remove the expanded Settings surface. Manage remote access directly in the Settings pane.
- Settings model selectors share one picker with provider bands, context-window info, and an effort segment.
- Settings uses the same rows, switches, and sliders with a visible Default button across plugin and core cards.
- The Quaker aides roster is a segmented control like other Settings pickers. Experimental badges match on every card.
- Settings opens wide enough that titles sit on the left and controls on the right, including the AI Gateway roster.
- Display language is the first Appearance card. The Language chip and the selected theme's brass stripe are gone.
- Sidebar chips show the Operation accent on the title, matching captions. The left accent bar is gone.

#### Fixed
- The caption menu opens inward from the more button and stays in the viewport. Enter moves focus in; Left/Right step the accent swatches.
- The selected Operation menu row no longer takes a green or pink border. The caption more tooltip does not linger behind the open menu.
- Quick Launch keeps Run on the control row. Long model names shorten instead of wrapping Run onto a second line.

## [1.85.0] - 2026-09-06

### fleet-cli

#### Added
- Add current OpenCode Go models including Grok 4.6, GLM 5.3, and DeepSeek V4 Flash Vision Exp with image forwarding.

#### Changed
- Rank models from a CursorBench and LiveBench cohort, and exclude incomplete measurements.

### fleet-console

#### Added
- Settings gains an Experiments category with four opt-in features, all off by default: prompt refinement, launch context pack, session watch, and Console reading for Scuttlebutt aides.
- Expand the OpenCode Go model picker with those current models, keeping existing selections.

#### Changed
- AI Gateway model settings use one roster and one Add model palette, with sign-in and spend rank on each provider. The separate API keys card is gone.
- Repository centers on History and Changes, with one repo/worktree picker, scoped search, and checkout-specific commit drafts.
- A View by status toggle (Alt+S) groups each Theater by awaiting, running, and idle. Narrow to a rail shrinks the sidebar, and is the default in War Room.
- Skills browsing uses quiet rows, one detail and install sheet, explicit scope, keyboard navigation, and distinct load-failure messages.

## [1.84.0] - 2026-09-05

### fleet-cli

#### Added
- Offer GPT-6-Astra in the fleet gateway Codex picker, with 272K, 524K, and 1M variants and a Fast twin for each. GPT-5.6 stays available.

### fleet-console

#### Added
- Offer GPT-6-Astra in the Console Codex loadout, with 272K, 524K, and 1M variants and a Fast twin for each. GPT-5.6 stays available.

## [1.83.0] - 2026-09-03

### fleet-cli

#### Changed
- OpenCode Go offers Muse-Spark-1.3-Contributor instead of Muse-Spark-1.2-Contributor, keeping its 1M context and effort rungs.

### fleet-console

#### Added
- Press Space on a Files tree file to peek without opening it. Enter opens, Escape or Space closes, and arrow keys move the peek.
- Open ancestor folders stay pinned at the top of the Files tree while you scroll. Click a pinned folder to jump back.
- Hover a Files tree row for peek, copy relative path, and reveal in the file manager.
- Path segments in the document header open that folder. The copy button copies the relative path, or the absolute path with Alt+click.
- Set the left sidebar's opacity and glass blur in Settings, next to the right sidebar opacity control.

#### Changed
- Zooming the Cruise canvas out now stops at the fleet map, instead of dimming the sea with no further change.
- The Files tree header is one filter line. Sort, hidden files, and refresh share one menu.
- Files tree git status tints the name and one dot per row, instead of M/U/D letters.
- Open documents are underline tabs. The close button appears on hover; a disk-changed file shows a dot and reloads on click; middle-click closes; overflow opens a list.
- The Files tree shows loading placeholders, empty-folder help, a retry card on failure, and fades at scrollable edges.
- Console OpenCode Go offers Muse-Spark-1.3-Contributor instead of Muse-Spark-1.2-Contributor, keeping its 1M context and effort rungs.

## [1.82.0] - 2026-09-02

### fleet-cli

#### Added
- Add Antigravity Gemini 3.8 Flash with low, medium, and high reasoning effort.

#### Fixed
- Accept tuple-shaped tool schemas when using Antigravity Gemini models.

### fleet-console

#### Added
- Add Antigravity Gemini 3.8 Flash to the AI Gateway model picker.
- Zooming Cruise past readability shows a fleet map: Theater zones, clickable Operation dots, and nameplates that bring a Theater up.

#### Changed
- Chat shows one live line per turn. Thinking dots cycle in the tally tail, and streaming answers carry a caret.
- Replace the chat ledger's text glyphs with a uniform monoline icon set.
- Background work in chat sits on a ledge above the composer and opens a sheet over the conversation. Escape or a click on the conversation hides it.
- War Room deck density stays between 1.0x and 2.0x. The 0.4x map density is retired in favor of the Cruise fleet map.
- Align the Chat work shelf with the composer. Short prompts get a more compact writing area.

#### Fixed
- Session Analyst artifacts render Hangul with the bundled Console fonts.
- Monospace UI Hangul uses the bundled coding font instead of the OS fallback.
- Fast Shell activity stays one continuous running-to-complete row in Chat Mode.
- Running and failed step borders in the Whites theme show the status color instead of a greenish edge.

## [1.81.0] - 2026-09-01

### fleet-console

#### Added
- A collapsed panel leaves a slim filament on the screen edge. Hover peeks it; click docks it back open.

#### Changed
- Session Analyst artifacts use the Console design language across all four themes.
- Session Analyst chat uses the chat ledger: one tool row while streaming, folded finished turns, and the answer under its own seam.
- The analyst composer matches chat: input above a coordinates rail, settling to the bottom when streaming starts.
- The Cruise / Tactical / War Room switch sits at the true center of the command band, and moves left only when the window is too narrow.
- Session search sits at the command band center, right of the mode switch, on every view.
- Collapse the sidebar and Activity Rail from inside each panel. Cmd+B and Cmd+Alt+B still toggle the same states.
- Repository controls keep a visible fill and border at rest, instead of bare text until hover.
- Repository panel bands share one surface. File status letters become tinted chips.
- Setting descriptions sit behind a ? beside the title. Hover previews, click pins, Esc closes. Warnings stay inline.

#### Fixed
- The effort track no longer leaves a brass sliver behind the knob at the lowest rung.
- Long analyses no longer die at two minutes. They keep running as long as they keep reporting.
- Analyst evidence citations render as chips instead of raw cite markup.

#### Removed
- The Theater and Operation breadcrumb switcher left the command band. Switch and rename them in the sidebar.
- The two panel collapse buttons left the command band. The band keeps identity, canvas mode, search, and system controls.
- The sidebar card header and inline operation filter are gone. New Theater stays at the bottom of the list and on the command band.

## [1.80.0] - 2026-08-31

### fleet-console

#### Added
- Chat view sessions can publish Artifacts. The composer deck lists the artifact skills.
- Right-click can launch a Claude Operation straight into chat. The menu remembers that surface and does not follow Quick Launch.

#### Changed
- Session Analyst artifacts render on the Console theme, so headings, tables, code, and citations look like the product.
- The chat message box matches the reading width you chose. A composer control widens it to the whole panel.
- Activity Rail remembers panel width per tool, so widening one no longer widens the others.
- Settings opens wide enough for its theme grid to stand in two columns by default.

#### Fixed
- Downloading an artifact saves a standalone document that keeps its theme. Copy still yields the original source.
- Slow Windows starts reach readiness and clean up failed startup without leaving a background Console.
- Double-click the rail resize handle to reset only the active panel's width.
- The active Theater in the sidebar gets a brass spine, a filled badge, and a brighter name.

## [1.79.0] - 2026-08-30

### fleet-cli

#### Added
- Codex gateway models in Claude Code use OpenAI native compaction, including automatic and manual compact, durable resume, and a plaintext fallback.

#### Changed
- `fleet` launches Claude Code in auto mode with the permission gate up. Turn on Skip permission prompts in Settings > Harness for the previous behavior.

### fleet-console

#### Added
- Codex gateway Operations in Claude Code use OpenAI native compaction, including automatic and manual compact, durable resume, and a plaintext fallback.
- The sidebar gets a card header with a Theater count, a new-Theater action, and an inline title filter.
- A Harness section in Settings gathers how agents launch: Claude Code permissions and prompt, shared session settings, and the agent CLI list.
- Skip permission prompts is off by default. Auto mode keeps the permission gate in the terminal and `fleet`; Chat always runs without that screen.

#### Changed
- The operations chart fills the viewport in Cruise, Tactical, and War Room. The sidebar and Activity Rail float over it as glass cards.
- The command band is one continuous plate. The Cruise, Tactical, and War Room switch joins the left cluster.
- The Activity Rail hosts one panel at a time. Opening another replaces it and no longer pushes the chart.
- New Claude Code sessions open in auto mode instead of skipping the permission gate. Turn the Harness opt-in on for the previous behavior.
- Terminal settings keep font, chat reading width, and rendering. The Claude Code prompt and agent CLI list moved to Harness.
- The File Explorer viewer is its own rail column, with a caption that names the document and carries history, reload, wrap, and expand.
- Rail columns share one divider. Drag or arrow-key the split; each surface remembers where you left it.
- The Codex document is its own rail column, with history and expand on its caption.
- The Repository rail icon opens the workbench on the canvas like Shell. Press it again to put it away.
- Settings moved behind the Activity Rail gear. Search still covers every setting and reaches the command palette; the console stays visible beside appearance controls.
- The rail gear menu is gone. Float and opacity live in Appearance; double-click the panel divider to reset a remembered width.
- Rail panel opacity moved to the Theme card as Right sidebar opacity. The dedicated Rail panels card is retired.

#### Fixed
- With liquid glass on, the left sidebar no longer shows a faint mosaic of false gridlines.

#### Removed
- The dedicated desktop Settings page and command band Settings button are retired. Old /settings links land on the new pane; phone settings stay.

## [1.78.0] - 2026-08-30

### fleet-console

#### Changed
- Activity Rail settings live behind a gear at the top of the icon column, with float over Map, opacity, reset width, and close panel.
- Full-screen terminal apps own scrolling on the alternate screen and restore normal history when they exit.
- Agent Operations and the global Shell use the full terminal body without an inset gutter.
- Shell and Agent terminals advertise 24-bit color. Dark Liquid Glass terminal panels reveal the canvas through a smoked surface.

#### Fixed
- The Session Analyst panel stays at full strength while its session holds focus.
- The What's New language picker no longer overrides the Console display language.
- The global Shell session and terminal contents survive closing and reopening its sidebar surface.

#### Removed
- The rail panel no longer summons a header that covers the first-row controls.

## [1.77.1] - 2026-08-29

### fleet-console

#### Fixed
- Codex loads again in installed builds.
- Installed builds hide the terminal's provider title from browser payloads.

## [1.77.0] - 2026-08-29

### fleet-console

#### Added
- The Chat composer opens a capability deck: `/` for commands and skills, `@` for subagents. Choosing a row completes input instead of sending.
- The deck offers `/clear`, `/compact`, `/context`, and `/reload-skills`, the commands this surface can finish.
- A command runs as its own transcript line instead of a conversation turn. `/compact` shows a gauge of context actually reclaimed.
- `/clear` asks once, then empties the chat view and the agent's memory.
- `/context` opens the context meter instead of asking the agent to print the numbers.
- Terminal settings add a CJK fallback font for Korean, Japanese, and Chinese when the terminal face has no glyph.
- Set each Quaker aide's size in Settings, with a live preview and one-click return to the standard size.
- Open documents and terminals side by side on an expanded canvas work surface, and drag the dividers to size each slot.
- Plugins can contribute their own expanded work surfaces, not only a rail panel.

#### Changed
- Typing a full command name puts that command first in the deck.
- Chat view uses Terminal Font except for markdown answers, so CLI and chat share one typeface.
- Keep multi-panel terminal input responsive at high panel density across Cruise, Tactical, and War Room.
- The light theme no longer uses liquid glass. The switch stays off and locked until you return to a dark theme, which still remembers your choice.
- Aides roam by their own size for screen edges, spacing, and reduced-motion parking.
- Selected controls across themes use a quiet wash and a small brass mark instead of a loud outline pill.
- Shell is one console-wide terminal on the expanded surface, not a per-Theater Operation. It starts in the Theater that was active when you opened it.
- Press the rail Shell icon again to put Shell away without ending it. The session and working directory wait where you left them.
- Codex is a plugin of its own, installed and updated like other panels.
- The War Room Map stays still after its entry sequence instead of repeating a scan line.

#### Fixed
- Restore the streaming wave on chat and analyst live lines in the light theme.
- Restore the streaming wave on the chat Thinking line.
- Bundled skills such as `/doctor` and `/batch` appear under Skills from the first `/`.
- Reloading skills mid-session updates the deck immediately.
- Korean in chat and terminals uses a bundled monospace face so Hangul matches the Latin beside it.
- The Console keeps answering requests while a chat view starts.
- The Codex outline follows the section you are reading, including the last one at the end of the document.
- Long File Explorer lists stay filled while scrolling in tall panels.
- War Room no longer casts a dark vignette over the staged panel.

#### Removed
- Saved Shell panels no longer reopen after a restart. A Shell lives only as long as its console.

## [1.76.1] - 2026-08-28

### fleet-console

#### Fixed
- Alt+Arrow panel shortcuts work while a chat composer holds focus.
- Chat background job titles no longer garble non-ASCII on Windows.
- Codex expanded reading keeps the title and body on one center axis, at every reading width.

## [1.76.0] - 2026-08-26

### fleet-console

#### Added
- Full-size Codex reading has a head bar with find, copy link, source, and reading width. Cmd+K switches entries without leaving full size.
- The document you are reading lives in the address bar, so reload, back, forward, and Copy link keep the same place.
- Full-size reading takes keyboard focus. Space and PageDown move the body, J/K jump sections, Cmd+[ and Cmd+] walk history, and Cmd+F finds in the document.
- Choose reading width as narrow, wide, or large. Read and copy the markdown source; on a wide screen, related entries sit beside the text.
- Search File Explorer by ranked file names or file contents, with highlighted matches you can open directly.
- Usage limits cards collapse one at a time and still show percent, severity, and the countdown to reset.

#### Changed
- Codex follows wiki changes on its own. A document you are reading is never swapped out from under you.
- Map shows keyboard focus: other panels fade, the focused panel lifts, and a brass ring runs once. Set the fade under Settings -> Appearance.

#### Fixed
- The table of contents no longer freezes on the first section when you open a document at full size.
- Reader history keeps your place after following a link or reloading.
- The Settings -> Appearance console preview matches the height of the theme controls beside it.

## [1.75.0] - 2026-08-26

### fleet-console

#### Changed
- Liquid Glass is legible on the light theme, so turning it on and off is a visible change.
- The settings page scrolls behind the command band so the glass has something to refract.
- Maritime and Carbon dark themes get their own Map ground across Cruise, Tactical, and War Room. Instrument stays as it was.
- Settings groups by what each section does, with search by name or a related word.
- All four themes show as cards at once, with a console preview beside them.
- Settings uses one switch for on/off and one segmented control for either/or. A chip on each row says when the setting takes effect.
- Expand or collapse any Theater sidebar section without first switching the active Theater.

#### Fixed
- The command band environment popover uses the same glass as the menu beside it.
- Remote control stays disconnected after the host takes it back or another device connects, until you reconnect.
- Display language applies at once; the Console port waits for a restart. They no longer share one note.
- The Settings section list stays readable on narrower windows.
- Dimmed terminal output on dark glass no longer prints as solid black blocks.

## [1.74.0] - 2026-08-24

### fleet-console

#### Changed
- Completed Chat turns join the work summary to the final answer. The process stays expandable in place.
- Codex reading scales type to the pane, starts with a one-line outline, and shows the body first in the split pane.
- The Codex AI composer sits at the reading frame boundary instead of covering the paragraph you are reading.
- Codex catalog rows are denser. Exceptional states show as badges, and tags stay on one line.
- Codex header tag chips filter the catalog. Timestamps use the same relative time as the catalog.
- Unify hover, focus, selection, and form feedback across Console chrome, settings, and built-in file and repository tools.
- Glass captions are more legible. The Command Band stays one surface when routes or the sidebar change.
- Cmd+K Operation rows show the same activity mark as the sidebar, including the unseen-completion signal.

#### Fixed
- Liquid glass no longer sinks the dark-theme terminal into the canvas.

## [1.73.1] - 2026-08-24

### fleet-console

#### Fixed
- Terminal and agent panel text reads crisply again in the light theme.

## [1.73.0] - 2026-08-23

### fleet-cli

#### Changed
- Claude Code passthrough sessions share one Fleet plugin tree and Harness version.
- Fleet no longer writes the old shared `marketplace/` plugin tree, and reclaims it after a week unused.

### fleet-console

#### Added
- The Chat composer arms on a recognized `ultracode` word the same way Quick Launch does.
- Expanding a wiki document anchors a Codex reading deck over the canvas, with an outline, a reading column, and the catalog still in the rail.
- Codex drydock review shows a rendered diff with a changes-only toggle. Queue rows show the proposer and a line diffstat.
- The Codex drydock queue keeps approved and rejected patches in a decided-history segment.
- Codex wiki links open a hover preview. Each document lists the entries that reference it.
- Floating menus, popups, and console chrome get a liquid glass material on every theme.
- Settings - Theme adds a Liquid glass checkbox, on by default. Unchecking restores the solid look everywhere.
- A one-time welcome card introduces liquid glass after release notes close, including how to turn it off.

#### Changed
- Session Analyst uses the Chat ledger streaming grammar. Finished turns fold into one outcome sentence.
- Chat Mode is easier to start and follow, with a first-turn composer, Esc to stop, cancelable queued instructions, and a new-turn count while you read.
- While a Chat Mode turn runs, tool calls fold into a progress line and background jobs stay as an anchor. A composer glyph opens the work pane.
- Streaming Chat ledger sentences stay at full reading brightness, and tally clauses lead with their tool-family mark.
- Codex patch approval sits in a sticky decision dock at the top of the review.
- The Codex navigator status is an always-visible chip with a conflict count. Entries group by freshness.
- Codex conflict detail compares current and proposed blocks instead of two full copies.
- File explorer folders show a rotating expand chevron and indent guides. The selected row has a brass spine.
- The file tree sort control lists all orders in a menu. Header targets are larger, and / focuses the filter.
- The file viewer header is a breadcrumb. Click a segment to copy that path; double-click a folder to reveal it in the tree.
- The image viewer has a Fit/100% zoom toggle and a meta bar for dimensions, file size, and display scale.
- A new Operation opens its Claude session under its own id, so resume is known at creation.
- A Chat session that cannot load its Fleet plugin refuses the turn instead of running without skills.
- Claude sessions share one Fleet plugin tree and Harness version.
- Claude Code launch and resume share one durable session identity, with automatic migration.
- Switching Repository to Changes folds the commit inspector into a one-line peek. One click returns you to that commit.
- Opening a stash shows its files, including untracked, with Apply, Apply-and-remove, and Delete. Stash asks for an optional message first.
- The staging list has a list/tree toggle. Row actions spell Stage, Unstage, Discard, or Delete on hover.

#### Fixed
- Provider marks keep their supplier colors, including xAI, OpenCode, and Kimi.
- Chat Mode shows a turn as working when you attach mid-stream, instead of looking finished while the answer still arrives.
- Codex search excerpts no longer start mid-word or collapse line breaks into single spaces.
- Light-theme usage meters order by severity, so a spent bar no longer reads lighter than a routine one.
- The light-theme effort handle and filled track no longer outweigh the rest of the page.
- Restore the ring around the effort handle at ULTRACODE and MAX in the light theme.
- Calm the gated ULTRACODE and MAX track in the light theme.
- Chat Mode and the terminal receive the same session definition, so skills and settings match whichever surface opened the Operation.
- Stashing or pulling from the toolbar refreshes the staging list immediately.

#### Removed
- Drop the earlier turns replayed notice from Chat Mode. The restored conversation still appears.

## [1.72.0] - 2026-08-22

### fleet-cli

#### Added
- Route Claude Code turns through an Antigravity subscription using the `agy` CLI sign-in. Gemini 3.7 Flash and Gemini 3.1 Pro are selectable once enabled in AI Gateway settings.
- Configure AI Gateway from the terminal with `fleet gateway`, plus `fleet gateway status`, `models`, and `set`.
- `fleet gateway serve` lets an Anthropic API client use your subscriptions through `ANTHROPIC_BASE_URL`. It binds to loopback only and has no authentication.

#### Changed
- `fleet --help` groups runtimes, their commands, settings, and maintenance. Detail lives under `fleet <runtime> --help`.
- Provider authentication moves to `fleet gateway auth`. The old `fleet auth` spelling still works and says where it went.
- Non-Anthropic AI Gateway providers no longer receive Claude Code's identity line or Anthropic billing headers. Anthropic-served turns are unchanged.

### fleet-console

#### Added
- Route Claude Code turns through an Antigravity subscription using the `agy` CLI sign-in. Gemini 3.7 Flash and Gemini 3.1 Pro are selectable once enabled in AI Gateway settings.
- Show Antigravity usage in the Quota panel, with the 5-hour and weekly Gemini limits.

#### Changed
- Non-Anthropic AI Gateway providers no longer receive Claude Code's identity line or Anthropic billing headers. Anthropic-served turns are unchanged.

## [1.71.1] - 2026-08-22

### fleet-cli

#### Fixed
- Cursor Fast variants use their base model's grade when picking delegation candidates, so a flagship priority tier is not treated as a light model.

### fleet-console

#### Added
- The source tree has a reload control that re-reads local repository state without contacting the remote.
- Cut-off reads say so instead of looking complete.

#### Changed
- The repository remote verb is Fetch. Result copy names the remote it fetched, and tooltips drop raw git flags.
- Destructive verbs name what they destroy. Deleting an untracked file is distinct from discarding tracked changes.

#### Fixed
- Cursor Fast variants show their base model's grade, not LIGHT. Composer 2.5 reads as STANDARD on both Cursor and xAI.
- Failed repository reads show a sentence and a next step instead of a raw error code.
- A repository whose state could not be read no longer looks clean. Write verbs stay locked and say why.
- The changes view stays usable in a narrow rail. The file list and diff stack instead of crushing filenames.
- Added and deleted diff lines keep their signal colors in every theme.

## [1.71.0] - 2026-08-21

### fleet-cli

#### Added
- Add on-demand Professional Pushback and orchestration skills without restoring a Fleet system prompt.
- Offer the OpenCode Go models Ox-Alpha-Free and Muse-Spark-1.2-Contributor, each with the effort rungs its backend accepts.

#### Fixed
- Long-running turns finish instead of cutting off while the model is still working.
- Recover a gateway turn the provider drops or refuses, instead of ending it on the first attempt.
- Cap connections per provider so a wide parallel run queues instead of dropping streams.
- Record failed gateway turns to a durable log.

#### Breaking Changes
- Every `Workflow` stage must name a gateway model again. A stage that pins none is refused before the run; `agentType` is refused in a script. Naming a `fleet:*` identity is enough to dispatch.

### fleet-console

#### Added
- Add on-demand Professional Pushback and orchestration skills to gateway Operations without restoring a Fleet system prompt.
- Offer the OpenCode Go models Ox-Alpha-Free and Muse-Spark-1.2-Contributor, each with the effort rungs its backend accepts.

#### Changed
- Delegation is one level deep. An agent you delegate to cannot spawn agents of its own.
- Files panel search skips dependency and build folders. Path fragments such as `deep/needle` match, and Escape clears the filter instead of closing the document.
- An open document that changed on disk shows a mark and reloads on click.
- Large files show at once by drawing only on-screen lines. Long lines can wrap instead of scrolling sideways.
- Uncommitted changes roll up the folders that contain them, so the working set is visible at the root.
- The panel sizes from the window when a document opens, and the strip marks how many open files it hides.
- The file tree supports type-ahead, PageUp/PageDown, and Shift+F10 or the Context Menu key for the row menu.
- Ledger groups spend by backend, so you can see which provider the money went to before opening a model row.
- A Shell operation uses its own kind glyph instead of a running or awaiting mark.
- Installed skill cards show what the skill does. A project skill that hides a global one of the same name is marked.
- Scope-wide skill update is one action above the list, labeled with how many it will touch. Remove is a word, not a glyph.
- The installed filter matches a skill's description, so a word that appears only there still finds it.

#### Fixed
- Long-running turns finish instead of cutting off while the model is still working.
- Recover a gateway turn the provider drops or refuses, instead of ending it on the first attempt.
- Cap connections per provider so a wide parallel run queues instead of dropping streams.
- Record failed gateway turns to a durable log.
- Folders you left open stay actually open after a reload.
- A long listing cuts at the alphabetical boundary the cap message describes.
- A folder that fails to open stays expanded with the reason and a retry, instead of collapsing silently.
- A running turn's token count shows for gateway models that withhold usage until the turn ends.
- The whole multi-line Quick Launch prompt reaches Windows installs that run the agent CLI through a `.cmd` shim.
- Ledger daily bars open that day's models in every window, not only Today. A day with nothing to show is no longer a dead button.
- Ledger states spend the daily chart cannot place on a day, instead of leaving the total and chart silently disagreeing.
- Installed skills show which registry they came from again.

## [1.70.0] - 2026-08-20

### fleet-cli

#### Added
- Replay Grok's prior reasoning across a tool round-trip, so the model does not re-derive thinking it already did.

#### Changed
- A workflow stage no longer has to name a gateway model. Unnamed stages run on the session model; `agentType` can pin identity again. `Agent` delegation still needs a gateway identity.
- Grok turns go to the endpoint the official Grok CLI uses, the pool an xAI subscription is built around.
- That endpoint hears the Grok CLI version actually installed on this machine.

#### Fixed
- Codex turns reuse the prompt cache instead of paying for the whole conversation again.
- Retry a Grok turn that xAI refused for capacity, and name a second refusal an overload.

### fleet-console

#### Added
- Choose which endpoint Grok turns use in Settings > AI Gateway. Chat Proxy is the default; Direct is xAI's own API. Both use the same subscription.
- Replay Grok's prior reasoning across a tool round-trip, so the model does not re-derive thinking it already did.

#### Changed
- Session Analyst model names in the picker match the canvas context menu type.
- Pull, Push, and Stash report on the button itself instead of a banner that pushed the Repository panel down.
- Create one Shell Operation per Theater from a direct right-rail action. Pressing it again focuses the existing panel.
- Grok turns default to the official Grok CLI endpoint, and report the Grok CLI version installed on this machine.

#### Fixed
- Codex turns reuse the prompt cache instead of paying for the whole conversation again.
- Retry a Grok turn that xAI refused for capacity, and name a second refusal an overload.

#### Removed
- Drop the Alerts panel from the right rail. Operation attention still shows on the left list and the mobile Alerts tab.

## [1.69.0] - 2026-08-20

### fleet-cli

#### Added
- Offer Cursor's GPT-5.6 Sol, Terra, and Luna, Gemini 3.7 Flash, and Kimi K3 as gateway models, each with the reasoning rungs Cursor publishes.

### fleet-console

#### Added
- Offer Cursor's GPT-5.6 Sol, Terra, and Luna, Gemini 3.7 Flash, and Kimi K3 as gateway models, each with the reasoning rungs Cursor publishes.

## [1.68.0] - 2026-08-19

### fleet-cli

#### Changed
- Gateway sessions no longer carry a Fleet system prompt or Fleet skills. A delegation that names no gateway identity is refused with instructions.

### fleet-console

#### Added
- The file explorer viewer keeps open files on a chip strip, with back/forward, Escape to close, markdown Preview/Source, and a size meta bar.
- The file tree gains Name/Modified/Size sort. Files deleted in the working tree appear as struck-through ghost rows.
- Open files and expanded folders are remembered per Theater and restored after a reload.
- The Repository panel works as a Git client: unstaged and staged files, per-file and bulk stage, unstage, two-step discard, and commit with amend.
- Pull, Push, and Stash join Sync on the Repository toolbar, with ahead/behind counts. Pull is fast-forward-only.
- Checkout tabs switch the root checkout and its worktrees. The commit inspector File Tree browses the full tree at that commit.
- Write actions lock while the index is locked or a merge, rebase, or cherry-pick is in progress, and warn when Operations share the checkout.
- Settings has one Claude Code system prompt switch. On keeps Claude Code's prompt; Off replaces it with an empty one. It binds new sessions only.
- Offer xAI Grok Composer 2.5 Fast in the AI Gateway model picker.

#### Changed
- Grok turns go to xAI's Responses endpoint instead of the Grok CLI proxy. An account the direct endpoint refuses falls back to the proxy.
- WORKING > Changes is the staging workbench, with an unstaged/staged split instead of one unified changed-file list.
- The Repository workspace filter walks branches, tags, stashes, and worktrees as well as repositories.
- Stash rows offer apply, pop, and drop from the context menu. Drop uses the two-step arm.
- The sidebar has one Groups | Status switch above the Theater list. Alt+S still flips it, and each session starts on Groups.
- A Theater's awaiting tick sits on that Theater's initials, so it says which Theater is waiting.
- An Agent or Workflow run that pins no gateway identity is refused, with instructions to read gateway_models and pin one.
- An update restores the same address and reconnects the open tab. A second window opens only if the old address could not be reclaimed.
- An in-progress update reads as progress instead of a connection error.
- The update mark moved to the help button. The menu row names the version it would install.
- Updating from a remote session asks for confirmation first. It restarts the console on someone else's machine.

#### Fixed
- A caption button's name tag clears as soon as the pointer leaves. Keyboard focus still shows the name.
- Stay put on Tori, Bori, and Dori survives a Console restart or update.
- Update no longer claims to be done while it is still installing. A failed update says so with its reason.
- A remote screen recovers by itself after the console restarts, instead of retrying an expired session forever.
- A console with remote access turned on now shuts down when asked.
- End a Grok turn whose upstream went quiet mid-stream, instead of waiting forever.

#### Removed
- The Fleet system prompt mode setting is gone. Gateway sessions and Chat Mode no longer receive a Fleet system prompt.
- Stop magnifying a War Room deck card on hover. Click still takes it to the stage; hovering a map marker still raises that panel.

### fleet-desktop

#### Changed
- Update from inside the console now works on Desktop. The shell performs its own restart.

#### Fixed
- A window whose remote session ended is told to open that host again, instead of asking for an access link it does not need.

## [1.67.0] - 2026-08-18

### fleet-cli

#### Changed
- Agents search with the dedicated Grep and Glob tools instead of shell commands alone.

#### Fixed
- Stop a Grok answer from ending in the raw `<|eos|>` marker the model emits as text.

### fleet-console

#### Added
- Chat Mode panels get their own composer at the reading column, with Enter to send, per-panel drafts, image attach, and stop while a turn runs.
- Operation chat has a Chat reading width preference with Reading, Wide, and Full, from the panel caption or Terminal settings.

#### Changed
- A collapsed chat turn summary is the outcome only. Individual failures stay visible when the work is expanded.
- Agents search with the dedicated Grep and Glob tools instead of shell commands alone.
- An Operation panel's controls live in its caption: Session Analyst, chat/terminal, and reading width. The chat log starts at the top of the panel.
- The chat context meter sits in the composer row, one step left of send.
- Caption rail motion differs by state: flow for background work, a pulse while awaiting you, a slow breath for finished unopened panels. Reduced motion keeps a dashed rail.
- A War Room card answers the pointer immediately with a brass hairline and a warmed caption. Keyboard focus shows the same mark.

#### Fixed
- Console view shortcuts such as Alt+F and Alt+T fire while a text field has focus. Alt+Arrow still moves the caret word-wise.
- A chat Operation shows as background while subagents or workflows keep running after its turn ends.
- Background work Fleet does not recognize as agent work no longer counts toward an Operation's background state.
- Agent CLI internal lines no longer replay as messages you sent.
- Cruise Map no longer takes keyboard focus, so Enter in chat does not paint a brass line on the map.
- Claude Code's usage-limit wrap-up is not forwarded on gateway requests, so work on another provider is not told to cut short.
- Stop a Grok answer from ending in the raw `<|eos|>` marker the model emits as text.
- A pressed caption control draws its brass fill on the brass hue in every theme, instead of landing on green or magenta.
- The War Room card state ring encloses the whole card, including the caption.
- A panel that finishes during War Room still promotes onto the stage, even if it was focused before you entered.
- Keep a Grok turn whose tool call arrived complete but whose stream stopped before the closing frame.

#### Removed
- A chat log no longer opens with a line restating its start coordinates. The composer badge already carries that.
- The floating Quick Launch reply bubble is retired, along with the caption coordinate badge and floating stop. The in-panel composer replaces them.
- Remove the CLI/CHAT surface chip from left-sidebar Operation rows.

### fleet-desktop

#### Fixed
- Windows window controls stay sized and aligned with the top band when the window moves between scaled monitors or the zoom changes.

## [1.66.0] - 2026-08-17

### fleet-cli

#### Added
- Restore explicit 524K variants for Codex Sol, Luna, and Terra, including Fast, alongside the existing 272K and 1M models.

### fleet-console

#### Added
- Restore explicit 524K variants for Codex Sol, Luna, and Terra, including Fast, alongside the existing 272K and 1M models.
- Chat panels state the session's model and effort in the chip row and as the log's first line, and mark an ultracode session with the apex tier.

#### Changed
- The Session Analyst model menu groups providers like the canvas launch menu and stays inside the window.
- Session Analyst picks model and effort with the same chip and three-rung track as Quick Launch, limited to low, medium, and high.
- The left sidebar no longer keeps a separate Background group. Leftover work sits in Running, with a row mark that says it is in the background.
- A sidebar row that finished without being opened is told once by its activity mark, not by an extra dot, tint, and header count.
- The activity mark separates an operation waiting for you from one that finished without being opened. Both still gather at the top of the status list.
- Status groups in the sidebar and War Room fold into one shelf caption. Restore verbs stay on Minimized and Ended only.

#### Fixed
- The Chat view states a gateway model's real context window, not the 200k coordinate Claude Code meters it on.
- The Chat context meter moves during a turn, so a file the model just read shows up while it is still working.
- A panel created from a Cruise right-click appears at the click, not the default cascade origin.
- Every sidebar list, including the group axis and the minimized shelf, shows the same activity.

### fleet-mobile

#### Added
- Add the Fleet Console app for iPhone and iPad, with secure pairing to a Console on your network and a TestFlight lane for tester builds.

## [1.65.0] - 2026-08-17

### fleet-cli

#### Changed
- Remove 512K variants from the Codex Sol, Luna, and Terra picker. Keep the existing 272K and explicit 1M variants.

### fleet-console

#### Changed
- Remove 512K variants from the Codex Sol, Luna, and Terra picker. Keep the existing 272K and explicit 1M variants.
- Chat Mode folds failed steps and writes outside the Theater into the same per-sentence tally as ordinary tool calls.

## [1.64.0] - 2026-08-17

### fleet-cli

#### Changed
- Codex Sol, Luna, and Terra keep their 272K models and add explicit 512K and 1M variants, including Fast.

### fleet-console

#### Added
- Stop running background jobs one at a time from the job detail view.
- The empty canvas offers Open all in Tactical, resuming every standing-by operation into the auto-arranged grid. Beyond eight operations the button arms first.

#### Changed
- Codex Sol, Luna, and Terra keep their 272K models and add explicit 512K and 1M variants, including Fast.
- Chat Mode keeps the agent session alive while the Operation is open, so background shells, subagents, and workflows outlive the turn that started them.
- Stopping a chat turn interrupts the agent instead of ending its session, so background work started earlier keeps running.
- The empty canvas standby list shows every standing-by operation with its last-activity time. The Korean copy labels them as kept off.
- Drop the rounded status mark from Sort by status and War Room group headers. Each panel already shows that mark.

#### Fixed
- Keep nested subagent frames off the Chat Mode host transcript so their tools and reports stay on the job surface.
- Starting Chat Mode from Quick Launch with ULTRACODE keeps dynamic-workflow orchestration instead of collapsing that choice to max intensity.

## [1.63.0] - 2026-08-16

### fleet-cli

#### Changed
- `fleet --version`, `-v`, and `version` print the Fleet package version and channel. Claude Code's version is still `fleet cli --version`.
- `fleet auth login` and `logout` reject an unknown provider name instead of opening a picker.
- `fleet doctor` reports install, Claude Code on PATH, gateway auth, and Console health without changing anything. `fleet status` is the same as `fleet console status`.
- `fleet update --check` reports whether a newer package is available without installing or stopping the Console.

### fleet-console

#### Added
- Show how much of the context window a chat session is using. A meter chip opens a breakdown, and each folded turn line carries the tokens that turn added.

#### Changed
- Every AI Gateway model offers ULTRACODE in both launch intensity controls. Models without MAX skip that rung.
- Right Rail panels share one body text size, so switching tools no longer changes the type you are reading.
- Command Band controls sit on one height, so the local chip, breadcrumb, and mode switch share a baseline.
- File preview code highlighting uses its own colors instead of status colors, so a string no longer reads as complete.
- Each usage-limit reset shows a date and hour next to remaining time. Within a day, it shows a 24-hour clock.
- Every Operation uses the same activity mark in the sidebar, War Room, and command band. The per-chip notification count is gone.
- The panel caption is the name and window controls. A More button opens the same Operation menu as right-clicking the sidebar chip.
- Hide stop and reply on a War Room card. They return on the staged panel, where they can be used.

#### Fixed
- Keep Console APIs reachable when several Chat Mode panels are open.
- Render Chat Mode step commentary as markdown instead of forcing the whole sentence into italics.
- The chat workflow stage table keeps one set of columns at any panel width, eliding a value that no longer fits.
- Show a gateway model in the chat workflow stage table by its own name, without a repeated routing alias.
- Long agent turns no longer stretch with blank space from empty ledger segments.
- A folded tool line sits with its own sentence instead of leaving a blank line under it.
- Opening Quick Launch from a chat reply bubble addresses that Operation and drops any leftover unsent draft.
- The apex outline on Quick Launch keeps circling for as long as `ultracode` stays in the prompt.
- `fleet-console --help` shows the installed version and channel instead of always saying `local`.

## [1.62.0] - 2026-08-16

### fleet-cli

#### Fixed
- Retry transient Grok server and socket failures before any caller-visible output.

### fleet-console

#### Added
- Answer the agent inside the chat view. Pick an option or type an answer, and review a submitted plan in the same place.
- A waiting operation shows as awaiting input on the sidebar, War Room, and map. The session waits until you answer or skip, and never times out on its own.
- Chat Mode tracks background work on its own clock. A strip above reply counts what is still running and opens a work surface beside the conversation.
- Chat Mode can stop a turn that is going the wrong way. The closed turn reads as stopped, not failed, and already-started background work keeps running.
- Chat Mode runs under the same Fleet instructions, skills, and gateway tools a terminal Operation gets.
- Keep your place in a streaming chat log, and jump back to the live tail with a Follow chip.
- Usage limits shows OpenCode Go again, reading account-wide session, weekly, and monthly percents.

#### Changed
- The Session Analyst panel has its own caption bar for identity, state, Reset, and the Chat/Artifacts switch, so they no longer cover the first line of the conversation.
- The Session Analyst composer puts model, effort, and slash-command controls inside the prompt box.
- Switching an Operation between the terminal and Chat Mode continues one conversation file, so neither surface overwrites the other.
- Ledger now tracks Claude Code model usage by Anthropic and Gateway providers, with static OpenRouter cost estimates, merged Fast variants, and model detail only in Today.
- Show Codex reset credits as a compact chip, and hide the line when none are held.
- Hide Analyst and Chat chips on War Room cards so chat cards can use that space. The chips return on the staged panel.

#### Fixed
- A gateway model added in Settings appears in the Session Analyst list immediately.
- A turn with work still running no longer shows a check. The fold names remaining jobs, and a cut-short job says so instead of completed.
- A collapsed tool-call row now looks openable before you hover it.
- When background work finishes, the model's next answer opens its own turn instead of replacing the earlier one.
- Chat Mode no longer streams parked, minimized, or hidden panels, so Close and Resume stay responsive. War Room deck tiles keep their live view.
- Aide Bori cheers when a panel finishes, then returns to idle instead of freezing.
- Phone inertial scrolling no longer types mouse coordinates into the terminal prompt.
- Retry brief Grok server and socket failures instead of ending the turn with an incomplete-response API error.
- In War Room, a focused deck panel that starts waiting comes on stage without a pick.
- Clicking empty War Room space unfocuses an off-stage panel, matching an empty Cruise map click.

#### Removed
- Drop the Analyst provider control while only one provider is offered. The model menu already lists every native and gateway model.

## [1.61.0] - 2026-08-16

### fleet-cli

#### Fixed
- A Console server that fails to start names what stopped it. If the browser never opens, you get the address instead of a success report.

### fleet-console

#### Changed
- Chat view shows the agent's work live: each step names a verb, target, and outcome, with changed files above.
- A turn reads as intent then work. Routine steps fold into a tally you can expand. Failed steps and writes outside the Theater stay unfolded.
- A finished turn folds to how long the agent worked. A failed step is named on that line instead of hiding behind a check.
- Writes outside the Theater folder are marked in the ledger.
- A fresh install no longer opens What's New. The next release is the first one it announces.
- After a Console restart, restored sessions share one Ended signal and a start-again path instead of looking idle.
- A rejected rename, accent, group, or reorder rolls back and offers Try again, instead of looking saved.

#### Fixed
- Failures say what happened, why, and what to do, instead of a status code or machine name.
- Saving one setting no longer blocks another. A failed save reverts only its own field.
- Removing a skill, relaunching a dormant Shell, or opening a remote host now reports a refusal instead of looking like nothing happened.
- The terminal panel and Skills list follow the console language. The Skills preview, its tabs, and the Theater row work with a screen reader.
- A plugin that comes up without its panel now says so, instead of leaving an empty rail slot.
- Scrolling a full-screen agent on a phone no longer types `NaN` into the CLI prompt.
- Keep Quaker aide bubbles and the full-answer card opaque in Carbon, Maritime, and Whites.
- Restored Codex and other Agent CLI sessions no longer inherit a Claude mark when the launch record is missing.
- Station Keeping now keeps window captions out of neighboring panels, not just the bodies.
- Station Keeping settles a panel when a drag is interrupted, so captions do not stay overlapped.
- Drop War Room hover zoom as soon as deck density changes.
- Drop War Room hover zoom as soon as the pointer leaves the panel.
- Keep a War Room panel's caption and body inside its tile when density or columns change.
- Open War Room hover zoom only when the pointer moves onto the panel, not when a tile slides under a still cursor.

### fleet-desktop

#### Fixed
- A Desktop startup that cannot proceed explains what stopped it and where the log is, instead of quitting silently.

## [1.60.0] - 2026-08-15

### fleet-cli

#### Added
- The AI Gateway honors Compact timing from Settings: Auto, Early, Late, or Custom 70-99% of each model window.

### fleet-console

#### Added
- Settings > AI Gateway adds Compact timing (Auto / Early / Late / Custom) for gateway auto-compact.
- Clicking Console chrome outside the Map, or empty sea on the Map, clears the active panel.
- Show an Operation's group on the panel caption as a colored dot and name.
- Quick Launch can mention the focused Operation when opened, from an opt-in next to pin.
- Quick Launch `@` lists Quaker aides on duty. They answer in a speech bubble; Open the full answer continues on the chat card.
- Quick Launch `/effort` names gated tiers the chosen model actually offers, and omits that row when there are none.
- Quick Launch can start an Operation in chat view via `/view`. The choice is remembered; switch back with `/view` or Use terminal view.
- War Room cards show the same Operation mark as the sidebar, left of the title.

#### Changed
- Session Analyst now uses chat-view grammar: conversation layout, a foldable work receipt per answer, inline evidence chips, and larger answer text.
- Session Analyst is one panel with a Chat/Artifacts switch. Published briefs open inline, and an Analyst chip sits with the other view chips.
- Clicking a Session Analyst [eN] chip prefills a question asking to show that evidence in context.
- A chat Operation replies from a bubble that opens Quick Launch addressed to that session. The bottom status strip is gone.
- Right-click no longer opens the launcher when no Theater is registered.
- File Explorer now marks listing, filter, palette, and git limits it used to hide, including a 500-entry folder cap.
- .git, .svn, and .hg no longer appear in File Explorer. With hidden files shown, a muted row records what was withheld.
- Ledger names local suppliers and models instead of collapsing spend into CLI client rows.
- Quick Launch no longer puts an ULTRACODE chip in the bar when the prompt contains `ultracode`. The notice above the field stays.
- Quaker mascots are aides, not admirals. Admiral now names only the host agent that plans and delegates.
- Quick Launch `/model` pins each provider band while you scroll and lists models under it once.
- Quick Launch `/effort` uses the same tone ladder as the effort track, including MAX and ULTRACODE.
- The reasoning-effort ladder uses its full range so neighbouring rungs read apart.
- Quota cards now show Claude Max 5x/20x, Codex Pro 5x/20x, and xAI SuperGrok plan names.
- A repository sync that finds nothing new answers on the Sync button instead of a panel-shifting notice.
- War Room deck tiles now hold the real panel, so a shell rewraps to the tile instead of showing a shrunken picture.
- Bori still shows the alert mark, but no longer hops or flaps through a warning.

#### Fixed
- A chat Operation caption now shows whether it is working. A restored Operation reads as dormant there, not idle.
- Focusing a chat no longer retints the whole log. Focus wash stays on the caption only.
- A chat-view Operation no longer reads as dormant. The sidebar matches terminal running/waiting/idle, and chips mark CLI or CHAT.
- When the Console cannot reach an activity signal, it says so in a banner instead of showing every Operation as idle.
- A chat log keeps its place when the panel resizes, including promotion to the War Room stage.
- The docked Quick Launch bar now shows Ctrl+Space next to Mod+J.
- A chat Operation with a missing transcript says so instead of waiting forever. Use the terminal button beside it.
- Tactical Grid empty slots now match the occupied window, including the caption.
- The War Room deck reaches the bottom of the canvas.

#### Removed
- Drop the accent stripe on a panel's left edge. Identity now speaks only through the caption mark.

## [1.59.0] - 2026-08-15

### fleet-cli

#### Added
- Offer Cursor Opus 5 and Fable 5 through the AI Gateway, including Max Mode 1M variants billed to the Cursor API pool.

#### Fixed
- Cursor models page files through the caller Read tool instead of replaying whole files after failed native reads.

### fleet-console

#### Added
- Offer Cursor Opus 5 and Fable 5 in AI Gateway model selection, including Max Mode 1M variants billed to the Cursor API pool.
- Claude Gateway operations can switch to a chat view that continues the same session through the Claude Agent SDK. Replies go through Quick Launch; the terminal reopens with history intact.
- Quick Launch slash commands change Theater, model, reasoning effort, or the bottom dock from the keyboard.
- Toggle Quick Launch with Ctrl+Space on every platform, including macOS. Mod+J remains.
- Attach images in Quick Launch by paste, drop, or the attach button. They ride new launches and `@` mentions; the agent reads them with the message.
- Quick Launch recognizes `ultracode` in a prompt and shows a dashed `ULTRACODE` chip. Hiding the mark still sends the prompt as typed.

#### Changed
- Chat view now shares the terminal panel surface. Return to terminal is a top-right chip, matching the chat switch.
- Reduce repeated command and result payloads when Cursor search runs through caller-approved shell tools. Permission checks stay.
- An Operation panel is now one surface and one color per theme, instead of stacked sheets.
- Operation state now reads on the window caption, including background work. The outline stays a neutral rim.
- Operation panels gain a window caption above the body. Drag from the caption; rename stays on double-click.

#### Fixed
- Cursor models in gateway Operations page files through Read instead of replaying whole files after failed native reads.
- Maximizing a panel in Tactical no longer draws the mode boundary over it.
- The rail Shell panel sits on the same surface as the terminal inside it.
- A staged War Room panel now fills the canvas to the same inset Tactical already uses.
- Stop the terminal from flashing blank when its panel is resized.
- The terminal catches up as soon as the sidebar finishes moving, instead of staying clipped.
- Do not ask the shell to redraw the whole screen when a resize leaves the character grid unchanged.

#### Removed
- Usage limits no longer shows an OpenCode Go card. OpenCode has no supported quota API; OpenCode models remain launchable.

## [1.58.1] - 2026-08-14

### fleet-cli

#### Changed
- Reduce repeated Grok 4.6 tool-schema uploads during tool-search loops. Selected and continuation-referenced tools stay.

### fleet-console

#### Changed
- Reduce repeated Grok 4.6 tool-schema uploads in gateway Operations that use tool search. Selected and continuation-referenced tools stay.

## [1.58.0] - 2026-08-13

### fleet-cli

#### Added
- Add Grok 4.6 through the official Grok CLI subscription, reusing local sign-in without API keys or Fleet-managed OAuth. Incomplete tool calls are rejected before they look like running work.

#### Changed
- Gateway models other than Claude and Kimi no longer receive Claude Code's Web Search tool.

### fleet-console

#### Added
- Add Grok 4.6 gateway routing, weekly subscription quota, and the official Grok mark on launch, settings, and quota surfaces.
- Ledger now splits the window's cost into Console-attributed operations and other local sessions, with the device-wide total in the same block.
- Operations with no matched usage in the window stay visible in Ledger as dimmed rows, with recent-activity / highest-cost sort.
- Ledger's daily trend keeps small days readable with a square-root scale, and marks Console-attributed cost inside each bar.
- Close an Operation from the mobile session title with the same two-tap arm and undo as desktop.
- Pin Quick Launch to the bottom so you can write while work stays visible. It recedes to a draft line when you look away and returns on focus or the shortcut.
- Reorder usage-limit provider cards by dragging, including with the arrow keys. The order persists.

#### Changed
- Move the provider glyph onto the Command Band Operation name and drop the trailing model chip. The running model stays in the switcher list.
- The Codex workspace agent menu opens the effort track to the right of the model rows first.
- Gateway models other than Claude and Kimi no longer receive Claude Code's Web Search tool.
- Quick Launch pickers follow standard menu keys: arrows, Home/End, type-to-jump, Enter to pick, Escape back to the chip.
- Usage limits shows a loading state that says provider usage is being read, instead of a bare ellipsis.
- On Windows, if the prompt has cmd.exe metacharacters (" & < > ( ) @ ^ | %) or would overflow (8,191 / 32,767 characters), Quick Launch writes it to a temp file and tells the session to read that file. Trust folder and update dialogs still complete first; the Operation title still comes from the original prompt.

#### Fixed
- Theater and model chip focus rings draw as a complete ring.
- Closing Quick Launch with Escape keeps the typed draft; reopening restores it.

#### Removed
- Drop the War Room bottom rail. The sidebar already keeps waiting order. Setting aside and pushing back are unchanged.

## [1.57.2] - 2026-08-13

### fleet-cli

#### Added
- Add Cursor Grok 4.6 and Grok 4.6 Fast with Low, Medium, High, and Extra High reasoning, keeping Grok 4.5.

### fleet-console

#### Added
- Offer Cursor Grok 4.6 and Grok 4.6 Fast in AI Gateway model selection, with CursorBench 3.2 quality evidence.

## [1.57.1] - 2026-08-13

### fleet-console

#### Fixed
- Keep Quick Launch on-screen on phones: long Theater names truncate, and Theater, model, and effort wrap onto their own rows.

## [1.57.0] - 2026-08-12

### fleet-console

#### Added
- A touch-screen terminal gets a bar for keys the soft keyboard leaves out: Escape, Tab, arrows, latching Ctrl and Alt, with more keys one tap away.
- Mention a running Operation with @ in Quick Launch to send the prompt to that terminal. A dormant Operation resumes first.

#### Changed
- The command band and Operation menu name the model actually running, such as GPT-5.6-Sol-Fast or Opus.
- Cowork agent settings are a single model menu with an effort handle per row. Cowork offers low/medium/high for document co-editing.
- Cowork models are opus[1m], sonnet, and haiku. Fable is no longer offered for document co-editing. The instruction box no longer triggers browser autofill.
- The right-rail panel header is an overlay on hover or focus, returning its height to content. Escape in the header closes the panel.
- A console keeps one remote connection and gives the seat to the device that joined last. The previous device is told another device connected, keeps its pairing, and can rejoin to take the seat back.

#### Fixed
- An Agent Operation returns to running as soon as you answer in the terminal, instead of staying waiting until the turn ends.
- After a turn ends, leftover subagent and workflow work reads as background, not a running turn.
- Show the terminal at full height on a phone.

## [1.56.0] - 2026-08-12

### fleet-console

#### Added
- Switch Theater on a phone from a Theater tab that lists Operation counts and how many are waiting.
- Show a new access link as a QR code, with remaining time and pairing status in the same window.

#### Changed
- Phone Settings opens as a section list. Tap a row for the full screen; each row shows the current value.
- Phone Settings controls are fingertip-sized, and theme choices stand in one column.
- Name the active Theater above the mobile Operation list.

#### Fixed
- Stack desktop Settings rows on windows narrow enough for the mobile layout.

## [1.55.0] - 2026-08-11

### fleet-console

#### Added
- Open Remote access on the local network by default. A public hostname and NAT route must be enabled and acknowledged explicitly.
- Edit the remote endpoint as a draft. Only Start listening, Save for later, Apply changes, and Stop listening save; choosing an interface no longer touches a running listener.
- Warn before apply: a listener restart keeps paired devices, but changing the trusted address disconnects sessions, revokes unused links, and unpairs every device.
- Show the connection route only when every required value is valid.
- Spell router fields as external port, internal IP address, and internal port, and warn when those ports differ.
- A remote listener without a session answers only pairing, in Fleet Console apps that check the certificate fingerprint. The browser explanation page is gone.
- Pairing on a public endpoint has a failure budget. Rejected attempts show in Settings. A successful pairing clears that source's budget.
- Remote access settings stay on the owner's machine. They do not appear when you are connected from another device. Unreachable public hostnames are refused.

#### Changed
- Show the Claude launch group as Claude instead of Claude built-in.
- MAX and ULTRACODE each have their own motion. Reduced-motion environments stay static.
- The launch menu uses directional edge strips instead of a native scrollbar. Wheel and arrow keys still work; reduced motion gets click-step jumps.

#### Fixed
- Backend API settings group Console Operations and loaded plugin HTTP, SSE, WebSocket, and proxy routes into Core and per-plugin sections.
- Opening the apex effort gate no longer shifts the track's existing stops.
- Dormant Agent panels keep their Claude Code model and effort on resume. Legacy panels without saved settings default to Opus 1M.

## [1.54.1] - 2026-08-11

### fleet-cli

#### Changed
- Show `[1m]` only for gateway models with a real 1M-or-larger window. Mixed-model sessions compact with 16K of each model's real window remaining.

### fleet-console

#### Changed
- Show `[1m]` only for gateway models with a real 1M-or-larger window. Mixed-model sessions compact with 16K of each model's real window remaining.

## [1.54.0] - 2026-08-10

### fleet-cli

#### Removed
- Drop unsupported Cursor AI Gateway models from discovery. Cursor keeps Auto, Composer 2.5, and Grok 4.5 (including fast variants). Claude, GPT, and Kimi no longer appear under Cursor.
- Stop publishing the version-matched `@dotobokuri/fleet-cli` migration bridge on stable Console releases. Install `@dotobokuri/fleet-console` instead.

### fleet-console

#### Added
- The effort track closes at XHIGH. MAX and ULTRACODE sit behind an apex expander only when the model actually offers them.
- ULTRACODE launches with Claude Code `--effort ultracode` (xhigh effort plus standing multi-agent orchestration).
- Offer Cursor Max Mode 1M variants of Opus 5 and Fable 5 beside Kimi K3 1M.

#### Changed
- Streamline the Operation launch menu with compact model rows and a final Etc group for Shell.
- Launch Fable on Claude Code's 1M context coordinate while keeping existing Fable labels.
- Mark each Agent Operation with the provider that launched it, so sidebar, command band, and palette show that glyph instead of one Claude mark.
- Usage meters use the same at-risk verdict as the AI Gateway roster, instead of waiting for the bar to look full. Help explains fill, tick, and hatching.
- Repository graph badges put branches before tags, fold remote tracking into the branch mark, and stay whole as the panel resizes.

#### Removed
- Drop unsupported Cursor AI Gateway models from settings and launch pickers. Cursor keeps Auto, Composer 2.5, and Grok 4.5 (including fast variants).
- Remove the AI Gateway model star that set a session default. New gateway sessions keep Claude Code's own model choice.

## [1.53.0] - 2026-08-09

### fleet-cli

#### Fixed
- Give AI Gateway API key login enough time to validate, so a slow OpenCode Go response no longer times out before the key is stored.

### fleet-console

#### Added
- Picking a canvas launch effort other than AUTO shows a tip to press the knob again. Help > Show the screen guide restores it.
- Settings > Remote access points to the latest Fleet Desktop release, with a GitHub releases link.

#### Changed
- Right-clicking the canvas or an empty sidebar row opens the model list directly. Shell is first; provider bands follow in the same menu.

#### Fixed
- Give AI Gateway API key sign-in enough time to validate, so a slow OpenCode Go response no longer times out before the key is stored.
- Moving to another console on this computer, including WSL, no longer strips the way back. The host box names the console you are on.

### fleet-desktop

#### Fixed
- Access-link copy works in the Windows Desktop app, with clipboard permission limited to the active Console origin.

## [1.52.0] - 2026-08-09

### fleet-cli

#### Added
- Record CursorBench scores in the gateway catalog and `gateway_models` roster. Judgment work ranks by measured scores first.
- Add opt-in `providerPriority`: spend named providers first until real failures are observed.

#### Changed
- Claude Code sessions on Codex and OpenCode Go no longer resend the full tool catalog for the short suggestion after a visible turn. Ordinary tools are unchanged.
- Cursor sessions through the AI Gateway send tool instructions as an always-applied Cursor rule, so they reach the model when it chooses a tool.
- Gateway model identities use the Fleet plugin scope `fleet:<name>`, matching `gateway_models`.
- Ship `fleet` from `@dotobokuri/fleet-console` with `fleet cli`, `fleet console`, and bare Claude Code passthrough.
- Update only `@dotobokuri/fleet-console`, stopping the local Console first when present.
- Publish a version-matched `@dotobokuri/fleet-cli` migration package so existing installs keep matching `@dotobokuri/fleet-console`.

#### Fixed
- Cursor sessions through the AI Gateway no longer hang for three minutes after a tool call or resend the whole conversation on the next turn. Cursor Auto, Composer, and Grok use the same path.
- Cursor sessions through the AI Gateway no longer stall when the model uses Cursor's built-in read, search, or shell. Those calls go to the session's matching tools with permission checks. Unrepresentable built-ins stay refused.
- Report why a Cursor turn failed instead of an empty reply. Sign-in expiry, usage limits, and Cursor's own error message pass through.
- OpenCode Go sessions through the AI Gateway no longer fail when the model invents undeclared tool arguments. Extra keys are dropped; the backend accepts `strict: true` and then ignores it.
- A large enabled model roster no longer breaks launch on Windows. Identity definitions moved off the command line into plugin files.
- Turning a model off in AI Gateway selection now also stops it being served and billed.
- Refuse a Windows launch whose arguments do not fit the Claude Code command line, naming the size and the limit.

#### Removed
- Remove superseded OpenCode Go generations (MiniMax M2.x, Qwen 3.5 to 3.7, GLM 5 and 5.1, Kimi K2.5 to K2.7). Keep each lineup's current generation.

#### Breaking Changes
- Resolve `FLEET_AGENT_CLI=claude` to the gateway launch instead of retired Classic, so old environments keep starting.
- `@dotobokuri/fleet-cli` no longer provides the `fleet` command. Run `fleet update` from an existing install, or install `@dotobokuri/fleet-console`. Direct npm install of that package leaves no `fleet` on PATH.

### fleet-console

#### Added
- Record CursorBench scores in the gateway catalog. Console-launched sessions rank judgment work by measured scores first.
- Set opt-in provider spend order in AI Gateway settings. It affects quota use only, never model quality.
- Repository history shows each commit's author, marks commits with a body, and lets you choose topological or date order. Default is topological.
- Read a roster model's class beside its name in AI Gateway settings: `flagship`, `standard`, or `light`.
- Routing aliases show `unclassed` instead of a blank, because the serving model changes per call.
- Mark an AI Gateway model host-only: it stays in Claude Code `/model` and the launch dropdown, but is left out of `gateway_models` and has no delegation identity.
- Start a Claude (Gateway) Operation on a chosen Claude alias or enabled Gateway model from the canvas menu, with reasoning effort set before launch.
- Reasoning effort is a track, not a list. Missing rungs keep their place. The first stop leaves effort unset so the model's default never looks like the lowest rung.
- In the canvas launch menu the track only sets effort; the model row still launches. The track opens from a handle on the row's right.
- Choosing Opus launches Claude Code `opus[1m]`. The dropdown still shows `Opus`; a leftover `opus` selection is rewritten to `opus[1m]`.
- Terminal settings can append or replace Fleet doctrine for new Claude AI Gateway sessions, or use Claude Code's own prompt while keeping Fleet harness tools.
- Start work from anywhere with Mod+J: type the task, pick Theater and model, press Enter. The shortcut works even while a terminal has focus.
- Choose model and effort inside the Quick Launch composer. A model that lacks the remembered effort clears it. First-time Quick Launch starts on Opus.
- Aim a launch at any Theater, not only the one on screen. Last Theater, model, and effort are reused even after closing without launching.
- On Windows, a prompt that does not fit the agent command line is refused before launch, with how many characters to cut. The composer stays open.
- Remote access serves the console over TLS and hands out `fleet://join?code=...` links. A link encodes address, one-time credential, fingerprint, and name - encoding, not encryption, so treat it as a secret. Full links warn they can run commands; monitoring-only links do not. Turning remote access off closes the listener and ends remote sessions.
- A device that opens this console with an access link stays paired after the link is spent. Disconnect leaves pairing; remove revokes it. A new certificate or about a year away needs a fresh link.
- Settings keeps reachable consoles; the command-band host chip switches among them. Paste an access link to confirm the certificate first. Local consoles, including WSL on Windows, need no link. A remote console never receives your other machines' addresses.
- Only one device drives at a time. When another takes control, a notice names it and offers to take control back. The terminal stays readable. A second full access link is refused while a device is connected, and stays usable later.
- Remote access is marked experimental wherever it is reached, and introduces itself on first use. Link and pairing behavior can still change between releases.
- Cruise adds opt-in Station Keeping: spread overlapping panels, then keep launches, drags, resizes, and restores from overlapping.
- Choose how often unfocused terminal panels redraw under Settings > Terminal > General: Balanced, Instant, or Saving. The selected panel always redraws at full speed.
- War Room Watch Deck cards always show minimize and close. Minimizing takes the Operation off the deck. Close still arms on the first press.
- Minimized Operations get a War Room shelf above Dormant. Alt+S Status views separate minimized from dormant the same way.

#### Changed
- A Claude (Gateway) Operation on Codex or OpenCode Go no longer resends the full tool catalog for the short suggestion after a visible turn.
- A Claude (Gateway) Operation on a Cursor model sends tool instructions as an always-applied Cursor rule.
- Session Analyst runs on the Console AI Gateway, not a detected Claude Code CLI. Default is `Sonnet` at `low` instead of `Opus [1M]` at `xhigh`. It has no file or shell tools.
- Scuttlebutt aides Tori, Bori, and Dori answer over the same AI Gateway, so chatting no longer needs an installed Claude Code CLI.
- Wiki Cowork no longer asks which Agent CLI to use. It runs on the Console AI Gateway; default is `Sonnet` at `low`. A turn that stops unfinished reports an error.
- The canvas context menu is about half as tall. Claude kinds show a short contrast beside the name; the full line opens on hover or focus.
- What's new groups notes by runtime: Fleet CLI, Fleet Console, Fleet Desktop. Releases through v1.51.0 no longer list `fleet-plugin` and `fleet-core` internals.
- Draw the Repository commit graph one row at a time so commit text sits beside the lanes it actually uses. Branch, tag, and remote badges are clearer.
- Keeping the command band visible in fullscreen gives it a place below the top instead of floating over work.
- The fullscreen command band also comes down when the pointer moves upward near the top edge, not only in the topmost pixels.
- Keeping the fullscreen command band visible is remembered. The command palette can toggle it while the band is hidden.
- Gateway model identities use the Fleet plugin scope. An Agent Operation selects one as `fleet:<name>`, matching `gateway_models`.
- Read and edit a model's reasoning levels from its `effort` badge in AI Gateway settings.
- Own both `fleet` and transitional `fleet-console` bins from one package.
- Prefer `fleet console` in help while keeping transitional `fleet-console`.
- Fleet Console restores canvas mode, expanded panels, and related layout when you move between local and remote or reload. A new tab still starts in Cruise.
- Show the screen guide now replays every onboarding guide from the beginning.
- Switching light and dark themes shows one dismissible notice instead of one hint per terminal. It still suggests relaunching CLIs or `/theme`.

#### Fixed
- A Claude (Gateway) Operation on a Cursor model no longer hangs for three minutes after a tool call or resends the whole conversation on the next turn. Cursor Auto, Composer, and Grok join the same path.
- A Claude (Gateway) Cursor Operation no longer stalls when the model uses Cursor's built-in read, search, or shell. Unrepresentable built-ins stay refused.
- Report why a Cursor turn failed instead of an empty reply.
- A Claude (Gateway) OpenCode Go Operation no longer fails when the model invents undeclared tool arguments. Extra keys are dropped; the backend accepts `strict: true` and then ignores it.
- A Claude Operation with a background workflow stays marked background until that workflow actually finishes, then returns to `AWAITING` when nothing is running.
- Arrow keys move through the canvas context menu again. The menu announces itself to screen readers.
- Opening the canvas control menu near the bottom no longer shoves the whole board upward.
- Right-clicking the canvas in Tactical offers every launch kind instead of greying them all out.
- Show release-note entries a repeated section heading used to hide, including v1.3.0 `Fixed` duplicates. Unrecognized headings are kept.
- Load external TypeScript plugins on an installed Console instead of skipping them.
- Reach the rest of Repository history when commit messages are large enough to fill the log buffer.
- Command band toggles now look pressed while they are on.
- A Claude (Gateway) Operation no longer fails to start on Windows when many gateway models are enabled.
- Turning a model off in the AI Gateway roster now also stops it being served and billed.
- Segmented controls in Settings no longer stretch across the whole column.
- Keep the feature-tour card opaque in Carbon, Maritime, and Whites.
- Opening a changed file keeps the Repository file list where it sat. The diff opens to the right of the list.
- Drag-to-copy in a terminal works while a full-screen agent CLI is running. Clipboard writes the program asks for are applied; clipboard reads stay refused.
- Watch Deck previews fill the card and grow with it. Quick-look opens at reading size instead of magnifying a tiny thumbnail.

#### Removed
- Remove superseded OpenCode Go generations from the AI Gateway roster. Keep each lineup's current generation.

#### Breaking Changes
- Retire Claude (Classic) and Claude (Native). New Operations launch as Claude (Gateway); existing Classic or Native Operations migrate on first start. A one-time `state.json.classic-backup` is kept first.
- Remove Carrier surfaces that Classic carried: Carrier Streams, Carrier settings, and the Carrier deep-link. Agent session status, attention, and title behavior are unchanged.
- Remove the Metaphor prompt setting. It only shaped Classic persona and is dropped from stored settings on the next write.

### fleet-desktop

#### Added
- Fleet Desktop opens `fleet://` access links by handing them to the running console. It shows no dialog of its own.
- Choosing a remote console in Fleet Desktop checks the saved fingerprint before connecting. A mismatched certificate does not open. Saved consoles reopen without a fresh link unless the device was removed, the certificate changed, or about a year passed.

#### Removed
- Remove remote runtimes over SSH. Add that console in Settings with its access link instead. Local consoles, including the managed one, are unchanged.
- Remove the Connect to Runtime menu and tray entries. Which console to open is chosen in the console itself.

## [1.51.0] - 2026-08-06

### fleet-cli

#### Added
- [fleet-cli] The thin launcher reads the same AI Gateway selection as Fleet Console (`~/.fleet/ai-gateway.json`) and serves `gateway_models` with live provider allowances.

#### Breaking Changes
- [fleet-cli] `fleet` now launches Claude Code as a native child with AI Gateway injection (`--mcp-config`), replacing the embedded two-pane terminal. The carrier surface and `--disable-cursor-sync` are removed. `fleet auth` and `fleet update` remain; unrecognized arguments pass through to Claude Code.

### fleet-console

#### Added
- [fleet-console] Show a one-time notice that Claude (Classic) is being phased out. Existing Classic Operations keep working; new ones should use AI Gateway.

#### Changed
- [fleet-console] Crop War Room live preview above the agent CLI input chrome so Watch Deck cards show more streaming output.
- [fleet-console] Promote Claude Gateway to official. Menus now label it `Claude (Gateway)` and the tour no longer calls it experimental.

#### Fixed
- [fleet-console] Reuse a plugin's compiled route bundle across Console server restarts in the same process.
- [fleet-console] Restore sidebar resize in War Room. The shared edge handle now works in every mode.
- [fleet-console] Right-click empty War Room space (sidebar, deck, between Theater bands, queue rail) opens the same launch menu the map already offered.
- [fleet-console] Keep sidebar and Activity Rail toggles in the command band outside Operations; pressing one returns to Operations and opens that panel.
- [fleet-console] Sidebar and Activity Rail shortcuts no longer change stored panel state on screens that show neither panel.
- [fleet-console] Launch the Console daemon and update worker with the OS certificate store trusted by default (`NODE_USE_SYSTEM_CA=1`). Opt out with `FLEET_CONSOLE_NO_SYSTEM_CA=1`.
- [fleet-console] The OpenCode Go Usage limits card shows session, weekly, and monthly meters in Fleet Desktop instead of reporting no local log.

#### Removed
- [fleet-console] Remove Reduce panel motion from Settings > General. Panel motion follows the OS Reduce Motion setting only.

### fleet-desktop

#### Fixed
- [fleet-console] Trust the OS certificate store by default in Desktop-managed Node processes so Codex usage and gateway calls work behind TLS-inspecting proxies. Opt out with `FLEET_CONSOLE_NO_SYSTEM_CA=1`.

### fleet-plugin

#### Added
- [fleet-console] Add an off-by-default Wire log toggle in AI Gateway settings. It records the gateway wire under the Console data directory (16 MiB rotation, one backup) and overrides `FLEET_GATEWAY_WIRE_LOG`.
- [fleet-console] Drag the divider between file list and diff in repository commit and compare inspectors. Compare can switch list/tree; a narrow inspector still stacks.

#### Changed
- [fleet-console] Store AI Gateway model selection in one Fleet-wide file at `~/.fleet/ai-gateway.json`. Existing selection is carried over; an explicit data-root override keeps its own.
- [fleet-console] A Claude (Gateway) launch now refuses to start when the model-discovery cache cannot be written, instead of starting with a stale roster.

#### Fixed
- [fleet-console] Hide the tool status line in a carrier activity card when the running tool reports no status, instead of showing `{status}`.
- [fleet-console] Show TLS certificate failures in the quota panel as Certificate verification failed, and include the transport cause in AI gateway 502 messages.
- [fleet-console] Keep a long commit subject on one line in repository history and the inspector header, with the full text as a tooltip.
- [fleet-console] Stop the inspector file list from overflowing onto the diff. Long paths scroll inside the list.

### fleet-core

#### Added
- [core-ai-gateway] Offer Cursor GPT-5.6 Sol through the AI Gateway, billed against the Cursor API pool, with Cursor's low-through-max reasoning ladder.
- [core-ai-gateway] Add an in-process wire-log target that overrides `FLEET_GATEWAY_WIRE_LOG` so a host can turn diagnostic logging on or off without a restart.
- [core-ai-gateway] Record each gateway model's capability class (`flagship`/`standard`/`light`) in the catalog and `gateway_models` roster. Routing aliases stay unclassed.

#### Changed
- [fleet-admiral] Assign gateway workflow stages by judgment vs mechanical roles. Judgment seats keep the highest reachable class; mechanical fans keep allowance distribution.
- [fleet-admiral] Rename gateway stage skills to `workflow-architecting`, `workflow-research`, `workflow-implementing`, and `workflow-review`.
- [fleet-admiral] Trim always-on gateway doctrine that restated the Claude Code harness. Directory doctrine defers to automatic CLAUDE.md surfacing.
- [core-ai-gateway][fleet-admiral] Move the Anthropic-compatible AI Gateway router, quota probes, and launch environment into host-neutral packages shared by Fleet Console and Fleet CLI.

#### Fixed
- [core-ai-gateway] Drop image parts only for OpenCode Go DeepSeek V4 requests to its text-only Chat Completions endpoint, preventing `image_url` schema errors.

#### Removed
- [fleet-admiral] Drop the measured roleFit table from `gateway_models`. Catalog capability class is the roster's quality signal; allowance decides only among class peers.

## [1.50.1] - 2026-08-05

### fleet-core

#### Fixed
- [core-ai-gateway] Codex-backed sessions no longer die with `400 Unknown parameter: 'input[N].reasoning_content'`. Assistant reasoning stays off the Responses request body.

## [1.50.0] - 2026-08-05

### fleet-core

#### Added
- [core-ai-gateway] Show OpenCode Chat Completions and Cursor reasoning as Claude Code thinking. DeepSeek V4 reasoning history is kept across tool turns.

## [1.49.0] - 2026-08-05

### fleet-plugin

#### Fixed
- [fleet-console] Keep AI Gateway response streams active during silent provider reasoning intervals.

### fleet-core

#### Added
- [core-ai-gateway] Stream OpenAI Responses reasoning as Anthropic thinking blocks for Claude Code.

#### Changed
- [fleet-admiral] Gateway sessions no longer load the bundled Claude API reference skill. Ordinary Claude sessions keep it.
- [fleet-admiral] Gateway hosts budget bulk parallel work against provider allowances. A healthy provider is used regardless of raw percentage; an unreadable allowance is left out, not treated as exhausted.

#### Fixed
- [core-ai-gateway] A Cursor conversation no longer keeps running blind after it fills the model window. The gateway refuses the next turn with 413 so Claude Code can compact and continue.
- [core-ai-gateway] Emit Anthropic-compatible SSE keepalive comments on gateway-facing response streams.

## [1.48.0] - 2026-08-05

### fleet-console

#### Added
- [fleet-console] Shelve dormant Operations below the War Room queue. Selecting a shelved Operation resumes it in place without leaving War Room.

#### Changed
- [fleet-console] Right-click works on every War Room surface. Empty space inside a Theater band launches into that Theater; space outside every Theater opens nothing.

#### Fixed
- [fleet-console] One Operation uses one activity color everywhere in War Room. Idle, awaiting, and background no longer disagree across card, map, and sidebar.

### fleet-plugin

#### Added
- [fleet-console] Expand an AI Gateway model in Settings to choose which reasoning levels it is offered at. Each chosen level becomes one delegation identity.
- [fleet-console] Compare two commits inside repository History: pin a base, Shift-click a pair, or use the inspector action.
- [fleet-console] Stash rows now open the stash commit in the inspector.

#### Changed
- [fleet-console] Narrowing a model's reasoning levels changes only delegation identities. The `/model` picker and in-session `/effort` still see the full ladder.
- [fleet-console] Retire the separate Compare view. Branch and tag compare actions land in the in-History result dock.
- [fleet-console] History is the repository's checkout-independent record. Only off-checkout dimming and the uncommitted row follow the active checkout.
- [fleet-console] Manual repository Sync reports success or failure. Automatic sync and throttle skips stay silent.

#### Fixed
- [fleet-console] AI Gateway settings no longer offer reasoning levels the Anthropic wire cannot carry.
- [fleet-console] The commit detail dock stacks vertically instead of collapsing to zero width when the history pane is narrow.

### fleet-core

#### Added
- [core-ai-gateway] Withhold a skill body a gateway model's context window cannot afford, replace it with a size stub, and drop that skill from the listing so the model stops trying to load it. A 1M-or-larger window keeps a payload it can afford.
- [core-ai-gateway] `FLEET_GATEWAY_WIRE_LOG` now records what a Cursor turn actually puts on the wire, including replay size. Cursor re-uploads its whole replay each turn.

#### Changed
- [fleet-admiral] Gateway doctrine pins an explicit model for every run that leaves the host, and spends the session's own allowance last. The `workflow` skill owns surface choice and model assignment.
- [fleet-admiral] Leaving a run unpinned is a recorded decision. Only labelled exceptions `E1`, `E2`, and `E3` may spend the session's own model. An unreadable allowance is not exhaustion.
- [fleet-admiral] `gateway_models` guidance separates lineage (`homolineage`) from whose subscription is billed.
- [fleet-admiral] The gateway_models roster reports the effort levels this session actually registered.

#### Fixed
- [fleet-wiki] Wiki retrieval tokenizes non-Latin topics, so a multi-word Korean query reaches `wiki_briefing`, `wiki_query`, and `wiki_resolve`.
- [core-ai-gateway] A gateway turn over the model's real context window is refused as HTTP 413, the shape Claude Code needs to compact and continue.
- [core-ai-gateway] A Cursor conversation is no longer refused at roughly half its context window. The model's window is the only ceiling, and it answers with 413 so compaction can start.

## [1.47.0] - 2026-08-04

### fleet-console

#### Added
- [fleet-console] Watch Deck cards magnify into a readable quick-look after hover. Keyboard focus opens it immediately; click still stages the Operation.
- [fleet-console] Offer the canvas control menu on right-click in triage, with launch actions disabled.
- [fleet-console] Triage gains a persisted SPOTLIGHT toggle (default on). Off stops finished runs from auto-staging and keeps an arrival pulse until reviewed.
- [fleet-console] Zoom the triage Watch Deck with wheel, pinch, or Ctrl/Cmd+wheel. Zooming out past legibility turns the deck into a fleet map.
- [fleet-console] The triage fleet map lives inside Theater zones: wheel zoom, names on every marker, waiting markers pulse, running markers drift and pause on hover.
- [fleet-console] War Room reads the same way at every density. Queue sections always stand with their own counts; the fleet map keeps each Theater zone in place; markers can be dragged to move panels.
- [fleet-console] Turning War Room spotlight off stops every automatic staging. Only an explicit pick stages a panel.
- [fleet-console] Help > Show the screen guide replays the guide for the screen in front of you, not a wider introduction.

#### Changed
- [fleet-console] Toggle Settings with the command-band Settings button. Pressing it again returns to the previous page, or to Operations.
- [fleet-console] Triage is one global mode across every Theater. Staging an Operation from another Theater does not switch Theaters.
- [fleet-console] Replace six map controls with one Cruise / Tactical / War Room switch plus a tray of that mode's tools. The three mode names stay English in every locale.
- [fleet-console] Move triage Spotlight and deck density into the War Room tray, so every mode keeps its tools in the same place on the band.
- [fleet-console] Replace the single War Room walkthrough with one guide per reworked screen. Only one guide plays per visit.

#### Fixed
- [fleet-console] Watch Deck cards use the same status names and order as the sidebar, so idle no longer reads as awaiting.
- [fleet-console] Close the canvas control menu when left-clicking the map, wherever it was opened.
- [fleet-console] Layout buttons exist only in Tactical, so pressing one can no longer silently leave War Room.
- [fleet-console] Stop offering Reset canvas view in War Room, where it did nothing.
- [fleet-console] Show the War Room guide even when nothing is waiting. It opens on the queue rail and skips the stage step until something is staged.

### fleet-core

#### Changed
- [fleet-admiral] The gateway roster names the agent that runs each model, one name per reasoning level, so a stage can be assigned by name instead of a rejected model id.

#### Fixed
- [core-ai-gateway] Gateway responses from Kimi and OpenCode Anthropic-wire models carry the model id the session requested, so resume restores the model.

## [1.46.0] - 2026-08-03

### fleet-cli

#### Added
- [fleet-cli] `fleet auth login` and `fleet auth logout` accept `kimi|opencode`, and both providers appear in the authentication panel.

### fleet-console

#### Added
- [fleet-console] When the triage queue is empty, a live Watch Deck shows every non-dormant Operation as a card. Clicking a card stages it.
- [fleet-console] Add a Background activity state for Operations whose subagents or workflows outlive the finished turn.
- [fleet-console] Codex search matches entry body text and shows highlighted snippets.
- [fleet-console] Codex reader gains back/forward history, and restores last entry and scroll per Theater after reload.
- [fleet-console] The Codex split view shows a collapsible outline that tracks the current section.
- [fleet-console] Codex entry cards show relative update times, with newest/name sorting and tag-chip filtering.
- [fleet-console] The command palette lists Codex wiki entries so a document can be opened from anywhere.
- [fleet-console] The Codex navigator shows a wiki health strip for the last drydock run, conflicts, and pending reviews.

#### Changed
- [fleet-console] Move system controls into the command band: gear opens Settings, and the ? menu carries What's New, shortcuts, update, and GitHub links. The sidebar System Menu is removed.

#### Fixed
- [fleet-console] When the sidebar is collapsed, command-band map controls dock to the left cluster instead of floating at the old sidebar width.
- [fleet-console] Codex conflict list rows open their detail view, and code copy works in drydock and schema documents.
- [fleet-console] The Codex reader ignores stale responses during rapid navigation and escapes patch metadata before rendering.

### fleet-plugin

#### Added
- [fleet-console] Repository Compare prefills base with the default branch and head with the current branch, then runs on entry. A swap button exchanges them.
- [fleet-console] Branch rows gain compare actions that open Compare already filled and run.
- [fleet-console] Quota windows state their reset period and provenance, mark Cursor total as a pool aggregate, and include Kimi absolute usage counts.
- [fleet-console] Terminal sessions report a latest sanitized transcript line for Watch Deck cards that have no live preview.
- [fleet-console] Track background subagent work until the pending count drains, a 30-minute limit expires, or the session leaves the live lifecycle.
- [fleet-console] Generalize Terminal model-auth into API keys for AI Gateway, with OpenCode Go sign-in next to Kimi.
- [fleet-console] Show an OpenCode Go card in Usage limits from local OpenCode CLI logs against published Go caps, noted as local-observed spend only.

#### Changed
- [fleet-console] Rename the Settings Carriers section to AI Classic in both locales.

#### Fixed
- [fleet-console] Stop terminal device-query replies from being typed into the shell prompt when a Shell panel is reopened and scrollback is replayed.
- [fleet-console] The Compare run button no longer clips off-screen at the default rail width.
- [fleet-console] Repository hunk endpoints pass `--no-ext-diff` and `--no-textconv`, so repository-local diff drivers cannot run from browser-triggered diffs.

#### Removed
- [fleet-console] Remove Cursor Agent from Terminal plugin analyst and agent-launch catalogs and from CLI detection. Cursor remains available through the AI Gateway.

### fleet-core

#### Added
- [fleet-admiral] `gateway_models` now derives per-window pressure verdicts on the server. Workflow ranks allowances by that verdict instead of raw percentages across clocks that reset differently.
- [core-ai-gateway] Add OpenCode Go as an AI Gateway provider serving 22 subscription models over their native wires, including `/zen/go/v1/messages` and `/zen/go/v1/responses`.
- [fleet-admiral] Validate OpenCode Go API keys with a live Anthropic-compatible probe before storing them, alongside existing Kimi validation.

#### Fixed
- [core-ai-gateway] Strip JSON Schema `format` hints from OpenAI strict tool schemas so an unsupported format no longer fails the whole Codex request with 400.

#### Removed
- [core-unified-agent] Remove the Cursor ACP provider from the unified Agent CLI SDK. Cursor remains available through the standalone AI Gateway adapter.

## [1.45.0] - 2026-08-03

### fleet-cli

#### Removed
- [fleet-cli] Remove Codex CLI from the Fleet launch catalog.

### fleet-console

#### Removed
- [fleet-console] Drop the `@fleet-console/sdk/launch` subpath. `LaunchContext` now ships from `@fleet-console/sdk/plugin`.
- [fleet-console] Remove Codex Agent Operations while preserving legacy session data and Fleet Wiki Codex.

### fleet-plugin

#### Fixed
- [fleet-console] File Explorer git badges run git with the same environment denial as the Repository panel, so inherited askpass or unknown helpers cannot run from a badge refresh.
- [fleet-console] Session Analyst routes accept JSON whose `Content-Type` carries a charset or uppercase media type.
- [fleet-console] The AI Gateway finds the Cursor subscription token on Linux and Windows, not only macOS (`%APPDATA%/Cursor/auth.json`, or `cursor/auth.json` under `$XDG_CONFIG_HOME` or `~/.config`).
- [fleet-console] The AI Gateway honors `CODEX_HOME` when looking for the ChatGPT subscription token, so a relocated Codex home no longer 401s while Usage limits still finds the login.

#### Removed
- [fleet-console] Remove Codex Agent Operation launch, resume, capture, and activity integration from the Terminal plugin.

### fleet-core

#### Added
- [core-ai-gateway] Add shared Cursor and Codex credential lookup so every caller resolves a subscription token through one platform-aware implementation.

#### Fixed
- [fleet-wiki] A queued patch keeps tags that contain a newline, quote, or backslash intact.

#### Removed
- [fleet-admiral] Remove Codex CLI profiles, injection, and plugin registration from Admiral.

## [1.44.1] - 2026-08-02

Release v1.44.1

## [1.44.0] - 2026-08-02

Release v1.44.0

## [1.43.0] - 2026-08-02

### fleet-core

#### Changed
- [fleet-admiral] Stop disabling Claude Code's built-in agents in a gateway session. Gateway model agents sit alongside them, so delegation to the session's own model is available again.
- [core-unified-agent] Drop live Claude/Codex e2e suites from the default test run. The same contracts stay under mocked unit coverage.

## [1.42.0] - 2026-08-02

### fleet-console

#### Added
- [fleet-console] Let a plugin mark a companion panel unavailable for an Operation, so the panel, shortcut, and shortcut-help entry disappear together.
- [fleet-console] Describe each Claude launch kind with a one-line summary in Canvas Controls.

#### Changed
- [fleet-console] Walk the three Claude launch kinds in menu order on the first Canvas Controls open, so Native and Classic are introduced alongside Gateway.

#### Fixed
- [fleet-console] Keep the feature-tour progress count within its total when Next is pressed repeatedly before the card advances.

### fleet-plugin

#### Added
- [fleet-console] Add a Claude (Native) launch that reuses Claude Code with wiki skills, Console hooks, and wiki MCP only. There is no Carrier Streams surface.

#### Changed
- [fleet-console] Drop Carrier Streams, its STREAMS handle, the live sortie ribbon, and Alt+C from Claude (Gateway) Operations, which never receive carrier tools.

#### Fixed
- [fleet-console] Drop the (Classic) suffix from the Codex launch entry. It has no Native or Gateway variant to contrast with.

### fleet-core

#### Added
- [fleet-admiral] Introduce a console-only `claude-native` Agent CLI with `native` doctrine that skips the Admiral system prompt and carrier/gateway tools.
- [core-ai-gateway] Add opt-in gateway wire logging behind `FLEET_GATEWAY_WIRE_LOG`. It stays off unless the variable names a path.

#### Changed
- [fleet-admiral] Under gateway doctrine, hand work to an Agent by default and reserve staged workflows for when you ask for one.
- [fleet-admiral] Read the live gateway roster before every delegated run and pick the model by fit and allowance instead of reusing the session model.
- [fleet-admiral] Describe gateway execution as a run that returns its result, and drop the `<system-reminder>` preamble about background job completion.
- [fleet-admiral] Treat an empty or missing return as the normal shape of a failed gateway run. Do not absorb a twice-failed run into the host session without reporting it.

#### Fixed
- [fleet-admiral] Deny built-in Claude Code agents with legacy and current selectors while simplifying gateway custom agent names.
- [core-ai-gateway] Gateway-backed models no longer fill in optional tool arguments they were never asked to send, so a pinned subagent is not rerouted to Claude and a file read does not fail on a fabricated argument.

## [1.41.0] - 2026-08-02

### fleet-cli

#### Removed
- [fleet-cli] Remove `fleet console` and local-only `fleet desktop`. Use the standalone `fleet-console` binary. `fleet update` still stops a running Console by resolving `fleet-console` on PATH.

### fleet-console

#### Added
- [fleet-console] Guide the first Claude Gateway launch from Canvas Controls. Triage guidance stays tied to entering Triage.

#### Changed
- [fleet-console] Keep agent CLI session capture data only in the Console state file instead of a separate captures directory.
- [fleet-console] Migrate existing capture files into the Console state file on startup, then remove the leftover captures directory.

#### Fixed
- [fleet-console] Resolve npm/pnpm global bin symlinks and macOS `/var` vs `/private/var` aliases so installed `fleet-console` actually starts instead of exiting silently.

### fleet-plugin

#### Added
- [fleet-console] Ledger charts device-wide daily cost above per-CLI totals for windows of two days or more, including days with zero usage.
- [fleet-console] The Ledger daily chart states that each session's cost counts on the day it was last active.
- [fleet-console] Ledger skips usage records whose timestamps cannot form a four-digit local date, so malformed data does not break the panel.
- [fleet-console] Show git status badges (M/U/D) on File Explorer rows.
- [fleet-console] Session Analyst Escape dismisses the slash-command list, then clears the draft, then closes the Analyst companion.
- [fleet-console] Inject a theme-token base stylesheet into served Session Analyst artifacts so they follow the active console theme (`--fleet-canvas` and related tokens).
- [fleet-console] Add a File Explorer context menu: Copy Path, Copy Relative Path, Reveal in File Manager, and Open with Default App.
- [fleet-console] Make the File Explorer pane divider keyboard-operable, with arrow-key resizing.
- [fleet-console] Add a Repository Sync action that runs `git fetch --prune --no-tags` then refreshes branches, history, worktrees, and changes.
- [fleet-console] Opening the Repository panel auto-syncs when the last fetch is older than 5 minutes. Failures still show local data.
- [fleet-console] Add a Claude (Gateway) launch that drives Claude Code through a local AI Gateway to Codex, Cursor, or Kimi backends. Native Claude models pass through untouched.
- [fleet-console] Rework Terminal settings Agent CLI into AI Gateway with a per-provider model loadout. Only enabled models reach `/model` (opt-in). A starred model becomes the session default.
- [fleet-console] Add an opt-in Diagnostics control to AI Gateway settings (default Off) that records payload-free Cursor transport events for newly started traces.
- [fleet-console] The AI Gateway answers a context-exhausted turn with `Prompt is too long: N tokens > M maximum` so Claude Code can compact and continue.
- [fleet-console] A gateway failure after response headers were sent ends with a terminal SSE `error` frame carrying the reason, instead of silently truncating.
- [fleet-console] Report Kimi usage in Usage limits as a fourth provider, using the Kimi API key already registered in Fleet.
- [fleet-console] Track Cursor Auto and API allowances as separate windows.
- [fleet-console] Give a Claude (Gateway) session a gateway_models tool that reports assignable models, windows, effort ladders, quota pools, and current provider allowances. Only models enabled in Settings are listed.
- [fleet-console] Claude Gateway Operations inject AI Gateway model and effort Agents at spawn, and disable the built-in Claude Code Agent roster for that path.

#### Changed
- [fleet-console] Open the finished or started Operation directly from a scuttlebutt bubble. A separate dismiss action closes the announcement.
- [fleet-console] Expand simultaneous scuttlebutt announcements into one focusable row per Operation.
- [fleet-console] Dismiss the Session Analyst slash-command list when a catalog selector gains focus, so the two suggestion layers no longer stack.
- [fleet-console] Distinguish classic Claude and Codex canvas Operations from AI Gateway Operations.

#### Removed
- [fleet-console] Remove the direct Kimi (Claude Code) launch. Kimi sessions now run through the AI Gateway; effort is controlled inside Claude Code via `/effort` and `/model`.

### fleet-core

#### Added
- [core-ai-gateway] Add a core AI gateway package that translates Anthropic Messages requests into Codex, Cursor, and Kimi upstream calls from one model catalog.
- [core-ai-gateway] Add a per-trace diagnostics policy that stays stable across Cursor tool continuations while new traces adopt the current setting.
- [core-ai-gateway] The gateway refuses an over-window turn before calling upstream, and sizes only the tools an adapter actually sends.
- [core-ai-gateway] Derive per-model routing constraints from the catalog: upstream identity, advertised reasoning levels, Anthropic lineage, and Cursor quota pool.
- [fleet-admiral] Direct a Claude (Gateway) host to keep stage model and effort as its own decision. Inheriting the session model is the default; pinning one requires a stated reason.
- [fleet-admiral] Add four on-demand operation skills for Claude (Gateway) sessions: architecture-review, implementation-run, quality-review, and codebase-research.
- [core-ai-gateway] Preserve Codex cache and reasoning usage details while keeping Anthropic token accounting consistent across streaming and non-streaming responses.
- [core-ai-gateway] Support Claude Code `Web Search` through Codex Responses, with domain filters, source results, and explicit provider search errors.

#### Changed
- [fleet-admiral] Split Admiral prompt doctrine so Claude Gateway sessions run on standing orders without protocol skills, carrier roster, or carrier_dispatch tools. Classic Agent CLI sessions keep those.
- [fleet-admiral] Gateway Orchestration Policy requires the `gateway_models` MCP tool before choosing a staged Agent whose model or effort differs from the session default.

## [1.40.0] - 2026-07-30

### fleet-cli

#### Removed
- [fleet-cli] Remove Fleet Plans tools and workspace binding from the terminal host.
- [fleet-cli] Remove the opencode-go carrier color palette entries.

### fleet-console

#### Added
- [fleet-console] Open the command palette directly with Mod+P, pre-seeded with the command-mode prefix.

#### Changed
- [fleet-console] Replace the rail header Float over Map text toggle with a picture-in-picture icon, and swap opacity presets for a continuous 40-100 slider.
- [fleet-console] Retune the Whites light theme from blue-tinted white to a warm oatmeal neutral. Brass, signal, carrier, and identity colors are unchanged.
- [fleet-console] Rebuild the Settings theme picker as a Light|Dark switch. Dark slides open Instrument, Maritime, and Carbon and restores the last dark theme per browser.

#### Removed
- [fleet-console] Remove the Plans Activity Rail panel, search integration, and HTTP APIs.
- [fleet-console] Retire the Daywatch and Drydock light themes. Stored selections fall back to Whites so first paint stays light.
- [fleet-console] Remove OpenCode Go from Agent CLI detection, launch-path configuration, and Session Analyst provider selection, and drop the opencode carrier theme tokens.

### fleet-plugin

#### Added
- [fleet-console] Scuttlebutt announces operation starts with a Started bubble, mirroring finished-work arrivals. Starts on the Operation you are watching stay silent. A new departure-bell setting (on by default) controls the signal.
- [fleet-console] Add a Usage limits rail panel for Claude Code and Codex subscription rate limits, with session, weekly, and model-scoped bars plus remaining Codex reset credits.
- [fleet-console] Read Claude usage with the local CLI sign-in only after an explicit connect step. Credentials stay read-only; requests go only to each provider.
- [fleet-console] Add Cursor to Usage limits, showing included, Auto, and API spend for the billing cycle, time until reset, and the current plan.

#### Changed
- [fleet-console] Warm the Whites terminal paper, ink, and neutral ANSI rungs to match the oatmeal atmosphere. Chromatic ANSI colors stay semantic.
- [fleet-console] Connect and disconnect each usage provider independently, so acting on one no longer refreshes the others.

#### Fixed
- [fleet-console] Sharpen Korean labels on in-panel companion handle chips.
- [fleet-console] Repository history no longer draws merge-commit lane lines above the branch point or dead-end stubs toward parents outside the loaded page.
- [fleet-console] Commit rows keep a uniform graph gutter so subjects no longer shift sideways across merge spans.

#### Removed
- [fleet-console] Remove Plan tools from Terminal Agent sessions.
- [fleet-console] Show historical opencode Ledger rows with the default glyph and raw client id.

### fleet-core

#### Breaking Changes
- [core-agent][fleet-admiral][fleet-carriers] Remove the Fleet Plans package and Plan-specific orchestration contracts.
- [core-unified-agent][fleet-analyst] Remove the opencode-go provider. opencode is no longer detected or launchable as a Fleet backend.

## [1.39.0] - 2026-07-29

### fleet-console

#### Changed
- [fleet-console] Light themes now make the terminal the brightest surface so attention lands on the work area. Dark themes are unchanged.
- [fleet-console] Light-theme Operation frames and titlebars now match the command band instead of being the darkest tone on screen. Dark themes are unchanged.

#### Fixed
- [fleet-console] Brass primary-button text stays readable in all three light themes.

### fleet-plugin

#### Changed
- [fleet-console] Light terminal backgrounds become the brightest surface while keeping each theme's tint, and bright-white ANSI blocks stay whiter than the page.

## [1.38.0] - 2026-07-28

### fleet-console

#### Added
- [fleet-console] Delete stale plan files from the Plans rail with a two-step ARM confirm. An open reader closes when its plan is removed.

#### Changed
- [fleet-console] Command palette search now matches typos and abbreviations, ranking exact matches first.
- [fleet-console] Bundle Pretendard Variable as the Korean UI fallback, and slightly raise light-theme body weight so Hangul stays legible.

#### Fixed
- [fleet-console] Restore readable contrast for signal-colored badges and labels on Daywatch, Whites, and Drydock. Dark themes are unchanged.
- [fleet-console] Darken light-theme secondary text so small labels stay readable on bright surfaces.
- [fleet-console] Keep Codex search, open document, and reading position when switching or reopening the rail; reset them only when the Theater changes.

### fleet-plugin

#### Added
- [fleet-console] Agent CLI settings let you point a CLI at its executable when PATH does not reach it, verify it, and see which PATH entries were searched.
- [fleet-console] Pass a COLORFGBG hint to new shell and agent sessions, and show a one-time chip on live terminals when the console theme switches between dark and light.

#### Changed
- [fleet-console] Repository history keeps loaded pages, scroll, selected commit, and filter when you leave and return.
- [fleet-console] History toolbar gains a refresh control, so reloading commits no longer requires switching rail panels.
- [fleet-console] Agent CLI detection and launch share one order: environment override, then a path you set, then PATH. A configured source that fails is reported instead of quietly falling back.

#### Fixed
- [fleet-console] Keep light-theme terminals readable when agent CLIs emit dark-tuned or white ANSI text.
- [fleet-console] Ledger rail scrolls when the operation list overflows, so the per-CLI device-wide section stays reachable.
- [fleet-console] Reset Ledger scroll to the top when opening an operation detail and restore the list position on back.
- [fleet-console] Repository changes and compare lists restore their scroll position when you return.
- [fleet-console] The workspace source tree no longer loses scroll restore when branches, worktrees, or change counts finish loading.
- [fleet-console] The Scuttlebutt completion bubble keeps its Finished label visible even when the Operation title is long.

## [1.37.1] - 2026-07-28

### fleet-plugin

#### Fixed
- [fleet-console] Keep all three Scuttlebutt admiral mascot colors unchanged across Console themes.

## [1.37.0] - 2026-07-27

### fleet-console

#### Added
- [fleet-console] Add three light themes (Daywatch, Whites, Drydock) and group the Settings theme picker into Dark and Light.
- [fleet-console] Apply the stored theme in the initial HTML so light-theme users no longer see a dark first-paint flash.
- [fleet-console] Markdown syntax highlighting follows the active theme, with a dark fallback for older engines.

#### Fixed
- [fleet-console] Keep idle operations streams connected across local networking environments.

### fleet-plugin

#### Added
- [fleet-console] Add light terminal palettes for all three light themes. Global Shell and Session Analyst artifacts follow the active theme.

## [1.36.0] - 2026-07-26

### fleet-console

#### Added
- [fleet-console] Command palette command mode now covers session lifecycle: undo last close while the eight-second window is live, Add Theater, and Forget Theater, using the same undo window as the sidebar.
- [fleet-console] Command mode also shows rail panel search results, so a query after > reaches Files, Repository, and other panels without leaving command mode.
- [fleet-console] Report a lost server link on the command band, a banner, and frozen rail panels, each offering to reconnect.
- [fleet-console] While a reconnect overlay covers a rail panel, keyboard focus moves to reconnect and returns when the link is live.
- [fleet-console] Fit all panels frames every visible Operation (Shift+1, a command-band button, or the palette). Terminals keep !, and the command is hidden in Formation view and Triage mode.
- [fleet-console] Alt+Up and Alt+Down maximize or minimize the active panel on the map and in Formation view.
- [fleet-console] In Triage mode, Alt+Down sets the current item aside after a second press within 1.5 seconds; Escape cancels.
- [fleet-console] Holding Alt shows each panel's position number and the keys available in the current mode.
- [fleet-console] Plugins can give a companion panel a keyboard shortcut; Console dispatches it and lists it in shortcut help.
- [fleet-console] The command band breadcrumb folds away before it can collide with map controls on a narrow window.
- [fleet-console] Plugins can render a floating widget across the console without taking a panel, reading the fleet as aggregate signals only.

#### Changed
- [fleet-console] Shortcut help no longer lists two Esc entries that had no effect.

#### Fixed
- [fleet-console] The Triage button no longer overlaps Formation layout icons in the command band.
- [fleet-console] Triage mode opens empty and unfocused when no Operation is waiting.
- [fleet-console] The command band breadcrumb centers on the panel area, so the sidebar no longer pushes it off center.

### fleet-plugin

#### Added
- [fleet-console] Session Analyst artifacts gain an Export menu: download HTML, copy source, or open the themed render in a new tab. Work stays on this machine.
- [fleet-console] Alt+C toggles Carrier Streams and Alt+A toggles Session Analyst on the active agent Operation.
- [fleet-console] A Ledger panel reports local agent CLI token usage and dollar cost per Operation and per CLI on this device. tokscale collects usage locally; nothing is uploaded and prompt text is not read.
- [fleet-console] Add Scuttlebutt, three quaker admirals who roam the console and answer quick questions without a Theater or an Operation.
- [fleet-console] Give Tori, Bori, and Dori a chat session and a voice of their own, each reachable by clicking that admiral.
- [fleet-console] Let the admirals search the web and read public sources, while file and shell work stays with an Operation in a Theater.
- [fleet-console] Report the fleet through posture: thinking while operations run, an alarm while something waits on approval or the stream is down, and a cheer when an operation finishes.
- [fleet-console] Announce a finished operation in a bubble that follows the admiral carrying it and then clears itself.
- [fleet-console] Retire any admiral individually from settings, and pin one where it stands from the head of its chat without stopping its animations.
- [fleet-console] Ship the admirals off by default and mark the settings section experimental, so nobody gets a floating mascot they did not ask for.
- [fleet-console] Freeze the flock into a still formation when the console or the system asks for reduced motion.

#### Changed
- [fleet-console] Repository history continues past the first 200 commits with a load-more control, and says so when the first commit is reached.
- [fleet-console] Repository history renders only the rows in view, so a longer list no longer makes the panel heavier.
- [fleet-console] Repository history graph lanes follow real ancestry even when a filter is applied.
- [fleet-console] Show idle agent session settings and agent alerts in the console display language instead of English only.
- [fleet-console] Show each carrier's role and mission in the console display language, switching with the language setting without refetching.

### fleet-core

#### Added
- [core-unified-agent] Allow a system prompt to replace the CLI preset instead of prefixing it, so a caller can define an agent's whole identity.
- [fleet-carriers] Keep carrier translations display-only so the host agent's routing roster stays language independent.

## [1.35.0] - 2026-07-26

### fleet-console

#### Added
- [fleet-console] A view mode control in the command band switches Auto, Mobile, and Desktop. Auto follows window width so a narrow window opens the mobile layout on its own.
- [fleet-console] Narrow screens get a dedicated shell that lists Operations by status, opens one session full screen, and returns with back. The desktop canvas layout is unchanged.
- [fleet-console] Add Triage mode: stow every panel and bring up one waiting Operation at a time (queue rail, Alt+T, Alt+Right defer). Waiting means input needed or just went idle unseen.
- [fleet-console] Add guided feature tours that introduce a new capability at its entry point once, remembering what has been seen.

#### Changed
- [fleet-console] An unseen idle Operation now signals in the sidebar and with a green Map rim. Focusing it clears the signal, except in Triage mode.
- [fleet-console] Rebuild Formation view as a situation board with a brighter survey grid, slot numbers, open-slot guides, and an entry sequence.
- [fleet-console] Remember first-run onboarding in console settings instead of browser storage, so it no longer reappears on another browser or device.

#### Fixed
- [fleet-console] Alt+Arrow panel cycling follows canvas layout order while the sidebar is sorted by status, instead of jumping through status sections.
- [fleet-console] Join the expanded Theater sidebar to the command band above it, so the shared column no longer shows a double line at the seam.
- [fleet-console] Stop modals, menus, toasts, the command palette, and the Float over Map Solid preset from showing the canvas through in the maritime and carbon themes.

### fleet-plugin

#### Added
- [fleet-console] While carriers stream, Agent Operations show a sortie ribbon of how many are out and what each is doing. Clicking it opens Carrier Streams without shrinking the terminal.

#### Changed
- [fleet-console] Carrier stream rows share the panel height instead of a fixed cap: one stream fills what it needs, and more streams shrink evenly down to a readable floor.

#### Fixed
- [fleet-console] Draw repository history graph lanes from real git ancestry instead of branching at commits the log had dropped.
- [fleet-console] Leave a lane unconnected where a filter or row cap hides commits in between, rather than asserting ancestry the visible rows do not prove.
- [fleet-console] EXIT on the Session Analyst handle now closes the artifacts panel together with the chat panel.
- [fleet-console] Make the Skills reading overlay and toast and the Session Analyst artifact menu and slash-command list fully opaque in the maritime and carbon themes.

## [1.34.0] - 2026-07-25

### fleet-cli

#### Changed
- [fleet-cli] Let the Admiral host author and mutate Fleet Plans directly, while keeping task completion marking exclusive to Ohio.
- [fleet-cli] Unify local and remote codebase intelligence under Vanguard's read-only reconnaissance contract.
- [fleet-cli] Show five default Carriers after retiring Kirov and moving optional Plan assurance to Nimitz.
- [fleet-cli] Show four default Carriers after retiring Ohio and moving direct and Plan-driven implementation to Genesis.

### fleet-console

#### Added
- [fleet-console] Add Solid/90/75/60 opacity presets to Float over Map so the floating panel can let the Map show through while content stays opaque. The choice persists.
- [fleet-console] Add Operation actions to the command palette: Resume (dormant only), Close, Minimize all, Toggle Formation view, and Toggle status axis, plus activity badges on search rows.
- [fleet-console] The Activity Rail resize handle is keyboard operable: Arrow resizes, Shift+Arrow resizes in larger steps, Home/End jump to min and max width.
- [fleet-console] Open Operation chip and Theater row context menus with Shift+F10 or the ContextMenu key, so group and accent assignment no longer require a right click.
- [fleet-console] Add Rename, Assign group, Set accent, and Minimize for the active Operation to the command palette.
- [fleet-console] Hold a closed Operation or a forgotten Theater for eight seconds before deleting it, with an undo toast and Mod+Z. Restored Operations come back dormant and start only when relaunched.
- [fleet-console] Search Repository commits, Files paths, Plans, and Skills from the command palette, and open the owning panel at that result.
- [fleet-console] Plugins can localize panel, operation, settings, and notification titles, and rail panels now receive the resolved locale.

#### Changed
- [fleet-console] Pin all four Sort by Status sections with per-section collapse (empty sections stay dimmed and collapsed), show group names instead of color dots, and switch the Theater actions icon to an ellipsis.
- [fleet-console] Turn the empty Operations map into an actionable surface with standing-by operation chips, a New Operation button, and shortcut hints.
- [fleet-console] Unify control labels and buttons onto one grammar, and return control and CTA labels to sentence case while keeping uppercase for structural section labels.
- [fleet-console] De-emphasize text by stepping it down a tier instead of fading it, so a dimmed label keeps its contrast.
- [fleet-console] Remember Activity Rail width per panel instead of sharing one width, so widening Repository no longer leaves Alerts occupying the same space.
- [fleet-console] Open each Activity Rail panel at its own default width, with Repository and Codex wider than Plans, Files, and Skills.
- [fleet-console] Answer a delete request for an Operation that no longer exists with success, so repeating a close is harmless.
- [fleet-console] Describe Vanguard as the unified local and remote reconnaissance specialist in the Carrier roster.
- [fleet-console] Order each sidebar status section by the most recent transition, keeping untouched operations in their manual order.
- [fleet-console] Mark operations that land in IDLE with a session-only unseen dot and section header count until you open them once.
- [fleet-console] Shorten the first status section header from AWAITING INPUT to AWAITING.
- [fleet-console] Rename the Settings > General language card to Display language and describe it as the language used across Console surfaces.
- [fleet-console] Present a five-Carrier roster with Nimitz carrying optional Plan assurance and no Kirov entry.
- [fleet-console] Display language now drives the console itself: command band, sidebar, canvas, command palette, shortcuts, Settings, What's New chrome, and Codex, with dates formatted per locale.
- [fleet-console] Switching the language applies immediately without a reload.
- [fleet-console] Present a four-Carrier roster with Genesis carrying direct and Plan-driven implementation and no Ohio entry.

#### Fixed
- [fleet-console] Raise dimmed interface text in all three themes so panel titles, section labels, metadata, and control captions stay readable.
- [fleet-console] Distinguish the four Operation status beacons by shape as well as color.
- [fleet-console] Apply the intended font family and label sizes in the Codex reading sheet and navigator.
- [fleet-console] Classify restored Operations as DORMANT instead of IDLE in the sidebar status axis and Alt cycling, matching the canvas frame.
- [fleet-console] Open the canvas and sidebar right-click menu at the cursor, flipping it above the pointer when there is no room below.

### fleet-plugin

#### Added
- [fleet-console] Collapse and expand Repository workspace tree sections, with Tags and Stashes folded by default. Fold state is in-memory only.
- [fleet-console] Answer every dormant Resume click with a pending Resuming... state, a Try again / Start fresh failure card, and a Resume failed Alerts entry. Start fresh relaunches without the saved provider session.
- [fleet-console] Idle agent terminals move to DORMANT after a configurable idle period (default 1 hour). Working sessions and sessions without a saved provider session are never transitioned.
- [fleet-console] Add an Idle agent sessions option to Settings > Terminal > General (Off / 30 minutes / 1 hour / 2 hours / 4 hours), saved on the Console server.

#### Changed
- [fleet-console] Wrap Repository History commit subjects to two lines in narrow panels and show the full subject on hover.
- [fleet-console] Expose host-owned Fleet Plan authoring in Console Agent sessions while keeping Carrier Plan mutation fail-closed.
- [fleet-console] Remove Tempest from Terminal Carrier settings and job identity styling, with a neutral fallback for old identities.
- [fleet-console] Replace the agent operation's bottom stream dock with a Carrier Streams companion. STREAMS above ANALYZE opens stacked carrier rows; finished carriers collapse to one-line strips that persist for the session.
- [fleet-console] Open Carrier Streams and Session Analyst from their own edge handles, with a live pulse on STREAMS while carriers stream and on ANALYZE while analysis runs.
- [fleet-console] Keep stale Kirov settings and stream ownership inert while omitting Kirov from settings and identity styling.
- [fleet-console] Built-in Terminal, Repository, Files, and Skills panels follow the Display language setting.
- [fleet-console] Keep stale Ohio settings and stream ownership inert while omitting Ohio from settings and identity styling.

#### Fixed
- [fleet-console] Raise dimmed text in the Repository, Skills, Files, and Session Analyst panels so it stays readable, including commit rows outside the checked-out branch.
- [fleet-console] Apply the intended font family to Files panel tree labels.
- [fleet-console] Walk the Files tree with Arrow, Home, and End, with a single tab stop for the whole tree.
- [fleet-console] An agent panel returns to running once the agent resumes after an input prompt, and drops to idle when a turn is interrupted.

#### Removed
- [fleet-console] Remove the Codex ACP/App Server launch-mode selector; Console-launched Codex sessions now always use App Server.

### fleet-core

#### Added
- [core-unified-agent] Add Fast Codex model assets for GPT-5.6 and GPT-5.5, mapped to the App Server `priority` service tier.
- [fleet-admiral] A Codex session reports input waiting to the Console.

#### Changed
- [fleet-carriers] Merge Tempest's GitHub-focused intelligence into Vanguard's read-only local and remote codebase contract.
- [fleet-admiral] Route reconnaissance dispatches through Vanguard with generalized `objective`, `search_space`, `hints`, `constraints`, and `depth` request blocks.
- [core-unified-agent] Keep Codex sessions out of the Codex CLI resume picker by archiving each thread on disconnect and unarchiving it on resume.

#### Fixed
- [core-unified-agent] Stop Codex session teardown from hanging when the app-server exits before answering the archive request.

#### Removed
- [core-unified-agent] Remove the `ait` CLI, Codex ACP bridge support, and the GPT-5.4 model family.

#### Breaking Changes
- [fleet-admiral] Keep Fleet Plan authoring and mutation host-owned, expose optional Plan assurance through Nimitz, and keep task completion marking exclusive to Ohio.
- [fleet-carriers] Remove Kirov from the default Carrier contract and exports without an alias, and add optional exact-PlanRef assurance to Nimitz.
- [fleet-admiral] Remove Kirov dispatch routing and expose optional `plan_ref` assurance through Nimitz while preserving host and Ohio ownership.
- [fleet-carriers] Remove Ohio from the default Carrier contract and exports without an alias, and extend Genesis to execute optional same-Lane TaskRefs without mutating Plan state.
- [fleet-admiral] Give the host sole ownership of Plan mutation and completion, exposing `plan_mark_tasks` to the host after artifact inspection and Lane QA.
- [fleet-plans] Require the Carrier-neutral host-completion policy for new Plans. The exact legacy Ohio policy stays lint-compatible only for existing Plans.

## [1.33.0] - 2026-07-23

### fleet-cli

#### Removed
- [fleet-cli] Remove Chronicle from the built-in roster and report seven default Carriers.

### fleet-console

#### Added
- [fleet-console] Add a theater-row status-axis toggle (Alt+S) that regroups the sidebar into AWAITING INPUT / RUNNING / IDLE / DORMANT. The mode is session-only and always reopens on the group axis.
- [fleet-console] The console Language setting (Settings > General) now also drives Session Analyst.

#### Changed
- [fleet-console] Replace the sidebar Add Theater chrome row with a quiet New Theater row at the end of the Theater list.
- [fleet-console] Move Reset view and Formation layout toggles from the sidebar to a command-band cluster just right of the sidebar, so they stay reachable in Formation view and no longer appear on Settings.
- [fleet-console] Replace the theater-row operation count with the status toggle, fold collapse into the row click, and merge the actions and new-operation buttons into one split control.

#### Fixed
- [fleet-console] Stop the right rail from animating open or closed when Float over Map is toggled; the panel stays in place and only the Map reflows.
- [fleet-console] Render the sidebar Operation status dot in green for idle panels, matching the panel header beacon.
- [fleet-console] Prevent Plan files from remaining stuck on Loading during live list refreshes.

#### Removed
- [fleet-console] Remove Chronicle identity styling and use a neutral brass fallback for removed or unknown Carrier identities.

### fleet-plugin

#### Added
- [fleet-console] Rebuild the Repository rail around a Full Workspace layout: a persistent source tree beside an always-visible commit graph, with commit details and diff docked below.
- [fleet-console] Session Analyst follows the console Language setting: panel copy and analysis answers render in English or Korean, with auto resolving from the browser language.
- [fleet-console] Session Analyst CLI/Model/Effort selections persist across reloads. Reset restores the saved default, and the selectors stay locked while a reset is in flight.

#### Fixed
- [fleet-console] Keep Session Analyst responsive across multiple Operations by sharing one browser event stream.

#### Removed
- [fleet-console] Align Terminal Carrier settings and status surfaces with the seven-Carrier roster.

### fleet-core

#### Added
- [fleet-analyst] Analyst sessions accept a response-language option and append a Korean response-language directive when Korean is selected.

#### Breaking Changes
- [fleet-admiral] [fleet-carriers] [fleet-wiki] Remove the Chronicle persona from the built-in Carrier catalog. Documentation synthesis and Fleet Wiki mutation are now host-owned.

## [1.32.0] - 2026-07-22

### fleet-console

#### Added
- [fleet-console] Add a Float over Map toggle to the right rail so panels can overlay the Map without resizing it. The choice persists.
- [fleet-console] Add a Reduce panel motion toggle to Settings > General. Off follows the OS; on suppresses panel animations. Stored with Console settings.
- [fleet-console] Add shared themed dropdowns to the SDK browser surface so plugin settings can use the same readable popups as Console.

#### Changed
- [fleet-console] Replace native dropdowns across Console settings, What's New, and Cowork with the shared themed Select for readable dark-theme popups.
- [fleet-console] Replace native dropdowns in Terminal carrier, model, effort, and Task Force settings, the Session Analyst composer, and Repository compare controls with the shared themed Select.

#### Fixed
- [fleet-console] Keep Alt+Left and Alt+Right from selecting or restoring minimized Operation panels while Session Analyst, maximized, or Formation views are active.
- [fleet-console] Carrier completion System Reminder messages now submit reliably when multiple jobs finish close together.

### fleet-plugin

#### Added
- [fleet-console] The Session Analyst composer grows with the question up to six rows, and the draft survives closing and reopening the panel.
- [fleet-console] Questions can be queued while the analyst is working. Enter stacks a cancellable QUEUED chip; queued questions fire in order when each run completes; Stop or Reset clears the queue.
- [fleet-console] Follow-up suggestion chips appear after every completed answer so analyst capabilities stay discoverable past the first question.
- [fleet-console] Typing / in the composer opens an analysis command palette (/now /drift /brief /risks /timeline); choosing a command fills the composer with its template question.
- [fleet-console] Show a live authoring card in Session Analyst chat while an artifact is being generated, then a published card with Open in Artifacts.
- [fleet-console] The Repository panel's Repositories source gains a discovery bar: search with highlighted matches, Enter to open the first hit, and a scan-depth stepper with the result count.

#### Changed
- [fleet-console] Carrier settings now save on change instead of per-carrier Save/Discard. Removing a Task Force backend still requires a two-step confirm that warns if the Task Force would deactivate.
- [fleet-console] Switching carrier chips no longer discards unsaved edits, because carrier settings hold no draft state.
- [fleet-console] Repository panel selections use a neutral wash, reserving brass for location cues such as the current branch and HEAD badge.
- [fleet-console] Repository panel bands and inputs follow each theme's surface so the panel interior matches the rest of Console.
- [fleet-console] Added and deleted diff rows now read in a single state color; syntax coloring stays on context rows only.
- [fleet-console] Repository History keeps the all-branches graph while sizing each commit row only for lanes active at that point, so older branches no longer widen newer HEAD rows.
- [fleet-console] Selecting a repository or worktree now lands in History, matching branch and tag picks. The bottom scan-depth footer is retired.
- [fleet-console] The agent panel's carrier stream strip becomes a compact live capsule: stacked captain marks, live activity, and the latest output line with elapsed time and token estimate.
- [fleet-console] The expanded stream deck lists a phase card per carrier: identity, live phase such as Reasoning, Using a tool, and Writing, and a one-line preview instead of log rows.
- [fleet-console] The Details Activity tab renders carrier output as streamed markdown with tool status chips that name their target. Thinking stays behind a collapsible fold.

#### Fixed
- [fleet-console] Keep the Session Analyst chat pane free of horizontal scrolling at narrow widths by scrolling wide markdown inside its own block.
- [fleet-console] Delayed System Reminder input no longer submits after a terminal session closes or a write fails.

### fleet-core

#### Changed
- [fleet-admiral] Hosts can split PTY message text from its submit key with an optional delivery delay. Existing callers keep their current behavior.

## [1.31.0] - 2026-07-21

### fleet-console

#### Added
- [fleet-console] Typing > in the command palette switches it to command mode for Console actions such as switch Theater, launch an Operation, open panels, and open Settings.
- [fleet-console] Switch the active Theater and Operation from the command band breadcrumb. Each segment opens a dropdown of Theaters or that Theater's operations, with keyboard navigation.

#### Changed
- [fleet-console] Paint sidebar group identity through a persistent color mark and a faint group-zone wash, stronger when the group is collapsed.
- [fleet-console] Panel transitions share one motion layer: Formation, maximize, and restore glide; minimize fades toward its sidebar chip. All motion honors reduced-motion preferences.

#### Fixed
- [fleet-console] The command band breadcrumb no longer shows an operation from a different Theater after switching Theaters from the sidebar; it now offers a Select operation trigger instead.

### fleet-plugin

#### Added
- [fleet-console] The Repository panel gains a read-only Compare source: pick any two refs and browse their merge-base diff as a changed-file list with per-file hunks.

#### Changed
- [fleet-console] Show the Repositories list as a collapsible directory tree of nested repositories, sorted alphabetically with single-child folders compressed. The Theater root stays pinned on top.
- [fleet-console] Retune the Repository panel palette: history graph lanes and diff syntax highlighting use theme-tuned identity tones, and decorative signal-color accents are removed.

#### Fixed
- [fleet-console] Unify Repository panel borders so edges keep the same weight in the Maritime and Carbon themes, and restore the history tab transition.

### fleet-core

#### Changed
- [fleet-wiki] The host now stages and approves Fleet Wiki entries directly. Wiki mutation, staging, lint, and schema tools are host-only; only read-only tools stay shared with carriers.
- [fleet-carriers] The Chronicle carrier no longer handles Fleet Wiki entries and focuses solely on codebase documentation.
- [fleet-admiral] Require Carrier dispatches to carry settled decisions as literal values.
- [core-unified-agent] Refresh the OpenCode Go and Cursor Agent model catalogs from the live CLIs. OpenCode Go defaults to `opencode-go/deepseek-v4-flash`; Cursor Agent covers 90 models. Superseded generations are retired.

## [1.30.0] - 2026-07-20

### fleet-console

#### Added
- [fleet-console] Companion panels can declare a hidden-by-default slot, and plugins can toggle per-panel visibility. The canvas animates slot changes and honors reduced motion.

#### Fixed
- [fleet-console] Move keyboard focus to the target Operation terminal after command palette navigation, so it accepts typing right away.
- [fleet-console] Activate the selected Operation on the first command palette navigation after a reload, so its panel surfaces and accepts typing.

### fleet-plugin

#### Added
- [fleet-console] Add a Kimi provider default model and effort selection to Settings for Kimi, applied to newly launched Kimi sessions that carry no explicit carrier model.
- [fleet-console] Point the Repository panel at a repository under the Theater from the Repositories list, or at a worktree of the active repository from Worktrees, and keep the selection per Theater.
- [fleet-console] Show the active repository and its branch above the Repository panel, marked while a sub-context is selected.
- [fleet-console] Choose how deep the Repositories list scans, from one to eight levels, and see when a scan limit was reached.

#### Changed
- [fleet-console] Session Analyst now opens with two panes and reveals Artifacts only when the analyst publishes the first artifact.
- [fleet-console] An ARTIFACTS edge chip on the chat pane opens or hides Artifacts, shows the count, pulses on new arrivals while hidden, and stops auto-opening after a manual close until artifacts are cleared.

#### Fixed
- [fleet-console] Remove the Session Analyst session cap while preserving each Analyst until its Operation closes.
- [fleet-console] Keep File Explorer responsive on Linux by watching only opened directories.
- [fleet-console] Restore the Repository panel source navigation background that a missing theme token left transparent.

### fleet-core

#### Added
- [core-agent] [core-infra] [fleet-admiral] [fleet-carriers] Derive the Kimi launch environment from the selected provider default model when no per-carrier model is set.

#### Changed
- [core-unified-agent] Align the Kimi model registry with the official Kimi Code docs: K3 effort levels low/high/max with a high default, the fable tier mapping, and per-model context windows.

#### Fixed
- [fleet-wiki] Fix wiki workspace migration on Windows, where a read-only file could block every wiki tool.
- [fleet-wiki] Normalize wiki_read source and related entry paths to forward slashes on Windows, matching the store index convention.

## [1.29.0] - 2026-07-19

### fleet-console

#### Added
- [fleet-console] Reorder Theaters by dragging their sidebar headers. The manual order is saved on the server.

#### Changed
- [fleet-console] Render Fleet Wiki Cowork assistant replies as compact Markdown with streamed updates, code blocks, and diagrams.
- [fleet-console] Keep Cowork annotation instructions structurally separate from untrusted selected Wiki text.

#### Fixed
- [fleet-console] Restore legibility of minimized sidebar Operation names so they meet readable contrast across all three themes.
- [fleet-console] Keep Session Analyze active while switching Operations and restore the previous Map, Formation, or maximized view on exit.

#### Removed
- [fleet-console] Remove the Context Chip and Theater sub-path context controls from the Command Band and Activity Rail.

### fleet-plugin

#### Changed
- [fleet-console] Session Analyst artifacts now render as full web pages, so SVG, canvas, and inline JavaScript run like a normal browser page.
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
- [fleet-wiki] Let Fleet Wiki Cowork answer direct questions without reading the draft, and use only the tools required by the requested draft task.

## [1.28.0] - 2026-07-19

### fleet-cli

#### Changed
- [fleet-cli] Show Task Force configuration only for source-enabled Carriers.

#### Fixed
- [fleet-cli] Keep Fleet Plan storage bound to the invocation workspace while Carriers run in worktrees.

### fleet-console

#### Added
- [fleet-console] Plans panel updates live: the list, progress bars, and the open plan reader refresh when plan files change.
- [fleet-console] Plans wave and lane chips jump to their section in the plan document. The plan list supports ArrowUp/ArrowDown, Enter, and Escape.
- [fleet-console] Plans list gains search, ALL/IN PROGRESS/COMPLETE status filters, a REFRESH action, and per-plan relative-path copy.
- [fleet-console] Edit Codex wiki entries with AI in the reading view: select text to annotate, send a batch from a floating dock, then review a document diff before applying or discarding the draft.
- [fleet-console] Run Cowork editing through terminal-free one-shot agent runs that accumulate in one draft per entry, then apply once through the wiki patch pipeline with version checks.
- [fleet-console] Add Request and Activity tabs to Stream Deck Details with browser-safe Request Block rendering.
- [fleet-console] Add a companion panel layout: an agent operation can open dedicated side panels next to its terminal. Closing the layout fully restores the Map state.
- [fleet-console] Add Wiki schema catalog browsing to the Codex sidebar.

#### Changed
- [fleet-console] Migrate persisted Diff or History panel selections to the unified repository panel.
- [fleet-console] Refresh Cowork revision feedback with a collapsible streaming activity panel, unified composer controls, and clearer progress and stop states.
- [fleet-console] Move operation identity color from the panel border to a left spine and nameplate mark, reserving borders and glows for status. Previously saved accent and group color keys map automatically.
- [fleet-console] Quiet chrome color: environment and info badges use neutral ink, the stream follow button becomes a brass outline, the minimap loses its always-on glow, and buttons converge on one control grammar.

#### Fixed
- [fleet-console] Keep the in-panel Close button focus ring fully visible.
- [fleet-console] Keep Fleet Plans visible in the active Theater when Agents run from Carrier worktrees.
- [fleet-console] Keep in-panel names visible while editing them.
- [fleet-console] Keep Command Band progressive behavior tied to the viewport when resizing the Activity Rail.

### fleet-plugin

#### Added
- [fleet-console] List local and remote branches, tags, stashes, and worktrees with current markers in the Repository panel.
- [fleet-console] Switch the theater path context by selecting a worktree row in the Repository panel.
- [fleet-console] Preserve Carrier request observations through Terminal Agent snapshots and reloads.
- [fleet-console] Add Session Analyst: an ANALYZE handle opens transcript-grounded analysis chat with Claude, Kimi, Codex, OpenCode, or Cursor, plus streaming progress and sandboxed HTML artifacts.

#### Changed
- [fleet-console] Unify the Diff and History rail panels into one read-only Repository panel with WORKING and REFS source navigation.
- [fleet-console] Pin an uncommitted-changes row atop History and filter history by validated branch or tag refs with a clearable chip.
- [fleet-console] Limit Console Task Force settings to Nimitz, Vanguard, and Tempest, and reject unsupported updates.
- [fleet-console] Conform repository, skills, and terminal carrier surfaces to the neutral badge and unified control grammar.
- [fleet-console] Group Terminal plugin settings into a new General section holding Metaphor, Terminal Font, and Terminal Renderer, and rename the Kimi sign-in card to Settings for Kimi below Agent CLI Available.

#### Fixed
- [fleet-console] Bind Terminal Agent Plan storage to its server-resolved Theater without exposing filesystem paths to the browser.
- [fleet-console] Keep Session Analyst chat pinned to the latest streamed message and activity update.

### fleet-core

#### Added
- [fleet-wiki] Add a cowork engine for terminal-free AI draft editing, consumed by Fleet Console.
- [fleet-carriers] Emit structured request observations without changing executor input or model usage.
- [fleet-analyst] Add the fleet-analyst package: a session analysis runtime with transcript indexing, credential redaction, bounded MCP analysis tools, and a multi-turn analyst session.
- [fleet-wiki] Add schema list, read, and create-only template MCP tools.
- [fleet-admiral] Assign schema lookup to Chronicle and template creation to Admiral.

#### Changed
- [fleet-carriers] Enforce an explicit Carrier capability for Task Force configuration, status, and launch.
- [fleet-admiral] Adjudicate Codex review feedback against frozen product context and roll back review-driven scope drift before merge.

#### Fixed
- [core-agent] Carry immutable server-only bindings through dedicated and one-shot MCP sessions.
- [fleet-plans] Require hosts to bind Plan storage explicitly instead of deriving it from the execution directory.
- [fleet-admiral] Auto-name Claude Console panels from the first prompt before provider summaries refresh them.
- [fleet-analyst] Reject missing or unexpected publish_artifact parameters, require non-empty html, and clarify the HTML and contrast contract.

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
- [fleet-console] Auto-hide the command band in fullscreen, with edge, keyboard, pin, and reduced-motion controls.
- [fleet-console] Show a Local channel chip in the Command Band on development-channel consoles, with an Environment popover for version, port, data root, and runtime lock paths. Production channels render no indicator.
- [fleet-console] Desktop shells add a derived Desktop data path row to the Environment popover. macOS Desktop abbreviates the chip label to Local to fit beside the window controls.

#### Changed
- [fleet-console] Move Carrier Settings from the System Menu standalone page into Settings > Plugins > Terminal > Carriers. Keep `/carrier-settings` as a one-release redirect, and support `?section=` deep links in Settings.
- [fleet-console] Show complete Operations and Groups for inactive Theaters while preserving Group collapse state.
- [fleet-console] Move the operations panel session identity onto a hull nameplate that rides the panel border, keeps the name visible on active panels, and tucks window controls behind hover or keyboard focus.
- [fleet-console] Name Operations from provider session identity metadata while preserving Console user rename precedence.
- [fleet-console] Read Console Plans from the Theater root workspace in the shared Fleet data directory instead of repository-local `.fleet/plans` directories.
- [fleet-console] Provide theater-wide Codex knowledge per project, with copy-only on-demand migration from legacy `.fleet/knowledge`.

#### Fixed
- [fleet-console] Keep Alt+Left and Alt+Right navigation within non-minimized panels.
- [fleet-console] Preserve the underlying Map or Formation state when focusing, restoring, or minimizing a panel.

### fleet-desktop

#### Added
- [fleet-console] Connect to a remote runtime over SSH: Desktop installs and runs Fleet Console on the remote machine and connects through an SSH tunnel, supporting Linux and macOS hosts.
- [fleet-console] Show remote connection progress on the bootstrap screen, return to the local runtime from a menu action, and report connection failures in a dialog.
- [fleet-console] Relay native window fullscreen state so Console chrome follows Desktop fullscreen.
- [fleet-console] Keep a signature tray icon in the macOS menu bar, and show the Desktop window when it is clicked.

#### Fixed
- [fleet-console] Stop parenting the update dialog to a destroyed window after the Desktop window is closed while the app stays alive.

### fleet-plugin

#### Added
- [fleet-console] Host the Carriers settings section in the Terminal plugin as a captain chip strip with a single detail card, including the runtime editor, Task Force editing, and draft save and discard.
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
- [fleet-admiral] [fleet-carriers] Slim the always-injected Admiral system prompt further. Dispatch composition rules move into the on-demand carrier-operations skill, renamed from carrier-contracts.
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
- [fleet-console] Add a Grid / Columns / Rows layout selector to Formation view. Columns splits panels into full-height vertical columns for ultrawide monitors, and the choice is remembered per machine.

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
- [fleet-console] After Desktop completes its normal Console startup, connect to a running local Fleet Console from the macOS app menu or Windows and Linux tray.

### fleet-plugin

#### Changed
- [fleet-console] Improve File Explorer responsiveness when listing large directories.

#### Fixed
- [fleet-console] Restore macOS Terminal PTY startup when the terminal helper is installed without execute permissions.
- [fleet-console] Submit terminal carrier-result reminders to Codex reliably on Windows ConPTY.

### fleet-core

#### Removed
- [fleet-admiral] Remove Cursor launch injection and plugin rendering from Fleet Admiral while retaining the Cursor backend for Carriers.

## [1.25.0] - 2026-07-12

### fleet-console

#### Added
- [fleet-console] Add `Mod+B` and `Mod+Alt+B` shortcuts to toggle the left sidebar and right Activity Rail.
- [fleet-console] Add a minimize button to left sidebar operation chips so a panel can be minimized from the sidebar. It is hidden on already-minimized chips and on inactive-Theater preview chips.
- [fleet-console] Show inactive Operation names beside their panel status beacons with inline rename controls.

#### Changed
- [fleet-console] Split the sidebar Formation view toggle into a two-segment control, giving open-panel and include-minimized formation each their own button.
- [fleet-console] Organize What's New into Overview and product tabs while preserving legacy and mixed release updates.
- [fleet-console] Formation view's open-panel segment now leaves minimized and maximize-docked panels in the dock, arranging only currently open panels. The include-minimized segment still restores every panel first.
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
- [fleet-console] Rework the Diff History commit view into a Segmented Commit Inspector with a Details tab and a Changes tab of per-file diffs.
- [fleet-console] Keep the commit subject legible at the default History rail width, keep the branch graph as the left master, and add resize dividers between the graph, inspector, and file panes.
- [fleet-console] Default new Codex Agent CLI settings to App Server while preserving explicit ACP selections.

#### Fixed
- [fleet-console] Align Diff History commit graph nodes with their commit rows.
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
- [fleet-console] Add a Plans activity rail panel that lists the active Theater's execution plans with wave/task progress and parallel-lane dispatch readiness, and opens them in an in-panel markdown reader.
- [fleet-console] Add a temporary Formation view for supervising visible Operations.
- [fleet-console] Add a shared Activity Rail path context for selecting a Theater root, worktree, or directory.
- [fleet-console] Unify window chrome into a Command Band: sidebar and Activity Rail toggles, Operation search, and the Formation view toggle now live at fixed window positions that never move when panels collapse.
- [fleet-console] Animate sidebar and Activity Rail collapse and expand with a width transition that is fully disabled under reduced motion.
- [fleet-console] Retire the floating edge expand tabs and the sidebar header button row. Add Theater moves to a full-width row at the top of the sidebar.
- [fleet-console] Move the Fleet brand mark into the Command Band as the Operations home button and widen the macOS traffic light inset.
- [fleet-console] Reinterpret the band center as a breadcrumb of the active Theater, the active panel name with double-click rename, and the panel CLI shown as an icon and text tag.
- [fleet-console] Minimize the panel hover controls to the status mark plus minimize, maximize, and close.
- [fleet-console] Surface the Activity Rail path context chip in the Command Band as a second synchronized surface.
- [fleet-console] Replace the sidebar brand foot with System Menu and Help drop-ups, move Keyboard Shortcuts into a Help modal, and remove it from the canvas context menu.
- [fleet-console] Keep the Command Band on the Settings and Carriers routes with brand and search only, and retire their back-to-Operations links.
- [fleet-console] Add English and Korean What's New release notes with a server-persisted language preference.

#### Changed
- [fleet-console] Redesign Fleet Console with the Instrument visual system and full-height progressive navigation.
- [fleet-console] Split Formation shortcuts for open panels and restoring minimized panels.
- [fleet-console] Operation panels drop the separate title bar. At rest they show a status mark; hover reveals name, CLI badge, and window controls that also drag the panel.
- [fleet-console] Replace the sidebar Canvas controls button with a Formation view toggle and swap the search and collapse buttons.

#### Fixed
- [fleet-console] Restore the Theme section in General settings with Instrument (default), Maritime, and Carbon themes.
- [fleet-console] Command Band background now follows each theme's chrome palette, fixing overly dark center and right segments in Maritime and Carbon.
- [fleet-console] Restore user-selected accent perimeters on Map Operation panels and side ticks on Operations SideBar chips.
- [fleet-console] Activity Rail resize drag now tracks the cursor 1:1 instead of easing behind it.
- [fleet-console] Require confirmation before closing a Map session panel.
- [fleet-console] Clean stale plugin bundles at startup and current-run bundles at shutdown without disturbing active Console processes.

#### Removed
- [fleet-console] Remove the English fallback badge from localized What's New release notes.

### fleet-desktop

#### Added
- [fleet-console] Introduce Fleet Console Desktop 0.1.0, an optional native home for the full Fleet Console experience.
- [fleet-console] Set up and maintain the managed Console runtime automatically, including first-run installation, launch-time updates, offline fallback, and safe recovery from interrupted installs.
- [fleet-console] Provide native desktop lifecycle controls with single-instance window restore, platform title-bar integration, tray and menu actions, update prompts, and clear startup conflict guidance.
- [fleet-console] Keep the desktop shell lightweight by downloading Console code only when needed, while preserving Fleet Console data independently from the removable managed runtime.

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
- [fleet-carriers] [fleet-admiral] A single Kirov plan can declare safe parallel Ohio lanes. Ohio accepts an execution_scope for one Parallel lane and keeps full sequential execution for Sequential plans.

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
- [core-unified-agent] Codex system prompts and config overrides are now applied on new ACP sessions across all platforms; previously they were silently dropped.
- [fleet-console] Update Available badge now appears in open tabs without a page refresh when a new console release is detected.

## [1.22.1] - 2026-07-10

### Added
- [core-unified-agent] Switch Codex ACP to the official bridge, add GPT-5.6 Codex model support with updated reasoning effort levels, and preserve deprecated ACP model type aliases for migration.

## [1.22.0] - 2026-07-08

### Changed
- [fleet-console] Codex wiki documents now render flat on reading surfaces: the card around the document body is removed while the document header is preserved.
- [fleet-console] Replace the console's primary navigation with a bottom command status bar, Theater tree, and right-rail route controls.

### Removed
- [fleet-console] Remove the copy-context action buttons (Compact context, Provenance, Context pack, Why this matched) from the bottom of Codex wiki entries.

## [1.21.0] - 2026-07-06

### Changed
- [fleet-admiral] [fleet-carriers] Slim the always-injected Admiral system prompt. Per-carrier request-block contracts move to an on-demand carrier-contracts skill loaded before the first dispatch of a session.
- [fleet-admiral] Unify Downward Guard triggers into the Protocol Gate, compress Context Confidence and Result Integrity Standing Orders without changing their rules, and move the cross-carrier feedback table into the frontline protocol skill.
- [fleet-admiral] The Protocol Gate now declares skill loading idempotent per session, so already-loaded skill content is applied without reloading.
- [fleet-carriers] Dispatch requests rejected for missing required request blocks now echo the target carrier's full request-block contract in the error, allowing recomposition without a prior contract lookup.

## [1.20.0] - 2026-07-06

### Added
- [fleet-admiral] Add the Command Integrity Standing Order: the Admiral pushes back on flawed orders, clarifies ambiguous requirements, refuses assumed permissions, and arbitrates conflicts by safety, correctness, clarity, then efficiency.
- [fleet-admiral] The Admiral system prompt now instructs recursive AGENTS.md doctrine loading for every touched directory across all protocol modes, with the deepest applicable file taking precedence.
- [fleet-console] Add drag-to-reorder for Operation groups by dragging group headers in the Operations sidebar.

## [1.19.0] - 2026-07-05

### Added
- [fleet-admiral][fleet-cli][fleet-console] Cursor Agent can now be launched as a first-class Agent CLI runtime with rules-delivered Fleet doctrine, MCP, and session-capture support.
- [fleet-console] Diff panel shows a collapsible History section under Changes. Selecting a commit renders its full patch, with a Flat/Graph toggle for HEAD-reachable history.
- [fleet-console] Add bundled Nerd Font symbol fallback support for terminal glyph rendering.
- [fleet-console] Add a Theater-independent Global Shell panel in the right rail.

### Changed
- [core-process][core-agent][core-unified-agent] Windows executable path resolution and child-process console-window suppression now come from a shared internal core-process package.
- [core-unified-agent] Rename the Claude and Codex provider display names to Claude Code and Codex.
- [core-infra] Rename the Fleet infrastructure package to reflect its domain-agnostic role. All consumers are updated with no behavior change.
- [fleet-admiral] [fleet-carriers] Data directory resolution is now self-contained, so carrier storage and marketplace assets always resolve to the single Fleet home directory no matter which host launches them.
- [fleet-console] [fleet-cli] Remove host-side data directory injection, fixing duplicate marketplace rendering and carrier settings that previously failed to persist when changed from the console.
- [fleet-console] Remove the raw data directory path from the plugin host contract so plugins no longer receive it.
- [fleet-console] Terminal launch menus and SideBar chips now show distinct official-style brand icons for Claude and Codex agent sessions.
- [fleet-console] Terminal launch menus and SideBar chips now show the official-style Cursor brand icon for Cursor agent sessions.

### Fixed
- [fleet-console] Restore README images and file links in File Explorer markdown previews.
- [fleet-console] Terminal Shell sessions now preserve raw TUI cursor movement so nvim-style fullscreen apps repaint reliably.
- [fleet-console] Diff and File Explorer rail panels now keep the right-hand list or tree column at a fixed width when opening a file or diff, assigning extra width to the left document pane.
- [fleet-console] Narrow or aggressively resized rail panes hide secondary labels and badges instead of clipping content.
- [fleet-console] File Explorer expands the rail panel only while a file preview is open, returning to a single-column tree when the viewer is closed.

### Removed
- [fleet-cli][fleet-console] Remove the System Prompt Injection option (`FLEET_REPLACE_SYSTEM_PROMPT` and the Append/Replace toggle). Fleet doctrine is now always layered on Claude Code (Append) and always delivered to Codex through its profile developer instructions.

## [1.18.0] - 2026-07-04

### Added
- [core-unified-agent] OpenCode Go model selection now includes GLM-5.2 and Kimi K2.7 Code.

### Changed
- [fleet-carriers] Carriers now wrap their final output in a `<report>` block. `carrier_jobs(format:"full")` returns only that block, falling back to the full archive when absent, and `format:"raw"` returns the unprocessed archive.
- [fleet-carriers] Remove redundant echo fields from `carrier_jobs` responses and derived fields from the workspace-changes DTO to reduce response payload size.
- [fleet-console] Carrier streaming in the Agent panel is now a collapsible bottom dock with live output, elapsed time, and a token estimate. Details opens the full stream.
- [fleet-admiral][fleet-cli] Codex launches now use a fixed Fleet-managed profile with hooks enabled instead of session-scoped profiles or hook trust bypassing.
- [core-unified-agent] Cursor Agent model selection now includes Kimi K2.7 Code and GLM 5.2 while removing older Sonnet and Opus 4.7 options.
- [fleet-console] Selecting a file in the Diff panel now extends the panel into a two-pane view with an inline diff document.
- [fleet-console] Diff panel file rows now lead with the file name, and the repository picker opens as an opaque in-panel deck with inline worktree rows.
- [fleet-console] Diff panel repository dropdown now groups linked worktrees under their parent repository with a collapsible disclosure.
- [fleet-admiral] The Artifact Inspection Gate now requires evidence before an Admiral classifies a carrier-diff deviation as harmless.
- [fleet-console] Repeated alerts from the same Operation panel now replace the previous alert instead of accumulating a count. ALERTS badges show the number of panels with an active alert.
- [fleet-console] Skills panel shows update and install progress in a collapsible status dock at the bottom of the panel. The dock auto-dismisses on success and keeps a Retry action on failure.
- [fleet-console] Compact the Agent panel carrier stream dock into a single-row signal strip that expands to one compact row per track, with captain-colored names on multi-carrier tracks.

### Fixed
- [fleet-admiral][fleet-cli] Fleet Codex profile rewrites now preserve persisted hook trust state for unchanged hooks.
- [fleet-console] Restore the drag-to-resize divider between the diff document pane and the changed-files list in the Diff panel.
- [fleet-console] Session rename names now stick: user-set names are never overwritten by auto-name, and renames appear in the browser in real time without a page refresh.

### Removed
- [core-unified-agent][fleet-infra][fleet-admiral][fleet-cli][fleet-console] Remove Claude Kimi, Claude GLM, and Claude ZAI alias providers from catalogs, launch, and sign-in. OpenCode Go remains.
- [fleet-carriers] [fleet-admiral] [fleet-cli] [fleet-console] Remove Native Subagent mode. Carriers always run in CLI dispatch. carrier_dispatch and Task Force are unchanged.

## [1.17.1] - 2026-07-03

### Fixed
- [fleet-console] Terminal text on the Operations canvas stays sharp after pan, zoom, or maximize.

## [1.17.0] - 2026-07-02

### Added
- [fleet-console] Console plugins can now save their settings on the server so they survive browser changes and restarts.
- [fleet-console] Terminal font name and size now persist across browsers and restarts, with existing preferences migrated on first load.
- [fleet-console] File Explorer now refreshes on demand, on folder expand, and when files change on disk.
- [fleet-console] Add a Skills plugin on the Activity Rail to search skills.sh, install with live progress, and update, remove, or read SKILL.md.

### Changed
- [fleet-console] The Diff panel can now target any nested Git repository under the Theater. Pick one from the toolbar, with branch and scan depth.
- [fleet-console] The Diff panel now shows staged and unstaged changes in one Changes list.

### Fixed
- [fleet-console] The Diff panel repository picker now opens when clicked.
- [fleet-console] The Diff panel no longer auto-selects a nested repository when the Theater root is not Git. Pick one from the toolbar.
- [core-unified-agent] [fleet-carriers] Failed carrier jobs now include redacted Codex error output. Successful jobs still omit it.
- [fleet-console] Hide unsupported Claude Kimi and Claude GLM launch aliases from Operation Controls.
- [fleet-console] YAML frontmatter in Markdown (such as SKILL.md) now renders as a labeled metadata card instead of one oversized heading.
- [fleet-console] The Skills SKILL.md reader now opens at a usable height with a scrollable body.

## [1.16.1] - 2026-07-02

### Fixed
- [fleet-console] Restore Codex Drydock patch review: pending patches list, open in the Codex reader, and approve or reject with a reason.
- [fleet-console] Disable unsupported Claude Kimi and Claude GLM launch options in Operation Controls.
- [fleet-console] Korean IME input now keeps composed text together when Shift+Enter inserts a newline in terminal panels.

## [1.16.0] - 2026-06-30

### Added
- [fleet-console] Add a collapsible, resizable Activity Rail on the right for workspace tools beside the Operations map. It remembers the active tool, width, and open state.
- [fleet-console] Add a File Explorer for the active Theater, with a preview beside the tree for code, markdown, images, and binary files.
- [fleet-console] Add a Diff tool for the active Theater's changed files, switchable between working-tree and staged.
- [fleet-console] Fleet Console now loads third-party plugins from `~/.fleet/plugins` into Operation panels and Settings.
- [fleet-console] Plugins declare an `apiVersion`. An incompatible or failing plugin is skipped without breaking the console.
- [fleet-console] External plugins share the console React and SDK runtime and run their server routes in the console process.
- [fleet-console] Rename an Operation from the left Operations SideBar by double-clicking its name.
- [fleet-console] Operations SideBar now supports named groups: create, rename, recolor, dissolve, drag chips between groups, and collapse members. A colored rail marks membership.
- [fleet-console] Add a sidebar map setting to turn Operation panel pulse on or off without hiding the running-state signal.
- [fleet-console] Right-click empty space in the left Operations SideBar to open the New Operation launcher at the cursor.

### Changed
- [fleet-console] Set an Operation's accent color from its status indicator on the panel or sidebar. The dedicated accent button is gone.
- [fleet-console] An Operation's accent color now outlines its canvas panel and sidebar entry in every state, including minimized.
- [fleet-console] Carrier output now streams as a summary banner in the Agent panel. Click it for details instead of a separate child panel.
- [fleet-console] Codex moves into the right rail as a built-in panel. The full /console/codex route, edge handle, and view-mode toggle are removed.
- [fleet-console] Codex no longer changes browser history or reads the URL. Workspace selection follows the active Theater.
- [fleet-console] Codex no longer offers admin workspace registration or bearer-token access. Theater registration and restart restoration remain the mount paths.
- [fleet-console] Remove the standalone fleet-wiki CLI. Codex is entered only from the Theater-scoped right-rail panel.
- [fleet-console] Redesign the Codex panel for the right rail: a single-column navigator, a split reader, and Expand for a wide centered view with a table of contents.
- [fleet-console] Codex now serves search, entry, drydock, and conflicts. Retired endpoints return 404.
- [fleet-console] Replace the bottom Operations taskbar with a collapsible left sidebar of Operation chips. Click to focus, drag or Alt+Shift+Up/Down to reorder, and use "+ New" to create.
- [fleet-console] The Activity Rail and File Explorer and Diff splits now follow the pointer while resizing.
- [fleet-console] Radar sweep and panel pulse now default to off in local unpublished (`pnpm`) builds. Published builds stay on; a per-browser toggle always wins.
- [fleet-console] The Diff panel now shows a clear English message when the folder is not a Git repository or Git is missing.
- [fleet-console] All File Explorer panel text is now in English.
- [fleet-console] Console backend routes now live under `/api/v1`, with settings at `/api/v1/settings/*` and updates at `/api/v1/updates/*`.
- [fleet-console] Carrier settings now accept partial updates at `PATCH /api/v1/settings/carriers/:id`.
- [fleet-console] Console theme and port in Settings General are now stored on the server, shared across browsers, and survive restarts.
- [fleet-console] Settings now separates console controls from plugin controls. Agent CLI holds system prompt, model sign-in, and CLI availability.
- [fleet-console] Merge Appearance into General (Theme and Console Port). Remove Appearance from the Settings rail.
- [fleet-console] Move Terminal Font and Terminal Renderer settings into the Terminal plugin's Agent CLI section. All terminals update immediately.
- [fleet-console] Fleet Console self-update now applies immediately even while a terminal session is open.
- [fleet-console] Diff and File Explorer now use plugin routes (`/plugins/diff/*`, `/plugins/file-explorer/files/*`) instead of core console routes.
- [fleet-console] The Diff panel now shows staged and unstaged changes as two collapsible sections, includes untracked files, and adds a List / Tree toggle.
- [fleet-console] The Diff panel file tree and hunk views are now split by a draggable divider. The ratio persists per browser.
- [fleet-console] Codex reading and plugin markdown previews now share one renderer.
- [fleet-console] File Explorer `.md` previews now use the same markdown engine and styles as Codex, including Mermaid.
- [fleet-console] File Explorer now stays a two-pane split (preview left, tree right), and keeps preview and split position when switching Theaters.
- [fleet-console] File Explorer now uses colorful file-type icons and open/closed folder icons, with accent colors for well-known folders. The palette follows Maritime or Carbon.
- [fleet-console] Remove the unused live Operation state. Carrier streaming now shows as running.
- [fleet-console] Awaiting is now aurora (teal) and idle is green. Idle panels no longer animate their perimeter.
- [fleet-console] After an agent turn ends, an Operation stays running while a carrier job is still streaming, then goes idle.
- [fleet-console] An Operation raises an alert when it becomes idle or awaiting.
- [fleet-console] Terminal session titles no longer append `#N`, so sessions in the same Theater can share a name.
- [fleet-console] Theaters and terminal sessions from an earlier console version are now migrated on upgrade instead of reset.
- [fleet-console] Remove the parent/child Operation tree. Every Operation is top-level, with no command tether.
- [fleet-console] Console state is now a single `operations` collection. Existing `state.json` files reset on first boot, and registered Theaters and Operations are forgotten.
- [fleet-console] The plugin SDK API version is bumped, so plugins built against the previous SDK are rejected as incompatible instead of failing at runtime.
- [fleet-console] Operation groups in the left sidebar now use a continuous colored rail and tinted header so a group reads as one run.
- [fleet-console] Theater folder selection now lives in the console. Terminal plugin sessions for Shell and Agent run on their own.
- [fleet-console] Reset the external plugin API compatibility version to 1. Built-in plugins now declare apiVersion 1.
- [fleet-console] Reset the console durable state schema version to 2.

### Fixed
- [fleet-console] Agent panels now go awaiting for every input-waiting prompt, including AskUserQuestion. Idle prompts no longer block.
- [fleet-console] ALERTS now shows Awaiting and Complete for every Operation except the one you are viewing, even when the Operations canvas is open.
- [fleet-console] Opening an ALERTS item or quick-search result while maximized now switches the maximized panel instead of collapsing it.
- [fleet-console] Creating an Operation while maximized now keeps maximized view on the new panel.
- [fleet-console] Fix globally installed Fleet Console failing to start after npm install due to a missing React module. The published package is self-contained again.
- [fleet-console] Alt+Left/Right now cycles Operations in sidebar order, including drag reordering.
- [fleet-console] The Operations canvas now follows the active theme, so Carbon is a neutral dark canvas. Maritime is unchanged.
- [fleet-console] Radar sweep now animates whenever it is enabled, without requiring Panel pulse.
- [fleet-console] Double-clicking an Operation name in the left sidebar now reliably opens rename.

### Removed
- [fleet-cli] Remove the Mission Control Wiki Server panel and the `fleet wiki` subcommand. The standalone fleet-wiki binary is decommissioned.
- [fleet-cli] Keep the bundled `fleet-wiki` package for wiki tool specs and entry count used by MCP and the Mission Control status line.

## [1.15.0] - 2026-06-26

### Added
- [fleet-console][fleet-infra] Add a Settings -> General control to pin a static console port, with fallback and feedback when it is unavailable.

### Changed
- [fleet-console] An in-progress Operation no longer animates the running-light ring on both panel and dock chip. The ring follows the visible surface; the chip keeps its progress glow.

## [1.14.0] - 2026-06-26

### Added
- [fleet-console] Add per-browser terminal font family and size controls that apply live to all open terminals.

### Fixed
- [fleet-console] Preserve maximized Operation panel state independently across Theaters.

## [1.13.0] - 2026-06-25

### Added
- [fleet-console] Add a favicon so the console has a distinct browser tab and bookmark icon.
- [fleet-console] Reorder dock taskbar panels by dragging a chip or with Alt+Shift+Arrow. The order persists per Theater.
- [fleet-console] Mark a dock panel with a custom accent color from a 16-color palette. System status stays intact, and the choice persists per Theater.

### Changed
- [fleet-console] Dock taskbar close now needs a second click to prevent accidental panel removal.

### Fixed
- [fleet-admiral] Codex CLI launch no longer fails on Codex 0.142.0 and later.

## [1.12.0] - 2026-06-23

### Added
- [fleet-console] The Theater directory browser can now reach other drives and jump to an absolute path, so projects outside the home drive can be registered.

### Fixed
- [fleet-console] Adding an Operation or shell while maximized now keeps maximized view on the new panel.

## [1.11.0] - 2026-06-23

### Changed
- [fleet-console] The Operations dock taskbar now shows every open panel, highlights the focused chip, and clicking a chip brings it forward without leaving maximized mode.
- [fleet-console] Widen the Operations dock taskbar up to the radar minimap so the chip pager appears later.
- [fleet-console] Add a "+" launcher at the bottom-left of the Operations canvas that opens the new-panel menu, including while maximized.
- [fleet-console] Move the Alerts toggle and panel to the right edge, above the Codex side handle.
- [fleet-console] Hide floating canvas controls while a panel is maximized, and highlight the maximized panel's maximize button.
- [fleet-console] Rework Operations canvas panels into an OS-style window system with a persistent taskbar, maximize, Shell parity, and stable cycling.

## [1.10.2] - 2026-06-21

### Changed
- [fleet-console] Clicking the already-active Carriers or Settings nav button now returns to the Operations canvas.
- [fleet-console] What's new now loads all release notes at runtime from the main changelog.
- [fleet-console] The What's new version selector now shows ten releases per page with previous/next pagination.

## [1.10.1] - 2026-06-21

### Fixed
- [fleet-console] All backend API catalog descriptions in Settings are now in English.

## [1.10.0] - 2026-06-21

### Added
- [fleet-console] Settings now lists the console HTTP API in a collapsible card. New routes appear automatically.
- [fleet-console] The collapsed Alerts dock now pulses once when a new alert arrives, in amber for awaiting and emerald for completed, without expanding.
- [fleet-console] Canvas-mode operations now raise Alerts even when their panel is visible.
- [fleet-carriers] carrier_dispatch now accepts an optional absolute `cwd` so a delegated carrier can start in a chosen working directory.

### Changed
- [fleet-console] The root path `/` and unknown paths now redirect to `/operations`.
- [fleet-console] The console version is now shown beneath the top-bar "Research Preview" label.
- [fleet-console] The commissioning guide now auto-appears only on the first visit.
- [fleet-console] The Alerts dock now collapses on outside click, Escape, and when navigating to a different Operation.
- [fleet-console] Settings is now a two-pane layout with Model Sign-in under Agent CLI and the Backend API section expanded by default.
- [fleet-console] Backend API catalog descriptions in Settings are now in English.

### Removed
- [fleet-console] Remove the Welcome dashboard. Operations is now the sole entry surface.
- [fleet-console] Remove Operation and Codex from the global navigation bar. Codex is reached only from the right-edge handle.
- [fleet-console] Remove the Research Preview indicator dot from the top bar.
- [fleet-console] Remove Helm (classic) Operations mode and the Map/Helm toggle. Operations is now the Map canvas only.
- [fleet-console] Remove the Operations left sidebars (classic session list and Map floating session list).
- [fleet-console] Remove the global navigation Shell button, overlay, and local-shell shortcut. The in-canvas shell panel remains.

## [1.9.0] - 2026-06-20

### Added
- [fleet-console] Add Model Sign-in in Settings to register, verify, and remove a provider API key, starting with Moonshot Kimi. Keys are stored locally and never shown back.
- [fleet-console] A global npm install of Fleet Console now opens the browser when it finishes. Set `FLEET_CONSOLE_NO_AUTO_OPEN` to opt out.
- [core-unified-agent][fleet-admiral][fleet-infra][fleet-cli] Add Claude GLM (ZhipuAI GLM) as a selectable Claude-family provider in the CLI and Console, including `fleet auth` login/logout.
- [fleet-console] Settings Model Sign-in now lists ZhipuAI GLM beside Moonshot Kimi.
- [fleet-console] Settings now shows whether each Agent CLI is installed and its detected version.
- [fleet-console] The Codex Side panel can be opened from a right-edge handle on any non-Codex view.
- [fleet-console] The Codex Side panel header can collapse its left (Nav) and right (ToC/Manifest) panes.
- [fleet-console] In Side view, the Codex Cmd+K search palette is scoped to the Side panel instead of the full screen.
- [fleet-console] The Codex Wiki reader now uses a single reading measure, drops the empty rail on browse/index, and folds raw source into the same shell.
- [fleet-console] The Codex Wiki reading rail lists the table of contents first with active-section highlighting, a contents drawer on narrow viewports, and breadcrumbs.
- [fleet-console] Console self-update now applies a global `fleet-cli` + `fleet-console` update from the top-bar button instead of opening an npm registry link.
- [fleet-console] Self-update blocks while a terminal Operation has a live session, rejects local/unpublished builds, then restarts on a new loopback port and opens a new browser window.
- [fleet-cli] CLI updates now use the shared package updater, with the same CLI shutdown and messaging as before.
- [core-agent] Add a shared global package updater for package-manager detection, install location checks, version resolution, install, and a manual fallback.
- [fleet-console] Fleet Console now shows a What's new popup of the installed version's changelog, once after update, and again from the navigation bar.
- [fleet-console] Add a GitHub repository link and live star count beside the Research Preview badge.
- [fleet-console] Operations Map panels can now be minimized to a bottom dock and restored by double-click. Busy entries pulse.
- [fleet-console] Operations are now named from the first meaningful line of the first prompt. A manual rename is never overwritten; clearing the name re-enables auto-naming.

### Changed
- [fleet-console] Fleet Console no longer raises a completion toast while a carrier job is still running.
- [fleet-console] Replace running Operation attention motion with a consistent perimeter signal on open panels and minimized dock controls.
- [fleet-console] Minimized Operation labels now match open panel title type.
- [fleet-console] The minimized-panel dock now expands upward from a centered bottom handle and pages overflow, so existing entries no longer shift when the count changes.
- [fleet-console] A busy minimized-panel entry now uses a running light around its outline instead of a breathing pulse. The dock handle animates only while collapsed.
- [fleet-console] A minimized operation now restores with a single click on its dock chip. The per-chip restore button is removed.
- [fleet-console] Completion and input-waiting alerts now group by Theater in a left-docked panel, showing only Operations that are not currently visible.
- [fleet-console] Alerts distinguish completion and input-waiting per Operation, count repeated waits, and add global mute, do-not-disturb, and per-Theater mute.
- [fleet-console] Cluster alerts clear when an Operation resumes, and disappear when its session or Theater is deleted.
- [fleet-console] Operation launch menus now disable an Agent CLI that is not installed or not signed in, with a reason, and the server rejects those session-creation requests.
- [fleet-console] Theme and terminal renderer controls move from the navigation bar into a new Appearance section at the top of Settings.

### Fixed
- [fleet-console] A Fleet Console run from source (`pnpm fleet-console`) now stores Theaters, Operations, and captures under the project workspace instead of the shared home directory.
- [fleet-console] Operation auto-naming now updates only from the first submitted prompt unless the name is cleared.
- [fleet-console] A carrier-dispatch idle pause no longer raises a false "Awaiting orders" notification while the dispatched job is still running.
- [fleet-console] The Operations sidebar collapse state in Map view now persists when navigating to Codex full mode and back.
- [fleet-console] Operations Map panel positions and sizes now persist across a browser refresh.
- [fleet-console] Map shell panels now survive a browser refresh instead of disappearing.
- [fleet-console] Opening or restoring a terminal no longer corrupts the display of other open Operations terminals.
- [fleet-console] Clicks and drag selections in an Operations Map terminal now land on the correct cell after zooming the map.

### Removed
- [fleet-console] Fleet Console no longer raises a toast when a carrier sorties. The live Operation panel already shows the job.
- [fleet-admiral] Fleet no longer loads user-global (`~/.fleet`) or project-local (`.fleet`) skills, agents, and hooks into Agent CLI sessions. Only the built-in Fleet plugin is activated.
- [fleet-admiral] Deprecated user-global and project plugin registrations and leftover marketplace directories are pruned from Codex and the Fleet marketplace on launch.
- [fleet-infra] [fleet-cli] [fleet-console] Remove automatic migration from `~/.fleet/agent/auth.json`. Fleet now reads only `~/.fleet/auth.json`. Re-add credentials with `fleet auth login`.

## [1.8.0] - 2026-06-18

### Added
- [fleet-console] First-time operators now get a commissioning walkthrough for registering a Theater, opening an Operation, and observing carriers. It can be reopened from Welcome.
- [fleet-console] Add a global Settings screen to choose system prompt Append or Replace and toggle the naval metaphor tone, matching Fleet CLI. Changes apply to new sessions.
- [fleet-console] Raise a persistent top-centre toast when a background Claude Operation pauses for input, with a jump control. The Operation in view is suppressed.
- [fleet-console] Codex (Fleet Wiki) can now open as a resizable side panel beside the current view. A navigation-bar toggle switches Full and Side and is remembered.

### Changed
- [fleet-console] Operations Map fullscreen no longer exits on Esc. Use the maximize/restore control.
- [fleet-console] The global navigation bar now separates Settings from per-carrier configuration, renaming the carrier entry to "Carriers".

### Removed
- [fleet-console] Remove the Operations Map panel focus button and the title-bar double-click that zoomed a panel to fit.

### Fixed
- [fleet-console] A Theater's Codex (Fleet Wiki) view now stays available after a console restart.

## [1.7.1] - 2026-06-17

Release v1.7.1

## [1.7.0] - 2026-06-17

### Added
- [fleet-console] The Operations Map now zooms smoothly with the wheel, while panning stays immediate.
- [fleet-console] The Operations Map can open plain user-shell terminal panels in the active Theater. They are not tracked as Operations and are not kept across reloads.
- [fleet-console] Add a right-click canvas menu to start a new Operation, open a shell, or reset the view at the cursor.
- [fleet-console] Double-click an empty area of a panel title bar to focus it, in addition to the focus button.
- [fleet-console] Double-click a panel name on the Operations Map to rename it, using the same flow as the Operations list.
- [fleet-console] Add a bottom-right minimap of all panels and the viewport, draggable to navigate, and collapsible to a button.
- [fleet-console] Add Alt+Left / Alt+Right to focus the previous / next Operation in the active Theater, in Map and Helm.
- [fleet-console] Add a collapsible bottom-left shortcut reference that collapses to a "?" button.
- [fleet-console] Add a maximize control that hides the navigation bar and collapses the Operations sidebar. Exit with the control or Esc. Remembered per browser.
- [fleet-console] Operation indicators now show grey before the first turn, amber while processing, green when the turn ends, and the live colour while a carrier job runs.
- [fleet-console] Raise a top-centre toast when a background Operation reports a carrier sortie or stands down, with a Go control. It dismisses after ten seconds or on close.

### Changed
- [fleet-console] Theater and workspace folder picking now uses an in-console directory browser, so it also works from remote and headless browser sessions.
- [fleet-console] The Operations radar sweep now uses less CPU and pauses while the browser tab is hidden.
- [fleet-console] The Operations Map now shows each panel's in-progress carrier stream below the panel instead of above it.
- [fleet-console] Collapsing the Operations Map sidebar now hides the whole panel, leaving only an expand control on the left edge.

### Fixed
- [fleet-console] The global navigation bar no longer overlaps the Theater selector at narrow widths. The toolbar collapses labels to icons and wraps as needed.
- [fleet-console] Forgetting a Theater now always succeeds and removes it from the list, even if its directory is already gone.

## [1.6.0] - 2026-06-16

### Added
- [fleet-console] Add a carrier settings page to edit each carrier's CLI, model, SubAgent mode, Task Force backends, and display name, saved per carrier.
- [fleet-console] Fleet Console Operations now opens as a freeform terminal canvas for live operation sessions.
- [fleet-console] The Operations canvas now has a dark deep-sea backdrop with a radar sweep that can be toggled and is remembered per browser.
- [fleet-console] Add a Map/Helm view toggle between the free-placement canvas and the classic single-terminal layout, remembered per browser.
- [fleet-console] The Operations Map now floats each panel's in-progress carrier stream above its terminal, with live previews that open the full stream.
- [core-unified-agent] Add Claude Opus 4.7 [1M] and Opus 4.8 [1M] to the Claude provider model list.
- [fleet-console] Add Cmd/Ctrl+K Operation search across Theaters. It switches Theater, zooms the Map to the panel, and focuses the terminal. On /codex, Codex search keeps the shortcut.
- [fleet-console] The global navigation bar now has a keyboard-shortcuts button listing console, Operations, and Codex shortcuts.
- [fleet-console] Renaming an Operation now sends `/rename <name>` to that session's Agent CLI.
- [fleet-console] Persist Fleet Console theaters and operations across restarts, and resume dormant Agent CLI sessions when opened.

### Changed
- [fleet-admiral] Agent CLI sessions now append the Admiral system prompt by default instead of replacing it. fleet-cli can still switch to replace mode.
- [fleet-console] A source (pnpm/dev) Console now stores runtime data under the project's `.fleet/console` instead of the OS temp directory. `FLEET_CONSOLE_DIR` still overrides; published builds are unchanged.

## [1.5.5] - 2026-06-15

### Added
- [fleet-console] The Operations sidebar now lets you choose Claude, Claude Kimi, or Codex when starting a new terminal session.
- [fleet-console] Terminal sessions now deliver carrier job completion reminders to the originating Agent CLI, matching fleet-cli.
- [fleet-console] Operations can now expand a terminal to full width, hiding the sidebar, and overlay in-progress carrier jobs as one-line rows. Each Operation remembers the expanded state.

### Changed
- [fleet-console] Terminal sessions now launch Agent CLIs through the shared Admiral runtime instead of a fleet-cli wrapper.

### Removed
- [fleet-cli][fleet-console][core-agent] Remove the `fleet --headless` flag and the Console fleet-cli registration channel. Observation is now only through console-owned terminal sessions.
- [core-agent] Remove the shared CLI registration contracts from the public API.

## [1.5.4] - 2026-06-14

### Fixed
- [fleet-console] The local shell overlay now keeps its running shell, scrollback, and working directory when closed and reopened.

## [1.5.3] - 2026-06-14

### Added
- [fleet-console][core-agent] Show an "Update available" badge in the global navigation bar when a newer console release is on npm.

### Changed
- [fleet-console] The local shell overlay now uses most of the console width so it no longer looks narrow on wide displays.

## [1.5.2] - 2026-06-14

### Fixed
- [fleet-console] The job overlay no longer clips on the right. Long tool-call labels now ellipsize inside the card.
- [fleet-console] Fix Fleet Console terminal sessions failing to start on Windows from an npm-installed stable package.
- [fleet-cli][fleet-console] `fleet update` now stops a running Fleet Console before reinstalling, so the update no longer fails on Windows when files are locked.

## [1.5.1] - 2026-06-14

### Removed
- [fleet-admiral] The redline and frontline protocol modes no longer include a working-branch isolation check before they start.

### Fixed
- [fleet-console] Fleet Console now reports its actual installed package version instead of a placeholder development version.
- [fleet-console] Fleet Console no longer ends a terminal session when its browser view disconnects. Sessions persist across operation switches and console-web close.

## [1.5.0] - 2026-06-14

### Added
- [fleet-console] Fleet Console now organizes Admiral sessions and Codex wiki context by Theater, a project root from the top bar. Operations lists only Admirals for the active Theater.
- [fleet-console] Fleet Console ships as its own runtime: workspace and job rails, live carrier streaming with reasoning folds and tool-call activity, job summaries, and a raw event timeline.
- [fleet-console] Fleet Console now opens on a Theater readiness Bridge, with carrier streaming on a dedicated Operations route from top-bar navigation.
- [fleet-console] Fleet Console now shows a Carrier Readiness Matrix.
- [fleet-console] The Fleet Console CLI gains `start`, `stop`, `restart`, and `status`. `fleet console` relays every subcommand to the standalone binary.
- [fleet-console] Add a free local shell overlay with Cmd/Ctrl+` or a top-bar action, running the operator's login shell.
- [fleet-console] Fleet Console now owns the Codex/Fleet Wiki web surface. `fleet wiki` and `fleet-wiki` compatibility go through the console package.
- [fleet-cli] Add `fleet --native` to run the Agent CLI directly in the terminal, passing input to the child CLI and injecting a reminder when carrier work completes.
- [fleet-cli][fleet-console] Add `fleet --headless` so a session can register with a running Fleet Console for live observation.
- [fleet-console] Fleet now runs Fleet Console as the local control surface, removes the global gateway daemon, and returns MCP to per-CLI in-process servers.
- [core-agent] Add shared CLI registration contracts and in-process MCP server primitives for Fleet runtimes.
- [fleet-console] The Operations sidebar now has a close control on each operation card that ends the session and removes it from the rail.

### Changed
- [core-unified-agent] Claude Code with Moonshot Kimi now runs Kimi K2.7 as the default, slot-mapped, and subagent model.
- [fleet-console] The Fleet Console server now binds a random loopback port. `fleet-console start` reopens a healthy running daemon in the browser instead of starting a second server.
- [fleet-console] Fleet Console adopts the maritime visual identity, replacing its previous carbon-and-lime look.
- [fleet-console] Observability events now keep carrier output text in memory so the console can render live streams. Exposure stays loopback-only.
- [fleet-console] Only fleet-cli sessions started with `--headless` register with the console. Standard and `--native` runs no longer appear as console workspaces.
- [fleet-console] The Admirals sidebar now lists console-owned terminal sessions and their carrier job history. Selecting a job opens a streaming overlay over that session's terminal.
- [fleet-console] Fleet Console now ends a terminal session and removes it from the Admirals rail when its process exits, instead of respawning on reconnect.
- [fleet-console] The Admirals rail now lists in-progress carrier jobs above finished ones, with a green mark on completed jobs and carrier name plus status instead of a timestamp.
- [fleet-console] Replace the top-bar connection chip with a red console sigil and a toast only when the console link drops. Both clear on reconnect.
- [core-agent] Generic MCP registry, routing, and tool snapshot primitives move from `@dotobokuri/core-mcp-server` to `@dotobokuri/core-agent`.
- [fleet-admiral] Rename Admiral protocol-mode skills to `protocol-baseline`, `protocol-midline`, `protocol-redline`, and `protocol-frontline`, and the gap-audit skill to `assumption-audit`.
- [fleet-console] The native folder picker now opens the modern Windows Explorer-style folder dialog on Windows and WSL, and under WSL it starts in the Linux filesystem.
- [fleet-console] Browser payloads no longer expose raw working-directory paths. Observer Theater and workspace rows carry display labels only.
- [fleet-console] The Operations launch (+) control now matches the Theater selector styling.

### Removed
- [fleet-console] Remove the standalone `fleet-wiki-ui` runtime package. Fleet Wiki browsing is now served by Fleet Console.
- [fleet-wiki][fleet-console] Remove the Korean/English language toggle from the Codex/Fleet Wiki web surface. The interface is now English-only.
- [fleet-console] Remove the browser token gate from Fleet Console. Local loopback access no longer requires observer or terminal tokens. CLI ingest authentication remains.
- [fleet-cli] Remove the raw-CLI Native launch mode. Dedicated CLIs now always launch with the Fleet persona injected.
- [fleet-cli] Remove Fleet global shortcuts (Ctrl+C, Ctrl+Q, Ctrl+T) and the MIRROR/DEDICATED input mode toggle. Exit is now through the launcher Exit action or child CLI termination.
- [core-agent] Remove the `@dotobokuri/core-mcp-server` package. Import generic MCP APIs from `@dotobokuri/core-agent` instead.

### Breaking Changes
- [core-agent] The `@dotobokuri/core-mcp-server` package is no longer published. Migrate imports to `@dotobokuri/core-agent`.

### Fixed
- [fleet-cli] Claude Code on Windows now shows the cursor and accepts Korean/CJK IME input. Pass `--disable-cursor-sync` or set `FLEET_CURSOR_SYNC=0` to opt out.
- [fleet-console] Fleet Console now preserves active CLI sessions across local server health refreshes until an explicit restart.
- [fleet-wiki][fleet-console] Stop Fleet Wiki web from opening automatically in the browser when agent CLI sessions start.
- [fleet-console] The native folder picker now works under WSL by opening the Windows folder dialog and translating the chosen path to Linux.

## [1.4.0] - 2026-06-10

### Added
- [fleet-admiral] Protocol-mode skills now declare checkpoint boundaries and use a two-report cadence.
- [fleet-admiral] A protocol sync check now guards protocol mode drift, duplicated Downward Guard wording, and report-token grammar.
- [fleet-admiral] Admiral now requires artifact inspection before accepting mutating carrier job results.
- [fleet-carriers] Carrier job results now include best-effort workspace change manifests for inspection.
- [fleet-wiki] Wiki entry writes now strip duplicate leading frontmatter. `wiki_drydock` can detect this and optionally `fix` it.

### Changed
- [fleet-admiral] Admiral prompt policy now treats live carrier tool descriptions as the authority for carrier request mechanics.
- [fleet-carriers] Carrier rosters now show the optional prior-jobs context hint once instead of under every carrier.
- [fleet-admiral] Context Confidence planning thresholds now scale by protocol mode. Standard work requires sufficient confidence.
- [core-agent][core-unified-agent][fleet-infra][fleet-admiral][fleet-carriers][fleet-wiki][fleet-console][fleet-cli] Consolidate duplicated helpers and resolve internal import cycles across workspace packages, with no behavior change.
- [fleet-cli][fleet-console][fleet-wiki] Realign the root structure map, developer references, and bilingual READMEs with the current workspace layout and public APIs.
- [core-unified-agent] Mark the package private to prevent accidental publication to npm.

### Fixed
- [fleet-console] The global `fleet-wiki` command now relaunches the repository-local build inside a monorepo checkout or git worktree.
- [fleet-console] Web client request-failure messages now follow the selected interface language instead of always appearing in Korean.
- [fleet-console] The wiki daemon health endpoint now reports the real package version.
- [core-unified-agent] System prompts containing control characters are now fully escaped when written into the Codex TOML profile.

### Removed
- [fleet-carriers] Remove dead code and unused public APIs across workspace packages. CLI, MCP, carrier, and stored-configuration contracts are unchanged.

## [1.3.1] - 2026-06-07

### Fixed
- [fleet-cli][fleet-console] Fix the globally installed `fleet` command failing to launch with a module-not-found error.

## [1.3.0] - 2026-06-07

### Added
- [fleet-admiral] Fleet sessions now include a Context Confidence path for resolving decision-shaped planning gaps before planning proceeds.
- [core-agent] Dedicated Agent CLI sessions now load a project-local Fleet plugin from `.fleet/`, activating its hooks, skills, agents, and MCP servers beside the built-in plugin.
- [core-agent] Dedicated Agent CLI sessions now load a user-global Fleet plugin from `~/.fleet/` across every project.
- [core-agent] Project-local and user-global Fleet plugins now expose skills, agents, hooks, and `.mcp.json` as symlinks, so changes apply without slowing session launch. Broken links are skipped.
- [fleet-admiral] Dedicated Agent CLI sessions now ship built-in protocol-mode skills. The Admiral prompt selects modes through a protocol gate.
- [fleet-admiral] Each protocol-mode skill now opens with a readiness checklist of that mode's prerequisites before the workflow begins.
- [fleet-admiral] Each protocol-mode skill now reports plan, readiness checks, briefing, then execution start.

### Changed
- [fleet-cli] Project-local Fleet plugins now render as symlinks under `CWD/.fleet/plugin/` instead of a nested `marketplace/` copy.
- [fleet-cli] `fleet update` now prints situation-specific guidance: nothing to update for local dev builds, already latest, or distinct messages before manual fallback.
- [fleet-cli] Extract generic agent execution into core-agent and rename unified-agent and MCP server workspaces to core packages.
- [fleet-wiki] Dedicated Agent CLI sessions now use a single Fleet MCP server named fleet, preserving carrier and wiki tool IDs.
- [fleet-wiki] Dedicated Agent CLI launches now activate Fleet through a generated marketplace directory. Carrier and wiki MCP servers stay injected at session launch.
- [fleet-cli] Fleet system prompt injection for dedicated Agent CLI sessions now happens at CLI launch through temporary prompt files and a Codex profile, not session plugin hooks.
- [fleet-admiral] Claude-family dedicated sessions now inject live native-subagent guidance through a Fleet SessionStart hook, not the static Admiral system prompt.
- [fleet-carriers] Job Bar carrier names and Task Force backend rows now show the actual model and effort used for each dispatch.
- [fleet-cli] The Fleet Codex plugin now activates only in Fleet-launched Codex sessions and stays disabled in global Codex configuration, so ordinary Codex sessions are unaffected.
- [fleet-cli] The per-session Codex profile now stores the Fleet system prompt as a multi-line TOML string, making the profile human-readable.

### Fixed
- [fleet-cli][fleet-console] Fix Windows `fleet update` only printing manual install instructions instead of running the automatic global npm or pnpm update.

### Removed
- [fleet-admiral] Admiral system prompts no longer inline per-tool guide blocks. Tool-specific guidance remains in Fleet MCP tool metadata.
- [fleet-cli] Remove Codex role-file generation and direct prompt and inline agent injection from dedicated Agent CLI sessions.
- [fleet-wiki] Remove the fleet-usage skill from the Fleet plugin bundle, which now ships only wiki-usage.

### Fixed
- [fleet-carriers][core-unified-agent] Codex carrier child processes now exit when Fleet CLI exits on POSIX, including terminal-close and fatal-error exits, so they no longer linger.
- [fleet-cli] Claude-family dedicated sessions on Windows no longer fail to launch with a SessionStart hook module-loading error.
- [fleet-cli] Codex dedicated sessions on Windows now register and activate the Fleet plugin instead of silently skipping activation.

## [1.2.0] - 2026-06-03

### Added
- [fleet-cli] Job Bar backend rows now show per-backend elapsed execution time.

### Changed
- [fleet-cli] Mission Control now uses a flat LAUNCH/OPTION/SYSTEM root with automatic global option persistence.
- [fleet-cli] Mission Control now ignores legacy `presets.json`. Operators may delete stale preset files after the global options rollout.
- [fleet-cli] Mission Control menus and information rows now share one alignment, with key:value rows colon-aligned within each group.
- [fleet-cli] Job Bar token estimates now count up smoothly instead of jumping to the final value.
- [fleet-carriers] Job Bar carrier tiles no longer show a per-backend progress indicator. Activity is the job-level status icon only.
- [fleet-cli] The Job Bar active-job indicator now blinks a filled dot instead of alternating filled and empty dots.

### Breaking Changes
- [fleet-cli] Fleet preset storage and the preset public API were removed in favor of global options.

## [1.1.3] - 2026-06-03

Release v1.1.3

## [1.1.2] - 2026-06-03

### Added
- [core-unified-agent] Cursor Agent now supports the Claude Opus 4.8 (thinking) model.
- [fleet-cli] Job Bar job rows now show elapsed time to the left of the token estimate, as seconds under one minute and minutes plus seconds beyond.

### Changed
- [fleet-carriers] Native(SubAgent) mode carriers can now use carrier_dispatch as well as their native CLI path, still exclusive with Task Force.
- [fleet-carriers] Native(SubAgent) Carrier Roster and Job Bar rows now use their CLI signature color instead of a dedicated SA color, keeping the [SA] badge.
- [fleet-cli] Job Bar token estimates now include tool result output size as well as streamed text and tool labels.

### Removed
- [fleet-carriers] Remove the per-carrier `[N:M]` badge from Job Bar tiles. Live activity is still the breathing icon; `[TF:N]` and `[SA]` remain.

### Fixed
- [fleet-carriers] Carrier Roster and other Mission Control panels now keep the focused item visible when the terminal is shortened.

## [1.1.1] - 2026-06-02

### Changed
- [fleet-cli] Mission Control now uses launcher-root and action-list navigation with no domain hotkeys.
- [fleet-cli] The Fleet gradient banner now shimmers right-to-left on inactive screens.
- [fleet-cli] Inactive Mission Control UI is vertically centered when content is short. Active Agent CLI output stays top-aligned.
- [fleet-cli] Mission Control panels now share a consistent visual treatment with accent markers and selected-row highlighting.
- [fleet-cli] Conditional actions are omitted from menus when unavailable instead of shown as disabled rows.
- [fleet-infra][fleet-carriers][fleet-cli] Preset, auth, and carriers storage now share one durable file store in `fleet-infra` (atomic writes, directory locks, and filesystem guards).
- [fleet-cli] Auth storage is now protected with atomic writes, a directory lock, and 0600 file permissions, matching preset storage.
- [fleet-cli] Auth is now created through `createAuthService({ authPath })`. The module singleton and `setAuthPath` are removed.
- [fleet-cli] Auth commands now receive a shared `AuthService` instead of creating one per call.
- [fleet-cli] `fs-store` now requires a `sensitivity` field so sensitive files are not created as 0644.
- [fleet-carriers] `carriers.json` write mode is explicitly 0644 to match its non-sensitive status.

### Fixed
- [fleet-cli] Fix the host TUI leaving stale characters and rows when the terminal is resized or split.

### Removed
- [fleet-infra] Remove the `@dotobokuri/fleet-infra/log` public path, the runtime log store, and the Mission Control log viewer.

## [1.1.0] - 2026-06-01

### Added
- [fleet-carriers] The job-bar strip now shows an `[SA]` badge for carriers in Native(SubAgent) mode.
- [fleet-cli] Restore the `claude-kimi` dedicated Agent CLI profile for Claude-family native subagent sessions.
- [fleet-carriers] Add per-carrier Native(SubAgent) toggles for Claude-family dedicated CLI sessions.
- [fleet-carriers] Add per-carrier Claude Native(SubAgent) effort defaults to startup agent payloads.
- [fleet-carriers] carrier_dispatch now rejects carriers in native subagent mode and tells the host AI to invoke the carrier via its CLI native subagent path.
- [fleet-carriers] Codex dedicated CLI hosts now support Native(SubAgent) mode, running a toggled carrier as a native Codex subagent with its own model and effort.

### Changed
- [fleet-carriers] TaskForce carrier job-bar labels, tiles, and header now render in TaskForce blue, keeping per-backend row colors.
- [fleet-carriers] Enabling Native(SubAgent) and committing a TaskForce config are now mutually exclusive, with a warning if one would overwrite the other.
- [fleet-carriers] Carrier Status is now reached from Mission Control's `C` shortcut as Carrier Roster.
- [fleet-carriers] Default carrier persona settings now live in each persona module. Registration order is unchanged.
- [fleet-cli] Claude-family Agent CLI native subagents injected at startup now default to `background: true`.

### Fixed
- [fleet-cli] Enable Agent CLI app-mouse drag forwarding while keeping existing Fleet scroll fallback.

### Removed
- [fleet-carriers] Remove the `Alt+O` host shortcut for opening carrier configuration.
- [fleet-carriers] Remove unused default persona registry exports and carrier config renderer hooks.
- [fleet-cli] Remove the `claude-zai` dedicated Agent CLI profile from the upper-pane selection. Auth and provider backend remain supported.
- [fleet-infra] Remove the unused `@dotobokuri/fleet-infra/settings` package path and leftover settings.json persistence.

## [1.0.2] - 2026-05-26

### Added
- [core-unified-agent] Add Cursor Composer 2.5 and Composer 2.5 Fast models.

### Changed
- [fleet-cli][fleet-console] Consolidate the release pipeline onto `main`: version bump, CHANGELOG promotion, npm publish, and GitHub Release in one workflow.
- [fleet-cli][fleet-console] Mission Control welcome now labels published builds `stable` and unpublished working copies `local`.
- [fleet-console] Align `fleet wiki --help` with the Fleet-branded English help style and the `fleet wiki` command spelling.

### Removed
- [fleet-cli][fleet-console] Remove the `canary` npm dist-tag and the auto-publish workflow on every push to `canary`. The `canary` branch remains the PR integration target but no longer publishes.
- [fleet-cli][fleet-console] Remove the manual release workflow that targeted the `canary` branch.
- [fleet-cli][fleet-console] Remove the `canary` runtime channel from Fleet CLI release type, update channel, welcome label, and prerelease detection.

## [1.0.1] - 2026-05-25

### Fixed
- [fleet-cli] Fix global install of `@dotobokuri/fleet-cli` failing at startup with `ERR_MODULE_NOT_FOUND: @xterm/headless`.

### Changed
- [fleet-cli] Document `@dotobokuri/fleet-cli` as a global-only CLI in the README with `npm`, `pnpm`, and `yarn` install commands, and add `preferGlobal` to `package.json`.

## [1.0.0] - 2026-05-25

Release v1.0.0

## [0.22.2] - 2026-05-25

### Added
- [core-agent] Add Mission Control for starting or relaunching the upper Agent CLI after exit.
- [core-agent] Add native Mission Control Fleet Menu panels for authentication, wiki server control, diagnostics, and about.
- [fleet-cli] Add persistent Fleet CLI startup presets with Mission Control option editing and save/reset.
- [fleet-cli] Add double-tap Ctrl+C confirmation before exiting the fleet CLI.
- [fleet-cli][fleet-console] Mission Control now checks npm for the latest version on the user's channel and shows an update-available notice on the welcome screen.
- [fleet-cli][fleet-console] Add `fleet update` to upgrade global `fleet-cli` and `fleet-wiki-ui` together, or print the install command when the install scope cannot be confirmed.

### Changed
- [core-agent] Carrier Status now opens as a Mission Control panel while keeping active Agent CLI input pass-through.
- [fleet-cli] The Mission Control idle screen now shows a Fleet-branded welcome with banner, carrier/wiki/queue readout, and a `local`, `canary`, or `stable` version line.
- [fleet-cli] Rename CLI launch/profile terminology to Agent CLI, including the `agent-cli` path and `FLEET_AGENT_CLI` selector.
- [fleet-admiral] The HUD label is now a compile-time constant tied to the single Fleet Action Protocol. Protocol switching is removed.
- [core-agent] fleet CLI now rejects unknown subcommands and options with an error on stderr and exits with status 1.
- [fleet-admiral] Extract Admiral prompt and Fleet tool policy into `@dotobokuri/fleet-admiral`. The fleet CLI now depends on it.
- [core-agent] Add `createExecutorSessionManager(deps)` and `Executor*` session types. The former `createDedicatedMcpSession` helper moves to the generic MCP server package.
- [fleet-carriers] Reorganize `fleet-carriers` internals into `personas/`, `store/`, `dispatch/`, `stream/`, and `jobs/`.
- [fleet-cli] Unify the Mission Control welcome banner with the `fleet --help` ASCII banner so both share one Fleet wordmark.
- [fleet-wiki][fleet-console] The Wiki Server panel now reuses a healthy background daemon, opens the browser on Enter, stops the daemon with `S`, and matches the `fleet wiki` default port.

### Fixed
- [core-agent] Fix executor pool isolation for busy sessions, stale pooled clients, and MCP tool signature drift.
- [fleet-wiki][fleet-console] Fix the Wiki Server panel failing silently when a previous daemon held the lock, mis-reporting running daemons as stopped, and swallowing permission errors on shutdown.

### Removed
- [fleet-carriers] Remove unused carrier runtime, TUI primitive, and agent model helper APIs.
- [core-agent] Remove carrier session persistence. Session reuse is now in-memory executor pool state only.
- [fleet-cli] Remove the top-level `-rsp` / `--replace-system-prompt` flag. Toggle it from Mission Control options, `FLEET_REPLACE_SYSTEM_PROMPT`, or a saved preset.
- [fleet-cli] Remove the top-level `-n` / `--native` and `-em` / `--enable-metaphor` flags. Toggle them from Mission Control options, `FLEET_NATIVE` / `FLEET_ENABLE_METAPHOR`, or a saved preset.

### Breaking Changes
- [core-agent] Remove `@dotobokuri/fleet-tui/input` and `@dotobokuri/fleet-tui/pty`. Use `@dotobokuri/fleet-tui/components` and `@dotobokuri/fleet-tui/layout` instead.
- [core-agent] Remove the in-tree Grand Fleet policy modules. This code was already unreferenced by the fleet CLI runtime.

## [0.22.1] - 2026-05-24

Release v0.22.1

## [0.22.0] - 2026-05-24

Release v0.22.0

## [0.22.1] - 2026-05-24

Release v0.22.1

## [0.22.0] - 2026-05-24

### Added
- [fleet-infra] Add `@dotobokuri/fleet-infra` as the host-agnostic package for auth, data-dir, job, log, and settings services.
- [fleet-carriers] Add a per-carrier builtin external MCP allowlist. Tempest now exposes the grep.app code search MCP.
- [core-agent] Add auth login, list, and logout commands with migrated auth storage and Claude-family alternate backend support.
- [core-agent] Add `--model` to forward a model name to the selected dedicated CLI, and reorganize `--help` into Fleet Agent and underlying CLI option groups.
- [fleet-console] The command palette can now be toggled with Cmd+K (or Ctrl+K).
- [fleet-console] The command palette now locks page scroll while open and restores it on close.
- [fleet-console] Keyboard focus is now trapped in the command palette while open, and restored on close.
- [fleet-console] Hovering a search result now synchronizes the active selection.
- [fleet-console] Search matches in result titles are now visually highlighted.
- [fleet-console] Search results now display body match excerpts with markers stripped.
- [fleet-console] Command palette results are now grouped under section headers for recent and matched entries.

### Changed
- [fleet-console] Inline mermaid diagrams now scale to fit as a miniature overview. The lightbox still pans and zooms at full size.
- [fleet-console] Remove raw relevance scores from command palette search results.
- [fleet-carriers] Split Fleet internal MCP access into independent `fleet-carriers` and `fleet-wiki` servers with isolated tokens.
- [fleet-carriers] carrier_jobs full responses for auto-promoted Task Force jobs now return per-backend results keyed by CLI type.
- [fleet-carriers] Finish moving carrier runtime, dispatch, jobs, store, and Task Force to `@dotobokuri/fleet-carriers`.

### Fixed
- [core-agent] Anchor CJK IME preedit to the dedicated CLI input cursor, and add `--disable-cursor-sync` for terminals that need to opt out.

### Breaking Changes
- [core-agent][core-unified-agent][fleet-infra][fleet-admiral][fleet-carriers][fleet-wiki][fleet-console][fleet-cli] Remove the standalone Fleet Admiral and Fleet Admiralty workspace packages. Fleet Agent then owned the integrated policy modules.
- [fleet-infra] Remove obsolete root infrastructure re-exports. Import infrastructure APIs from `@dotobokuri/fleet-infra`.
- [fleet-carriers] Remove the carrier_taskforce tool. carrier_dispatch now auto-promotes carriers with configured Task Force to multi-backend execution.
- [fleet-carriers][core-agent] Remove the sortie toggle: individual carriers can no longer be taken offline, including the 'd' key in the carrier status overlay.
- [core-agent] Fleet-world tone overlay is now disabled by default. `--disable-metaphor` is replaced by `--enable-metaphor`.
- [core-unified-agent] Remove Gemini CLI provider support. Users and API consumers must migrate to other supported CLI backends.

## [0.21.0] - 2026-05-20

### Added
- [core-agent] Add `--replace-system-prompt` (`-rsp`) to override instead of append the system prompt when launching the Claude dedicated CLI.
- [fleet-cli] Add Fleet Wiki tools to dedicated CLI MCP sessions.
- [fleet-admiral][fleet-cli] Dedicated CLI launches now inject Fleet Admiral prompts, Fleet MCP access, and native permission bypass flags for Claude and Codex.
- [fleet-wiki] Add `wiki_patch_edit` for approval-gated in-place edits to pending wiki patches.
- [fleet-cli] Absorb Job Bar into fleet-agent, including a dynamic job status section and an active-only frame ticker.
- [fleet-wiki] Wiki approve now guards against stale bases using content hash and version checks.
- [fleet-wiki] Automatically accumulate and deduplicate `rawSourceRefs` so provenance is preserved across entry updates.
- [fleet-wiki] Enforce POSIX target validation and `realpath`-based approval locks to prevent path traversal and symlink alias attacks.
- [fleet-wiki] Improve `wiki_compile_source` update provenance and related entry tracking for batch operations.
- [fleet-wiki] Wiki tool prompts, schemas, and guidelines are now in English.

### Fixed
- [fleet-carriers] Concurrent dispatches from the same carrier no longer collapse into one Job Bar line.
- [fleet-wiki] Patch hash now covers the entire `patch.md`, so `summary` frontmatter changes show in `changed_fields`, `patch_hash`, and `base_patch_hash`.
- [fleet-wiki] Concurrent `wiki_patch_edit`, `approve`, and `reject` on the same patch no longer race.
- [fleet-wiki] Stale-base detection now uses `lastEditHash` as the written patch hash, so interleaved edits are detected consistently.
- [fleet-console] Large Mermaid diagrams are no longer clipped by the document container width.
- [fleet-cli] Opening an agent session that never receives a prompt no longer writes a session file, so the session selector no longer fills with "(no messages)" entries.
- [fleet-cli] Session commits now ignore stale updates from other sessions.
- [core-agent] Agent sessions now handle fatal tool-call errors in order so a failed call cannot stall the rest of the queue.
- [fleet-cli] Grand Fleet now re-registers with Admiralty when the bound session changes or the client reconnects after a dropped socket.
- [fleet-cli] Fix type-checking in status overlay tests.
- [core-agent] `runtime.shutdown()` now disconnects the executor pool so sessions do not leak.

### Changed
- [core-agent] The carrier strip stays visible. Job Bar detail now auto-shows only when at least one carrier job is active.
- [fleet-carriers] Redesign the expanded Job Bar into a carrier header with independent dispatch sub-lines.
- [fleet-carriers] Allow parallel `carrier_dispatch` on the same carrier. Concurrent requests are no longer rejected as "carrier busy".
- [fleet-carriers] Deprecate the `squadronEnabled` key in `fleet-store`. The field is now ignored at runtime.
- [fleet-console] Fleet Wiki Web now runs as a single per-user daemon that can open multiple registered workspaces with workspace-scoped URLs.
- [fleet-console] The `fleet-wiki` CLI is now worktree-aware and runs the worktree-local distribution when inside a git worktree.
- [fleet-console] Move the Table of Contents to a sticky rail card. It hides when empty and hoists above content on mobile.
- [fleet-console] Click a Mermaid diagram to open a lightbox with zoom (25-400%), drag-to-pan, mouse wheel and keyboard shortcuts, and auto-fit on open.
- [fleet-cli] Prompt templates are now invoked with `/prompt:{name}`, matching `/skill:{name}`.
- [fleet-admiral][core-agent] Extract Fleet MCP server internals into `@dotobokuri/core-mcp-server` with 1MiB body caps and 5m timeouts. See `MIGRATION.md`.
- [core-agent] Session and executor engines now validate origin tokens during state changes so updates cannot apply to the wrong session.
- [fleet-cli] Grand Fleet registration now guards in-flight session identifiers instead of using synthetic IDs.
- [fleet-cli] Grand Fleet registration now tracks an explicit status field.

### Removed
- [fleet-cli] Remove unused legacy panel hint constants.
- [fleet-cli] Remove the unused `visibleRunIdByCli` payload from status sources and the `_streams` parameter from status updates.
- [fleet-carriers] Remove squadron UI: the `[SQ]` badge, `->SQ` filtering, `S` toggle special handling, and Sortie-Squadron mutual exclusion.
- [fleet-cli] Remove Gemini and Cursor Agent from dedicated CLI support.
- [fleet-cli] Remove the 'metaphor' domain (worldview, operation naming, directive refinement) and the 'request_directive' tool.
- [fleet-console] Remove the Constellation (backlinks) panel and Outgoing references, along with the backlink indexer.
- [core-agent] Remove service status UI and refresh logic.

## [0.20.0] - 2026-05-16

### Added
- [fleet-carriers] Add `@dotobokuri/fleet-carriers` as the default carrier persona catalog and self-registration package.
- [fleet-carriers] Add carrier metadata-based executor MCP tool scoping, while keeping tool-centric registration.
- [core-unified-agent] Add 1M-context models to the Cursor catalog, with combined effort and reasoning parameters.

### Changed
- [fleet-carriers] Allow parallel `carrier_dispatch` on the same carrier. Concurrent requests are no longer rejected as "carrier busy".
- [fleet-carriers] Deprecate the `squadronEnabled` key in `fleet-store`. The field is now ignored at runtime.
- [fleet-carriers] Carrier prior-job access now requires explicit persona `carrier_jobs` and `<prior_jobs?>` declarations. `CarrierMetadata.commonRequestBlocks` is removed.
- [fleet-carriers] Move `PRIOR_JOBS_REQUEST_BLOCK` from fleet-admiral into fleet-carriers.
- [fleet-wiki] Five read-only wiki tools (`wiki_briefing`, `wiki_orient`, `wiki_query`, `wiki_read`, `wiki_resolve`) are now registered globally, so all carriers get the wiki by default.
- [fleet-cli] Enforce `canary` as the only allowed PR base. Non-canary PRs, including from forks, are auto-closed with guidance.
- [fleet-cli] Auto fast-forward `canary` to match `main` after each push to `main`.
- [fleet-cli] Remove the `fleet-dev` binary. Use `pnpm dev` for CWD-routed development launches.
- [fleet-wiki] Wiki tool rendering now matches carrier tools, with a transparent TUI background.

### Fixed
- [fleet-wiki] Carrier executor MCP tool whitelist no longer depends on wiki module load order, so fleet-admiral no longer throws when fleet-wiki is not imported.
- [fleet-cli] Fix missing frontmatter on the pr-creates skill that prevented it from loading.

### Removed
- [fleet-carriers] Remove squadron UI: the `[SQ]` badge, `->SQ` filtering, `S` toggle special handling, and Sortie-Squadron mutual exclusion.
- [fleet-cli] Remove the `/scoped-models` slash command and related keybindings (`Ctrl+S`, `Ctrl+A`, `Ctrl+X`, `Alt+Up/Down`) for customizing model cycling scope.

## [0.19.0] - 2026-05-13

Release v0.19.0

## [0.18.5] - 2026-05-12

### Fixed
- [fleet-console] Remove the unused `canvas` dependency so `pnpm install` no longer fails on platforms without prebuilt binaries (for example Windows arm64 + Node 25).

## [0.18.4] - 2026-05-12

### Fixed
- [core-unified-agent] Codex legacy app-server exits are now classified as graceful, intentional, or abnormal, so false turn-completion crashes are suppressed.

## [0.18.3] - 2026-05-12

Release v0.18.3

## [0.18.2] - 2026-05-12

### Added
- [core-unified-agent] Add dual-transport support for Codex with `CODEX_USE_ACP`, enabling the npx bridge (`codex-acp`) and legacy app-server connections.

### Changed
- [fleet-carriers] Allow parallel `carrier_dispatch` on the same carrier. Concurrent requests are no longer rejected as "carrier busy".
- [fleet-carriers] Deprecate the `squadronEnabled` key in `fleet-store`. The field is now ignored at runtime.
- [core-unified-agent] Default Codex transport reverts to the legacy app-server path pending a Windows fix for the ACP npx bridge.
