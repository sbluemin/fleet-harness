# Mission Control

Upper interaction layer that hosts the Agent CLI PTY in the Fleet TUI upper pane.

Mission Control owns the launch menu for selecting an Agent CLI, the active PTY session lifecycle, and a panel host API that temporarily yields the upper pane to interactive panels (e.g., Carrier Status) while they are active.

## Architecture

- **`createMissionControlController(options)`** — Factory that returns a `MissionControlController` with a `component` (implements `MissionControlPtyView`), a `ptyHost`, and panel host methods.
- **Panel Host API** — `openPanel(panel)`, `closePanel()`, and `hasActivePanel()`. When a panel is active, all operator input is routed to the panel component; when closed, input falls through to the underlying Agent CLI PTY or Mission Control control UI.
- **`writeChildInput(data)`** — Programmatic input path that writes directly to the active child PTY, bypassing panel routing. Used by system reminders (e.g., carrier result notifications) that must reach the child process regardless of panel state.
- **Input Routing Order** — `ptyHost.write(data)` checks `activePanel` first; if a panel is open, data is sent to `panel.component.handleInput`. Otherwise, data goes to the active child PTY (`active.host.write`) or Mission Control control input (`handleControlInput`).
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
| `types.ts` | `MissionControlController`, panel, and host interfaces. |
| `controller.ts` | `createMissionControlController` factory, state machine, input routing, and panel lifecycle. |
| `renderer.ts` | `renderMissionControl` and `MISSION_CONTROL_THEME` for the idle/ended/failed UI. |
