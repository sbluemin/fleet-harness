# Mission Control

Upper interaction layer that hosts the Agent CLI PTY in the Fleet TUI upper pane and serves as the Fleet product's main launcher while idle, ended, or failed.

## Architecture

- **Launcher Root** — The inactive control surface is a `PanelStack` root with `Start`, `Configure Carriers`, `Options`, `System Menu`, and `Exit Fleet`.
- **Action-list navigation** — Mission Control panels use `↑↓`, `Enter`, and `Esc`. Domain hotkeys are intentionally not routed from the root or deep panels.
- **`createActionListPanel()`** — Shared `MenuPanel` factory for row selection, conditional action filtering, breadcrumbs, status rows, and consistent footer behavior.
- **Active PTY priority** — When `state === "active"` and a child PTY exists, input and render go to the child before panel/control UI: `active > panel > control`.
- **Programmatic child input** — `writeChildInput(data)` writes directly to the active child PTY for system reminders even when a Mission Control panel exists.
- **Start launch flow** — `Start` lists the configured Agent CLIs directly. `Enter` launches the selected CLI, and `→` edits the launch-time model override through `sessionOptions.setModel()`. It remains separate from Carrier Roster per-carrier model editing.
- **Gradient shimmer** — The Fleet banner animates on inactive screens with a smooth right-to-left RGB-lerped shimmer over a ~4-second cycle and stops while the active Agent CLI PTY is running.
- **Options** — Mode, System prompt, Metaphor, Cursor sync, Save defaults, and Reset overrides are action-list rows. `Enter` toggles, cycles, saves, or resets the selected row.
- **System Menu** — Authentication, Wiki Server, Diagnostics, and About are reached through `System Menu`.
- **Exit Fleet** — Exit is a Launcher Root action and is not duplicated in nested panels.
- **Input modals** — Text, password, and numeric modals remain. Confirmation flows use action-list Confirm/Cancel panels.

## Visual System

- The Fleet gradient banner remains the first inactive Mission Control signal when width allows.
- Selection uses an accent `▸` marker, accent text, and selected background treatment.
- Marker meanings are stable: `▸` focus, `●` persisted/current choice, `○` unselected choice, `✓` configured/success, warning tone for errors.
- Value accents are consistently applied to dynamic or actionable values in key-value rows across Mission Control panels.
- Mission Control frame utilities must preserve visible width for ANSI and CJK text and must not depend on Mission Bridge or Job Bar internals.
- Inactive Mission Control content is vertically centered only when shorter than the allocated rows. Active PTY output is top-aligned.

## Files

| File | Responsibility |
|------|--------------|
| `types.ts` | `MissionControlController`, panel, host interfaces, and `MissionControlCounts` re-export. |
| `controller.ts` | Launcher lifecycle, active PTY priority, Start/Options/System Menu wiring, state machine, and panel lifecycle. |
| `renderer.ts` | Shared Mission Control shell, Fleet banner/status readout, and theme export. |
| `menu/action-list-panel.ts` | Standard action-list `MenuPanel` factory. |
| `menu/input-modal.ts` | Text, password, and numeric input modal implementation. |
| `menu/*` | Authentication, Wiki Server, Diagnostics, About, and shared panel stack implementations. |
| `welcome.ts` | Fleet banner ASCII, RGB-lerped cyan to blue gradient, amber accent, and shared centering helper. |
| `loaded-counts.ts` | Carrier/wiki/queue counts and Fleet CLI release readout. |
