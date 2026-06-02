# Carrier Roster

Mission Control-owned carrier configuration panel.

Carrier Roster opens from `Mission Control -> Configure Carriers`. Browse mode uses row selection only: `↑↓`, `Enter`, and `Esc`.

## Workflow

- **Carrier row** — `Enter` opens a carrier action menu with `Edit Model`, `Change CLI Type`, `Rename`, `Toggle Native(SubAgent)`, `Open TaskForce`, and `Toggle Details`.
- **Roster Actions row** — A virtual row after carrier rows opens global actions: `Batch CLI Switch` and `Reset CLI Types to Default`.
- **Edit chains** — Model selection may continue to effort selection. CLI type selection may continue to batch from/to selection. Rename keeps text, Backspace, Enter, and Esc behavior.
- **TaskForce** — `Open TaskForce` pushes a sub-panel. Backend browse mode uses `Enter` to open actions. `Reset to Origin` is shown only for custom backend settings and remains no-confirm.
- **Native(SubAgent) and TaskForce** — Enabling Native(SubAgent) clears existing TaskForce config. Saving TaskForce config disables Native(SubAgent) when needed and surfaces a warning.

The Job Bar remains in `../../mission-bridge/job-bar/` and is intentionally not imported from this directory.
