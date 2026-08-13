---
name: desktop-e2e
description: Run and diagnose headed end-to-end tests of the Fleet Console Electron Desktop shell. Use for entry-to-Console handoff, BrowserWindow security and navigation policy, native lifecycle, menus, dialogs, tray behavior, Desktop-owned sidecar and logs, reload or relaunch behavior, packaged artifacts, signing boundaries, or platform-specific Desktop verification. Use console-e2e for behavior wholly inside the Console SPA after handoff.
---

# Fleet Desktop E2E

Test the thin Electron shell without re-testing the entire Console product. Collect evidence across renderer, main process, sidecar ownership, native UI, and packaged artifact boundaries.

## Choose the lane

- **Shell/CDP:** entry, handoff, renderer sandbox, URL/navigation policy, window state, screenshots, browser diagnostics.
- **Native:** menu accelerators, native dialogs, single-instance behavior, window close/show, tray, quit/relaunch.
- **Runtime:** Desktop-owned Console lock, child process, log, shutdown, conflict behavior.
- **Package:** unpacked artifact, ASAR boundary, fuses, architecture, signing/release evidence.
- **Console UI:** follow `console-e2e` for any post-handoff SPA-only scenario.

State the target OS and lane before testing. Never claim Windows/Linux native results from macOS or treat unsigned local packaging as release-signing evidence.

## Load Electron automation

Record the automation client and target Electron OS/architecture separately. If the host is Windows ARM64, the native agent-browser wrapper is unavailable, or the claim is platform-specific, read [the platform automation reference](references/platform-automation.md) completely before launching Electron or connecting CDP. Never infer the Electron or packaged-artifact architecture from the agent-browser binary.

```bash
ab() {
  if command -v agent-browser >/dev/null 2>&1; then agent-browser "$@";
  else npx --yes agent-browser "$@"; fi
}
ab skills get core --full
ab skills get electron
ab skills get dogfood
```

Use a unique CDP port and agent-browser session. CDP grants full renderer control; bind only to loopback, do not expose the port, and terminate the owned app when finished.

## Preflight and ownership

1. Read root and `runtime/fleet-desktop/AGENTS.md`.
2. Record OS/architecture, source commit, Electron version, and whether the target is dev, unpacked, unsigned, or signed release.
3. Inspect running Fleet Desktop/Console processes and locks. Do not quit the installed user app, delete a lock, or signal a process you did not launch.
4. Build Console and Desktop from the target checkout. Ensure the package manager binary is also on `PATH` because nested package scripts invoke it by name.
5. Record the rollback point and owned resources: app PID/session, CDP port, Console directory/lock, log path, screenshots, and package output.

Development Desktop derives its userData and Console directory from the source checkout. Run only when that checkout has no live Desktop-owned instance. Use an absolute Node path and absolute E2E main path; package-filter commands change cwd.

## Shell/CDP workflow

Build, then launch Electron directly so the CDP flag reaches the app:

```bash
export PATH="<pnpm-bin>:$PATH"
pnpm --filter @dotobokuri/fleet-console build
pnpm --filter @dotobokuri/fleet-desktop build

ELECTRON_BIN="$(node -e "const {createRequire}=require('module');const r=createRequire(require('path').resolve('runtime/fleet-desktop/package.json'));process.stdout.write(r('electron'))")"
NODE_BIN="$(command -v node)"
CDP_PORT="${CDP_PORT:-9431}"
SESSION="${SESSION:-fleet-desktop-e2e-$(date +%s)}"
FLEET_CONSOLE_NODE_PATH="$NODE_BIN" "$ELECTRON_BIN" --remote-debugging-port="$CDP_PORT" runtime/fleet-desktop
```

Run the app as a managed background process. Wait for the CDP port, then connect:

```bash
ab --session "$SESSION" connect "$CDP_PORT"
ab --session "$SESSION" tab
ab --session "$SESSION" get url
ab --session "$SESSION" snapshot -i
ab --session "$SESSION" errors
ab --session "$SESSION" console
```

Capture the entry state if timing allows, then wait for the exact loopback `/console/` handoff. Assert query and fragment are empty. The stable proof is the transition and final URL, not the literal entry duration.

Probe the renderer boundary:

```bash
cat <<'EOF' | ab --session "$SESSION" eval --stdin
(() => ({
  href: location.href,
  search: location.search,
  hash: location.hash,
  processType: typeof process,
  requireType: typeof require,
  electronInUA: /Electron\//.test(navigator.userAgent),
  viewport: [innerWidth, innerHeight],
  title: document.title,
}))()
EOF
```

Expect Electron UA, `process`/`require` unavailable, a loopback Console URL, and no query/fragment. Attempt same-origin Console navigation and one harmless disallowed navigation; verify the former stays inside `/console/` and the latter leaves the URL unchanged. Avoid `window.open` during automation because valid HTTPS popups intentionally hand off to the user's external browser.

Reload the renderer and repeat URL, sandbox, errors, console, and screenshot checks. Treat the Console DOM as supporting evidence only; detailed SPA behavior belongs to `console-e2e`.

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

## Cleanup and report

Close only the owned agent-browser session, quit the owned Electron app through its managed process/native action, and wait for its Desktop-owned Console lock and child to disappear. Never use global browser close, `pkill Electron`, or delete a live lock.

Report lanes run, target trust level, exact observations, artifacts, commands, failures classified as product/test/environment, cleanup result, and platform rows left unverified.
