# Native runtime and package verification

## Native and runtime workflow

Native surfaces that CDP cannot observe have no scripted runner — the repository ships no Playwright Electron suite. Verify them by hand on a built shell:

```bash
pnpm --filter @dotobokuri/fleet-desktop dev
```

Classify failures before blaming the product:

- Native dialogs, menu accelerators, tray actions, close/show behavior, and second-instance focus require headed observation, not DOM inference.
- A second shell launched while the user's Fleet Console runs is absorbed by Electron's single-instance lock and exits immediately with no output. Pass a separate `--user-data-dir` to get its own lock, and an isolated `FLEET_CONSOLE_DATA_DIR` so it does not adopt canonical Console state. `FLEET_DESKTOP_DATA_DIR` relocates Desktop's own owner identity and user data, and `FLEET_DATA_DIR` relocates the whole Fleet root when the run must also start without credentials. Note that a development Desktop honors `FLEET_CONSOLE_DATA_DIR` but deliberately ignores its former name `FLEET_CONSOLE_DIR`, which stays packaged-only so a stray inherited value cannot redirect a dev shell.
- Window-only `screencapture` needs Accessibility permission for the app hosting the shell session; without it only a full-screen capture is possible.

For runtime ownership, record the lock PID/port and whether Desktop ownership metadata is present without printing tokens. Confirm the child and lock disappear after owned Quit. Read `desktop.log` for bootstrap, procurement, child stderr, and exit causes. A foreign Console must be acknowledged and left running.

## Package workflow

```bash
pnpm --filter @dotobokuri/fleet-desktop package:dir
pnpm --filter @dotobokuri/fleet-desktop verify:package
```

Verify shell-only ASAR contents, passive entry assets, Node manifest, absence of embedded Console/Node payloads and updater artifacts, Electron architecture, and required fuses. Run packaged-live tests against the actual artifact on its native OS. Use `package:release` evidence only when signing credentials, signing/notarization or platform signature checks, and release verifier chain all pass.

## Platform matrix

- **macOS:** hidden-inset titlebar, dock identity, app menu, close-without-quit, signed/notarized release.
- **Windows:** titlebar overlay/theme sync, tray hide/show, hidden-window update dialog, ConPTY path, Authenticode. Verify on Windows.
- **Linux:** tray lifecycle, desktop integration, architecture, checksum/GPG release evidence. Verify on Linux.

Mark every unrun native row `[Unverified — requires <OS>]`; cross-platform unit fixtures do not replace live native evidence.
