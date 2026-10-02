# Native runtime and package verification

## Native and runtime workflow

Native surfaces that CDP cannot observe have no scripted runner — the repository ships no Playwright Electron suite. Verify them by hand on a shell launched as [Setup](setup.md) specifies.

Classify failures before blaming the product:

- Native dialogs, menu accelerators, tray actions, close/show behavior, and second-instance focus require headed observation, not DOM inference.
- A second shell launched while the user's Fleet Console runs is absorbed by Electron's single-instance lock and exits immediately with no output. Pass a separate `--user-data-dir` to get its own lock, and an isolated `FLEET_CONSOLE_DATA_DIR` so it does not adopt canonical Console state. `FLEET_DESKTOP_DATA_DIR` relocates Desktop's own owner identity and user data, and `FLEET_DATA_DIR` relocates the whole Fleet root when the run must also start without credentials. Note that a development Desktop honors `FLEET_CONSOLE_DATA_DIR` but deliberately ignores its former name `FLEET_CONSOLE_DIR`, which stays packaged-only so a stray inherited value cannot redirect a dev shell.
- Window capture (`screencapture -l <window-id>`) needs Screen Recording permission for the process hosting the agent session; Accessibility does not grant it. Without Screen Recording the window list also withholds titles, and dev shells from different checkouts share one name, so identify the owned window by its owner PID.
- Desktop never hides a native Browser view natively. A `visible:false` placement keeps the view visible, moves it to the window origin at its last size, and parks it behind Console in z-order. Its CDP target therefore reports `visibilityState: visible` and an unchanged viewport whether shown or hidden, and a CDP screenshot of the Console page omits native views. Neither is evidence of what the user sees. Report renderer evidence (the panel's occlusion sampling and the placement Desktop accepted) separately from OS pixel evidence, which only a window capture provides.
- Before spending a launch on an OS pixel claim, check read-only that the screen is unlocked and that the agent session's process has Screen Recording. A locked screen makes every window offscreen and every renderer hidden. If either check fails, report the pixel lane blocked before launching:

```bash
cat > <scratchpad>/pixel-preflight.swift <<'EOF'
import CoreGraphics
let locked = (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool ?? false
print("screenLocked=\(locked) screenRecording=\(CGPreflightScreenCaptureAccess())")
EOF
swift <scratchpad>/pixel-preflight.swift
```

For runtime ownership, record the lock PID/port and whether Desktop ownership metadata is present without printing tokens. Confirm the child and lock disappear after owned Quit. Read `desktop.log` for bootstrap, procurement, child stderr, and exit causes. A foreign Console must be acknowledged and left running.

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
