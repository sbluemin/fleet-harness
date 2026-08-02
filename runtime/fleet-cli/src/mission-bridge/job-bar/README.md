# Job Bar

Mission Bridge subdomain for Fleet CLI carrier activity.

`mission-bridge/job-bar/` renders and updates the lower Fleet PTY carrier activity HUD.

The interactive Carrier Roster lives under `../../mission-control/carrier-roster/` and opens from Mission Control with `C`.

Files:

- `renderer.ts`
- `section.ts`
- `state.ts`
- `view-model.ts`

There is no facade module. Internal modules import fleet-carriers APIs directly.
