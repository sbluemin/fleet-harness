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

Use a unique CDP port and agent-browser session. CDP grants full renderer control; bind only to loopback, do not expose the port, and terminate the owned app when finished.

## Preflight and ownership

1. Read root and `runtime/fleet-desktop/CLAUDE.md`.
2. Record OS/architecture, source commit, Electron version, and whether the target is dev, unpacked, unsigned, or signed release.
3. Inspect running Fleet Desktop/Console processes and locks. Do not quit the installed user app, delete a lock, or signal a process you did not launch. If terminal or SDK/chat agents may start, complete [Claude state and trust preflight](../claude-state.md) before launch; launch `pnpm desktop` under its explicit environment as shown below, and verify the owned Console child's selected non-secret paths and run-specific files using the preflight's boundary evidence, never a full environment dump. Desktop data isolation does not isolate Claude state.
4. Launching takes the user's OS focus: startup calls `show()` on the window unconditionally, which activates the app, and `open -g` does not prevent it. Every Desktop launch is therefore an OS activation under the skill's focus rule. Obtain the user's own explicit authorization, including how many launches, before the first one; a peer session's instruction is not that authorization.
5. Build Console and Desktop from the target checkout. Ensure the package manager binary is also on `PATH` because nested package scripts invoke it by name.
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

`<owned-run>/pathbin` holds only `node` and `pnpm` links, so no agent CLI resolves from `PATH`. `CLAUDE_BIN` and `CODEX_BIN` take precedence over saved paths and `PATH`: point each at an owned stub that answers `--version` and otherwise sleeps for a unique duration, so cleanup can check for leftovers, or at a missing path. After boot, confirm from the Console child's selected environment keys that the launching session's markers and tokens are absent, and that the agent CLI state reports the stub.

Starting the Electron binary yourself bypasses that data root and reads the user's real one. It also drops the managed Node path, which a development build takes from `FLEET_CONSOLE_NODE_PATH` or from the `npm_node_execpath` that pnpm/npm sets, and without it the main process aborts before opening a window. Keep a direct invocation for a claim that genuinely needs one, and give it the same allowlist. Such a main stays your shell's child, so the helper below, which selects init-parented mains, does not stop it; stop it by its recorded PID. Use an absolute Node path and absolute E2E main path; package-filter commands change cwd.

Store temporary logs, screenshots, and artifacts in the session scratchpad. Set the absolute target worktree path for every command. `ab()`, `SESSION`, and `CDP_PORT` do not survive independent shell calls; redeclare them or substitute the same recorded literals.

## Stopping the owned Desktop

The process the launcher leaves in your shell is not the app. On macOS the dev target hands the bundle to `open -W -n`, which lets launchd adopt it, so the Electron main is reparented to init while your shell still holds only `pnpm` and `open`. Signalling what you started therefore reports success while the app and its Console child keep running — and the next launch collides with them.

Select by **parent and path** instead: the owned main is the process whose parent is init and whose executable path is under `<worktree>/runtime/fleet-desktop`. Run the helper, which applies that rule, refuses the main checkout where the user's own Desktop runs, and returns only once the process set, the Console lock's PID, and the CDP listener are all gone:

```bash
node <worktree>/.claude/skills/console-e2e/scripts/stop-owned-desktop.mjs <worktree> \
  --console-dir <owned-console-dir> --cdp-port <cdp-port>
```

Add `--dry-run` to see the selection without signalling, and `--force` to escalate to `SIGKILL` after the timeout. The helper checks the lock's PID, not the file: a stale `console.lock` left in the owned Console directory after a successful stop is not a standing process. A non-zero exit means something is still standing; report what the helper names rather than widening the kill by hand. Never target the main checkout, an unknown PID, or a process you did not launch.
