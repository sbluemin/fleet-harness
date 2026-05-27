# Carrier Status

Job Bar domain for Fleet CLI carrier activity.

`carrier-status/` now owns only the Job Bar files that render and update the lower Fleet PTY carrier activity HUD.

The interactive Carrier Roster lives under `../mission-control/carrier-roster/` and opens from Mission Control with `C`.

Files intentionally left here:

- `job-bar-register.ts`
- `job-bar-renderer.ts`
- `job-bar-section.ts`
- `job-bar-state.ts`
- `job-bar-view-model.ts`
- `carrier-helpers.ts`
- `constants.ts`
- `facade.ts`
