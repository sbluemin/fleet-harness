# Carrier Roster

Mission Control-owned carrier configuration panel.

Carrier Roster opens from `Mission Control -> SYSTEM -> Carrier Roster`. Browse mode uses row selection only: `↑↓`, `Enter`, and `Esc`.

## Workflow

- **Carrier row** — `Enter` opens a carrier action menu with `Agent CLI`, `Model`, `Rename Carrier`, and `Toggle Details`. Task Force-capable carriers additionally expose `Configure TaskForce`.
- **Roster Actions row** — A virtual row after carrier rows opens global actions: `Batch CLI Switch` and `Reset CLI Types to Default`.
- **Edit chains** — Model selection may continue to effort selection. CLI type selection may continue to batch from/to selection. Rename keeps text, Backspace, Enter, and Esc behavior.
- **TaskForce** — `Configure TaskForce` pushes a sub-panel. Backend browse mode uses `Enter` to open actions. `Reset to Origin` is shown only for custom backend settings and remains no-confirm.

The Job Bar remains in `../../mission-bridge/job-bar/` and is intentionally not imported from this directory.
