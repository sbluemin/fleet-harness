# Desktop automation setup and ownership

## Load Electron automation

Record the automation client and target Electron OS/architecture separately. If the host is Windows ARM64, the native agent-browser wrapper is unavailable, or the claim is platform-specific, read [the platform automation reference](platform-automation.md) completely before launching Electron or connecting CDP. Never infer the Electron or packaged-artifact architecture from the agent-browser binary.

```bash
ab() {
  if command -v agent-browser >/dev/null 2>&1; then agent-browser "$@";
  else npx --yes agent-browser "$@"; fi
}
ab skills get core --full
ab skills get electron
ab skills get dogfood
```

Use a unique CDP port and an agent-browser session named by the [agent-browser session rule](../agent-browser.md#load-the-contract) so `close-owned-session.mjs` can close it. CDP grants full renderer control; bind only to loopback, do not expose the port, and terminate the owned app when finished.

## Preflight and ownership

1. Read root and `runtime/fleet-desktop/CLAUDE.md`.
2. Record OS/architecture, source commit, Electron version, and whether the target is dev, unpacked, unsigned, or signed release.
3. Inspect running Fleet Desktop/Console processes and locks. Do not quit the installed user app, delete a lock, or signal a process you did not launch. If terminal or SDK/chat agents may start, complete [Claude state and trust preflight](../claude-state.md) before launch; launch `pnpm desktop` under its explicit environment as shown below, and verify the owned Console child's selected non-secret paths and run-specific files using the preflight's boundary evidence, never a full environment dump. Desktop data isolation does not isolate Claude state.
4. **Before** asking for launch and focus authorization, run the [read-only preflight](#read-only-preflight) below in the agent session that will capture. Put its evidence lane, the reason pixels are unavailable or unconfirmed, and the launch count in the authorization question. If `screenLocked=true`, make unlocking and rerunning the preflight a precondition of the request; on a locked screen even the inspector lane's Console crop can come back empty or stale. If the run is blocked, report the cause first; never clear it by stopping a process you did not launch or deleting a lock. Launching takes the user's OS focus: startup calls `show()` on the window unconditionally, which activates the app, and `open -g` does not prevent it. Every Desktop launch is therefore an OS activation under the skill's focus rule. Obtain the user's own explicit authorization, including how many launches, before the first one; a peer session's instruction is not that authorization. When the run will resize or move the owned window, the same question also names the inspector attached for it, the target content size and position, whether activating the owned window by its PID is allowed, and what happens on occlusion, as [Window size](#window-size) specifies; settling these up front keeps an occluded or undersized window from costing another request. An Objectives member session cannot prompt the person directly: relay the preflight evidence and requested launch count to the Commander, and treat only the resulting recorded board decision (via `request_decision`) as the person's authorization, not the Commander's relay message alone.
5. Build Console and Desktop from the target checkout. Ensure the package manager binary is also on `PATH` because nested package scripts invoke it by name. A fresh worktree's `runtime/fleet-desktop/node_modules/electron` has no `path.txt` until its binary is installed, and the first launch then downloads it into the owned `HOME`'s empty cache; install it beforehand from the normal shell with `node <worktree>/runtime/fleet-desktop/node_modules/electron/install.js`, which uses the user's Electron download cache, so the isolated launch neither downloads nor waits.
6. Record the rollback point and owned resources: app PID/session, CDP port, Console directory/lock, log path, screenshots, and package output.
7. Confirm the launch by a CDP page target, never by a live process. A main-process failure still leaves helper processes running, so a process list cannot distinguish a booted app from a failed one, and the failure is waiting on the user's screen as a modal dialog. Missing target, unwritten data directory, or a launcher that returns while processes persist all mean the app did not boot: read the failure before relaunching, and never repeat a blind launch.

Development Desktop derives its userData and Console directory from the source checkout. Run only when that checkout has no live Desktop-owned instance. Launch every development run through the checkout's isolated development target, which builds Console and Desktop, points the run at the checkout-local data root, supplies the managed Node path, and forwards the trailing flag to the app.

On macOS that target hands the bundle to `open`, which passes the calling shell's entire environment to the app; the target's `--env` values only overlay it. Desktop forwards that environment, minus Electron and its own control keys, to the Console child. A launch from an agent session therefore gives the child the real `HOME`, any `claude` on `PATH`, and the session's markers and access tokens. Launch under a clean allowlist instead:

```bash
cd <worktree>
env -i HOME="<owned-run>/home" USER="<user>" LANG="<locale>" \
  PATH="<owned-run>/pathbin:/usr/bin:/bin:/usr/sbin:/sbin" \
  FLEET_DATA_DIR="<owned-run>/root" \
  FLEET_CONSOLE_DATA_DIR="<owned-run>/console" \
  FLEET_DESKTOP_DATA_DIR="<owned-run>/desktop" \
  FLEET_CONSOLE_NODE_PATH="<absolute-node>" \
  CLAUDE_CONFIG_DIR="<owned-run>/claude" \
  CLAUDE_BIN="<owned-run>/bin/claude" CODEX_BIN="<owned-run>/bin/codex-absent" \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  pnpm desktop --remote-debugging-port=<cdp-port>
```

`<owned-run>/pathbin` holds only `node` and `pnpm` links, so no agent CLI resolves from `PATH`. `CLAUDE_BIN` and `CODEX_BIN` take precedence over saved paths and `PATH`: point each at an owned stub that answers `--version` and otherwise sleeps for a unique duration, so cleanup can check for leftovers, or at a missing path. After boot, confirm from the Console child's selected environment keys that the launching session's markers and tokens are absent, and that the agent CLI state reports the stub. `env -i` does not stop launchd from adding its session keys through `open`: keys such as `SSH_AUTH_SOCK`, `TMPDIR`, `SHELL`, `LOGNAME`, and `XPC_*` can still reach the child, and `SSH_AUTH_SOCK` reaches the user's SSH agent. Record whether it is present, and treat it as a credential path this run must not use, not as evidence of leaked session state.

Starting the Electron binary yourself bypasses that data root and reads the user's real one. It also drops the managed Node path, which a development build takes from `FLEET_CONSOLE_NODE_PATH` or from the `npm_node_execpath` that pnpm/npm sets, and without it the main process aborts before opening a window. Keep a direct invocation for a claim that genuinely needs one, and give it the same allowlist. Such a main stays your shell's child, so the helper below, which selects init-parented mains, does not stop it; stop it by its recorded PID. Use an absolute Node path and absolute E2E main path; package-filter commands change cwd.

Store temporary logs, screenshots, and artifacts in the session scratchpad, and place `<owned-run>` per [Setup](../setup.md#isolate-the-console). Set the absolute target worktree path for every command. `ab()`, `SESSION`, and `CDP_PORT` do not survive independent shell calls; redeclare them or substitute the same recorded literals.

## Read-only preflight

```bash
node <worktree>/.claude/skills/console-e2e/scripts/desktop-preflight.mjs <worktree> \
  --console-dir <owned-console-dir> --cdp-port <cdp-port> --inspector-port <inspector-port> --json
```

Omit `--json` for a human-readable summary. Pass the Console directory and the two distinct, unused ports the launch will actually use. The helper reports the screen lock, the `CGPreflightScreenCaptureAccess()` result, the ancestor PIDs, executables, and `.app` paths from its own process up, listener addresses and PIDs, Desktop processes of that worktree, and the Console lock state. It writes no files, requests no permission, and sends no signals. It refuses the main checkout, and refuses a `--console-dir` inside the default user `~/.fleet` or an inherited `FLEET_DATA_DIR` or `FLEET_CONSOLE_DATA_DIR`, comparing after resolving symlinks of existing paths; run it from the real agent session before switching to the isolated environment. It never prints lock contents or full process arguments.

The exit code contract:

| Code | Verdict to use before authorization |
|---|---|
| `0` | `os-pixels`: the screen is unlocked and the same chain's Screen Recording probe is granted. Candidate for the OS pixel lane. |
| `10` | `inspector`: no launch conflict, but the pixel lane is unavailable or unconfirmed. Decide whether the [main inspector observation lane](native-and-package.md#main-inspector-observation-lane) can give view-composition evidence. |
| `20` | `blocked`: an occupied port, a leftover owned Desktop, a live or unreadable Console lock, an invalid target, or a failed preflight. Do not launch; report the cause. |

The CoreGraphics probe is a read-only call from an `osascript` child of the same session. macOS cannot query an arbitrary ancestor PID's permission through this API, so the ancestor list shows **where the capture chain comes from, not whether it is granted**. Never report it as checking another host's computer-use tool or a separate app; when the capturing session or host changes, rerun it there. If no `.app` ancestor exists, say so in the authorization question instead of guessing which app to grant. The ppid ancestors can differ from the TCC responsible process: the helper also reports the probe's responsible PID and executable through libsystem's private `responsibility_get_pid_responsible_for_pid` SPI, **for diagnosis only**, recording `null` with a reason on failure without changing the lane. Decide the grant target from the responsible process, not an ancestor `.app`; when an SSH session is responsible, granting an ordinary `.app` may not open the lane. The SPI result is not evidence of a grant. The output is a snapshot, so recheck right before the authorized launch after a long wait or an environment change.

Example: "The preflight shows no Screen Recording and an unlocked screen (exit 10). This run will produce **view-composition observation** (children order and bounds plus a Console crop), not OS-composited pixels. Do you authorize **one** isolated dev Desktop launch **and the OS focus change it causes**?" With a resize: "…one launch with a loopback main inspector, used only to set the owned window's content to **1440×900 at (120, 80)** on the display it opens on; if another app's window covers it, I move only the owned window within that display's work area and recheck, touch no other app, and **may / may not** activate the owned window by its PID; if it stays covered, I stop the pixel lane and report. Do you authorize that?" If the claim can only be judged from pixels, do not substitute this lane as a pass; state the limitation. A permissive exit code means neither user authorization nor a successful capture.

## Window size

A development Desktop has no size environment variable or saved bounds. `runtime/fleet-desktop/src/window-policy.ts` gives the window no width or height, only `minWidth: 900` and `minHeight: 560`, so a fresh macOS run usually opens at Electron's default 800×600 widened to **900×600 DIP**; the OS can still place or restore it differently, so read the actual size rather than assuming it. When the claim needs a wider layout, resize the owned window; do not emulate a viewport (next section). Renderer CDP cannot resize it: `cdp-input.mjs` refuses `Browser.setWindowBounds`.

Resizing is a main-process change, outside the read-only [main inspector observation lane](native-and-package.md#main-inspector-observation-lane), and only the person's authorization naming the size and position allows it (step 4 above). Attach the inspector with that lane's step 1 launch line and confirm its loopback listener PID is the owned main, then use only this client:

```bash
node <worktree>/.claude/skills/console-e2e/scripts/resize-owned-window.mjs <inspector-port> <owned-pid> <evidence-dir> <label> --dry-run
node <worktree>/.claude/skills/console-e2e/scripts/resize-owned-window.mjs <inspector-port> <owned-pid> <evidence-dir> <label> <width> <height> [<x> <y>]
```

`<width> <height>` are the Console content size in DIP; `<x> <y>` default to the current content origin. The client refuses unless the main's PID equals `<owned-pid>` and exactly one BaseWindow exists, and refuses a fullscreen or minimized window, a size below the window minimum, or a rect outside every display's work area. It calls `setContentBounds` and nothing that shows, focuses, raises, or enters fullscreen, and never touches another window or app. `--dry-run` reads the current bounds and the display work areas without changing anything. Exit 0 means the content bounds read back as requested, 2 that the window settled elsewhere, 1 a refusal or failure. Its JSON records `before`/`after` bounds, `focused`, and the Console `consoleZoomFactor`. Whether resizing alone changes OS focus is unverified; a focus-dependent claim checks focus separately.

Then read the renderer through the owned CDP session:

```bash
cat <<'EOF' | ab --session <session> eval --stdin
(() => ({
  viewport: [innerWidth, innerHeight],
  outer: [outerWidth, outerHeight],
  desktopZoom: document.documentElement.style.getPropertyValue('--desktop-zoom'),
}))()
EOF
```

The window reached the requested size when the client exits 0 with `consoleZoomFactor` 1, and `viewport` equals the requested width and height. `desktopZoom` must be `"1"` with `outer[0] === viewport[0]`: the Console records `outerWidth / innerWidth` as `--desktop-zoom` only at page load and on a `devicePixelRatio` change (`trackDesktopZoomFactor` in `runtime/fleet-console/core/client/src/integration/store.ts`), so a resize keeps a correct value correct, and any other value means the document loaded under a viewport override.

Before OS pixel capture, run the [occlusion check](native-and-package.md#native-and-runtime-workflow). If another app's window covers the owned window, move only the owned window within the authorized position or display and check again. Never move, hide, minimize, close, or activate another app's window, and activate the owned window only by its PID and only when the authorization included it. If it stays covered, stop the pixel lane and report; the inspector lane remains available, and a launch beyond the authorized count is not.

## Viewport emulation

Emulate the renderer viewport only when the claim is about that viewport rather than the window. `Emulation.setDeviceMetricsOverride` leaves the native window and its native Browser views at their real bounds, and a reload under it records a false `--desktop-zoom` (a 1440×900 override in a 900×600 window gives 0.625). Discard every measurement from a document loaded under the override.

Clear it in this order:

1. From the **same** CDP session that set it, send `Emulation.clearDeviceMetricsOverride` and wait for its response. Overrides belong to the session that set them; another session cannot clear them.
2. Close that session.
3. Reload the Console page.
4. Run the renderer read above: `desktopZoom` `"1"`, `outer[0] === viewport[0]`, and `viewport` equal to the `contentBounds` size from `resize-owned-window.mjs --dry-run`.

Do not count on a detach to clear it. With agent-browser 0.27.0 on headless Chrome, device-metrics and touch overrides set over a page WebSocket or a flattened `Target.attachToTarget` session were gone once that session detached. Whether an Electron renderer keeps a device-metrics override after detach is unverified: one Desktop run reported that it did, and that has not been reproduced. Do not use agent-browser `set viewport` or `set device` on a Desktop session: its daemon keeps the connection, so the override outlives the command and reloads, and the CLI has no command to clear it. If step 4 still fails, report that state and do not measure on it.

## Stopping the owned Desktop

The process the launcher leaves in your shell is not the app. On macOS the dev target hands the bundle to `open -W -n`, which lets launchd adopt it, so the Electron main is reparented to init while your shell still holds only `pnpm` and `open`. Signalling what you started therefore reports success while the app and its Console child keep running — and the next launch collides with them.

Select by **parent and path** instead: the owned main is the process whose parent is init and whose executable path is under `<worktree>/runtime/fleet-desktop`. Run the helper, which applies that rule, refuses the main checkout where the user's own Desktop runs, and returns only once the process set, the Console lock's PID, and the CDP listener are all gone:

```bash
node <worktree>/.claude/skills/console-e2e/scripts/stop-owned-desktop.mjs <worktree> \
  --console-dir <owned-console-dir> --cdp-port <cdp-port>
```

Add `--dry-run` to see the selection without signalling, and `--force` to escalate to `SIGKILL` after the timeout. The helper checks the lock's PID, not the file: a stale `console.lock` left in the owned Console directory after a successful stop is not a standing process. A non-zero exit means something is still standing; report what the helper names rather than widening the kill by hand. Never target the main checkout, an unknown PID, or a process you did not launch.
