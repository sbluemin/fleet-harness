# Mission Control

Upper interaction layer that hosts the Agent CLI PTY in the Fleet TUI upper pane and serves as the Fleet product's main screen while idle.

Mission Control owns the launch menu for selecting an Agent CLI, startup option editing, the active PTY session lifecycle, and a panel host API that temporarily yields the upper pane to interactive panels (e.g., Carrier Status) while they are active. The idle launcher renders a borderless Fleet-branded welcome (gradient banner, amber accent, centered carrier/wiki/queue readout, version with stable/local channel label, option chips, and a centered shortcut hint) so the upper pane feels native to the TUI rather than framed as a dialog.

## Architecture

- **`createMissionControlController(options)`** — Factory that returns a `MissionControlController` with a `component` (implements `MissionControlPtyView`), a `ptyHost`, and panel host methods.
- **Panel Host API** — `openPanel(panel)`, `closePanel()`, and `hasActivePanel()`. When a panel is active, all operator input is routed to the panel component; when closed, input falls through to the underlying Agent CLI PTY or Mission Control control UI.
- **`writeChildInput(data)`** — Programmatic input path that writes directly to the active child PTY, bypassing panel routing. Used by system reminders (e.g., carrier result notifications) that must reach the child process regardless of panel state.
- **Input Routing Order** — `ptyHost.write(data)` checks `activePanel` first; if a panel is open, data is sent to `panel.component.handleInput`. Otherwise, data goes to the active child PTY (`active.host.write`) or Mission Control control input (`handleControlInput`).
- **Options Drawer** — `o` opens editable boolean startup options (Mode, System prompt, Metaphor, Cursor sync), `S` persists the current draft to the preset store, and `R` discards the transient menu draft and re-resolves the view from `env > preset > default`. CLI argument overrides remain in effect for the current Fleet process and are not erased by `R`; argv values never persist automatically and only `S` writes to disk.
- **Inline Model Edit** — `→` (right arrow) from the idle CLI selection opens an inline model text input below the CLI list. `Enter` confirms the model, `Esc` cancels. The model value is persisted through the same session options draft/save flow as the Options Drawer.
- **Fleet Menu** — `m` opens a native Fleet Menu with Authentication, Wiki Server, Diagnostics, and About in that order. `Enter` opens the selected panel, breadcrumbs show the current depth, and `Esc` walks back one level at a time.
- **Native Input Modals** — Fleet Menu panels use in-process text, numeric, password, and confirmation modals. Password fields render masked values and are handled without child CLI auth/input subprocesses.
- **Diagnostics Boundary** — Diagnostics exposes read-only log/data/system views plus a confirmed preset reset. Cursor Sync remains owned by the Options Drawer and is not duplicated in Diagnostics.
- **Cursor Suppression** — When a panel is active or the controller state is not `"active"`, `getCursorAnchor` returns `null` to suppress the outer-terminal cursor.

## State Machine

`MissionControlStateKind`: `idle` → `launching` → `active` → (`ended` | `failed`)

- `idle`: CLI selection menu is shown.
- `launching`: Profile resolution and PTY host creation are in progress.
- `active`: Child PTY is running; input is forwarded to the child.
- `ended` / `failed`: Child PTY exited; control UI is shown with relaunch/choose/exit options.

## Files

| File | Responsibility |
|------|--------------|
| `types.ts` | `MissionControlController`, panel, host interfaces, and `MissionControlCounts` re-export. |
| `controller.ts` | `createMissionControlController` factory, state machine, input routing, and panel lifecycle. |
| `renderer.ts` | `renderMissionControl` — borderless, centered idle/ended/failed UI, option chips, and Options Drawer built from vertically stacked lines. Also exports `MISSION_CONTROL_THEME` for sibling Mission Control panels. |
| `options/*` | Session option types, priority resolver (`env > preset > default`), and mutable runtime (draft/save/reset lifecycle, CLI selection re-resolution, inline model editing). |
| `menu/*` | Fleet Menu panel stack, native input modal, Authentication, Wiki Server, Diagnostics, and About panel implementations. |
| `welcome.ts` | Fleet banner ASCII, cyan→blue gradient, amber `FLEET_ACCENT`, and shared centering helper. |
| `loaded-counts.ts` | `discoverMissionControlCounts` (carriers + wiki entries + queued patches) and `readFleetCliRelease` (version + local/stable channel — `pkg.private === true` ⇒ local, otherwise stable) for the welcome readout. |
