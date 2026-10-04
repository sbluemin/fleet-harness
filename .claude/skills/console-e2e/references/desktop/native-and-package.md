# Native runtime and package verification

## Native and runtime workflow

Native surfaces that CDP cannot observe have no scripted runner — the repository ships no Playwright Electron suite. Verify them by hand on a shell launched as [Setup](setup.md) specifies.

Classify failures before blaming the product:

- Native dialogs, menu accelerators, tray actions, close/show behavior, and second-instance focus require headed observation, not DOM inference.
- A second shell launched while the user's Fleet Console runs is absorbed by Electron's single-instance lock and exits immediately with no output. Pass a separate `--user-data-dir` to get its own lock, and an isolated `FLEET_CONSOLE_DATA_DIR` so it does not adopt canonical Console state. `FLEET_DESKTOP_DATA_DIR` relocates Desktop's own owner identity and user data, and `FLEET_DATA_DIR` relocates the whole Fleet root when the run must also start without credentials. Note that a development Desktop honors `FLEET_CONSOLE_DATA_DIR` but deliberately ignores its former name `FLEET_CONSOLE_DIR`, which stays packaged-only so a stray inherited value cannot redirect a dev shell.
- Window capture (`screencapture -l <window-id>`) needs Screen Recording permission for the process hosting the agent session; Accessibility does not grant it. Without Screen Recording the window list also withholds titles, and dev shells from different checkouts share one name, so identify the owned window by its owner PID. Before capturing OS pixels, inspect window occlusion with `node <worktree>/.claude/skills/console-e2e/scripts/desktop-preflight.mjs <worktree> --occlusion`. If occluded by another app window (such as on a secondary display), treat the OS pixel path as obstructed: request the user uncover the window or fall back to the [main inspector observation lane](#main-inspector-observation-lane). Desktop Zen syncs with native macOS fullscreen into a separate Space, switching the display away from the user's Space and dropping the window from on-screen capture (`could not create image from window`); treat OS pixels as unavailable and verify via the inspector lane's Console crop instead. When the claim is the Zen layout rather than the fullscreen sync itself, keep the window in place by failing only the renderer's `POST /api/v1/desktop/window/command` over CDP (`Fetch.enable` on that path, `Fetch.failRequest` for POST) before entering Zen. Leave the shell's `/command/events` stream alone, and confirm each blocked POST as `net::ERR_BLOCKED_BY_CLIENT` rather than trusting the interception setup. Unchanged window bounds, with `--occlusion` still reporting the window on screen, then show it entered no fullscreen Space; this is not a direct Space ID comparison, and it leaves the fullscreen sync unverified.
- A native Browser view's `visibilityState` and viewport, and a CDP screenshot of the Console page, are not evidence of native occlusion. Report view-composition or renderer evidence separately from OS pixel evidence. Step 4 of the [main inspector observation lane](#main-inspector-observation-lane) gives the mechanism and verdict criteria.
- A run that claims OS pixels also runs the [read-only preflight helper](setup.md#read-only-preflight) before authorization. Put the lock and permission results in the authorization question, and when the pixel lane is blocked, settle the observation lane's evidence limits first. A locked screen can make windows offscreen and renderers hidden, so a reachable inspector is no evidence that the screen or capture is healthy.

For runtime ownership, record the lock PID/port and whether Desktop ownership metadata is present without printing tokens. Confirm the child and lock disappear after owned Quit. Read `desktop.log` for bootstrap, procurement, child stderr, and exit causes. A foreign Console must be acknowledged and left running.

## Main inspector observation lane

Without Screen Recording, this lane observes whether a native Browser view moved behind Console and what Console itself shows. Report it as **view-composition observation**, never as **OS-composited pixel** evidence. It cannot verify the compositor's actual output, occlusion by other apps, focus, pointer hit testing, or the look of native dialogs.

1. Follow [Setup](setup.md) as written: preflight, then the user's own authorization of launch count and focus, then the isolated environment. Extend only the last line of its launch command as below. Never relaunch beyond the authorized count to attach the inspector.

   ```bash
   pnpm desktop --remote-debugging-port=<cdp-port> --inspect=127.0.0.1:<inspector-port>
   ```

   The inspector grants code execution in the main process. Bind it to `127.0.0.1` only, with no forwarding, tunnel, or exposure, and never use `--inspect-brk`. After start, confirm that the address and PID from `lsof -nP -iTCP:<inspector-port> -sTCP:LISTEN` are the owned Electron main before connecting. This endpoint is separate from the renderer CDP port.
2. Read the view composition with the read-only client, which refuses a non-loopback endpoint and writes its output only on the client side:

   ```bash
   node <worktree>/.claude/skills/console-e2e/scripts/main-inspector.mjs <inspector-port> <evidence-dir> snapshot <label>
   ```

   It evaluates `process.mainModule.require('electron')` in the Electron **main** and returns each window's `contentView.children` with index, bounds, webContents ID, and page origin and path. Exit 1 is a failed observation; if `process.mainModule` is `undefined` (it is defined under the ESM `dist/main.mjs` as of Electron 43.1), report the observation as failed and do not evaluate through another module-loading path. Never extend the client to move, resize, reorder, show, hide, or focus a view, change app state, read files, environment, cookies, or tokens, spawn processes, or pause the debugger.

   Match the PID against the owned main, and identify the Console child by the owned Console origin and its `/console/` path. Map the remaining children to the scenario's native Browser webContents. Do not record URL query, hash, or titles. If any child cannot be identified, do not guess the order.
3. In the same state, capture the Console webContents region of interest, passing the numeric window and Console webContents IDs from the snapshot and a rect in **Console view coordinates (DIP)**:

   ```bash
   node <worktree>/.claude/skills/console-e2e/scripts/main-inspector.mjs <inspector-port> <evidence-dir> crop <label> <windowId> <consoleContentsId> <x> <y> <width> <height>
   ```

   Keep the rect inside the Console bounds, and confirm a real, non-empty image; its reported size is in device pixels, so a 900×600 DIP rect returns 1800×1200 at scale factor 2. Take a snapshot before and after the crop to confirm the state held; never use a capture taken mid-transition as evidence of a settled state. If a lock, minimization, or similar leaves the crop empty or stale, that part is unverified; do not recover it by activating the hidden window.
4. Observe before the user action, the target state, and the reverse return under the same window and webContents IDs. Judge by **combining** view composition with the Console crop:

   | State | Required observation |
   |---|---|
   | Native Browser shown | Its child index is above Console's, and its bounds match the panel's DIP bounds. |
   | Native Browser covered by a Console overlay | Its child index is below Console's and its bounds are parked at `(0, 0)`. The Console crop shows the expected overlay or fleet map layer and its content. |
   | Reverse, such as closing the overlay | The same native child returns above Console with the panel bounds, and the Console crop shows the restored state. |

   The basis is `place()` in `runtime/fleet-desktop/src/browser-views.ts` and `relayout()` in `runtime/fleet-desktop/src/shell-window.ts`. `visible:false` is not `setVisible(false)`: the view keeps `setVisible(true)` and is parked at the window origin at its last viewport size (the initial default when none) behind Console. `children` runs back to front, stacked as parked Browser → Console → presented Browser → picker → veil. **The native target's `document.visibilityState` and viewport size are therefore not occlusion evidence.** The Console crop does not contain native views either, so never claim native occlusion from the crop alone. Keep the renderer's occlusion and placement reports as separate supporting evidence.
5. State `Evidence lane: view-composition observation (main inspector + Console crop)` in the report. Record each state's child indexes, bounds, and webContents IDs, the crop paths, expected versus actual, and the unverified scope, and never restate it as "OS pixel verification passed". The client disconnects after each call; perform the [owned Desktop stop](setup.md#stopping-the-owned-desktop), then confirm read-only that the inspector port no longer listens.

## Package workflow

```bash
pnpm --filter @dotobokuri/fleet-desktop package:dir
pnpm --filter @dotobokuri/fleet-desktop verify:package
```

Verify shell-only ASAR contents, passive entry assets, Node manifest, absence of embedded Console/Node payloads, Electron architecture, and required fuses. Run packaged-live tests against the actual artifact on its native OS. Use `package:release` evidence only when signing credentials, signing/notarization or platform signature checks, and release verifier chain all pass.

## Platform matrix

- **macOS:** hidden-inset titlebar, dock identity, app menu, close-without-quit, signed/notarized release.
- **Windows:** titlebar overlay/theme sync, tray hide/show, hidden-window update dialog, ConPTY path, Authenticode. Verify on Windows.
- **Linux:** tray lifecycle, desktop integration, architecture, checksum/GPG release evidence. Verify on Linux.

Mark every unrun native row `[Unverified — requires <OS>]`; cross-platform unit fixtures do not replace live native evidence.
