# Console E2E — Desktop route

Verify the thin Electron shell's ownership boundaries. Run only the lanes required by the request, not the entire Console product.

## Inputs and lanes

Record the target worktree, OS/architecture, source SHA, Electron version, and trust level (dev / unpacked / unsigned / signed release). Automation-client architecture and target-app architecture are separate facts.

| Claim | Read before execution |
|---|---|
| Setup and ownership | **Local (no `FLEET_E2E_SSH_TARGET`):** follow [Setup](desktop/setup.md), including the host focus and cursor safeguards. **Remote Mac (SSH alias or `user@host`):** with recorded launch approval for the target Mac, use `node runtime/fleet-desktop/scripts/prepare-remote-mac-package.mjs` from the target worktree, then run `node .claude/skills/console-e2e/scripts/launch-remote-desktop.mjs <worktree> --package <archivePath> --package-sha256 <archiveSha256> --package-revision <sourceRevision> --run-id <unique-id> --local-port <n> --remote-port <n>`. Keep the launcher running, use its READY loopback port for CDP through the SSH tunnel, then terminate the launcher and verify its reclaim result. The local launch/stop gate does not apply to this remote run. Any required real OS input or OS-composited evidence is target-Mac only; SSH selection does not grant input authority. |
| Entry-to-Console handoff, sandbox, navigation, reload | [Shell/CDP](desktop/shell-cdp.md) |
| Menus, dialogs, tray, native Browser view visibility, quit/relaunch, sidecar/lock, the owned empty-lock recovery dialog, package/signing | Relevant lane in [Native and package](desktop/native-and-package.md) |
| Windows ARM64, unavailable wrapper, platform-specific claim | [Platform automation](desktop/platform-automation.md) |
| Real OS mouse click on the owned Desktop | [OS mouse](desktop/os-mouse.md) |

## Evidence order

Judge a claim first from values CDP and the main inspector return: DOM and `eval` results, renderer viewport, window and content bounds, `getZoomFactor`, and view order and bounds. For a visual claim about what the Console page shows, a CDP screenshot of the Console renderer is the primary evidence. Use OS-composited pixels, inspector crops, the occlusion check, and OS focus or input only for a claim those cannot settle, such as native menus and dialogs, a native Browser view, compositor output, or real focus. The OS-dependent items need an unlocked screen; a locked one leaves them unverified, while CDP values still count. On a locked screen also record `document.visibilityState`, and treat a value that depends on the page rendering or being visible (animation frames, focus, intersection) as unverified rather than read from a hidden renderer. A renderer screenshot taken there counts only when `document.visibilityState` read with it is `"visible"`, the image is not a single flat color, and its content matches the DOM read at the same time; otherwise that capture is unverified. Never pass a claim that needs OS-composited pixels through CDP values or a renderer screenshot instead.

Neither a passing preflight nor a remote window capture establishes what someone saw on the physical display; if the claim requires that observation, use the observer’s account or leave that claim unverified.

## Execution

1. Apply `runtime/fleet-desktop/AGENTS.md` and build Console/Desktop from the target checkout. Inspect existing user apps and locks without modifying them.
2. Before browser commands, load `agent-browser` and the installed CLI's core/electron/dogfood contract. Use a unique session and loopback CDP port. Record owned app PID, Console directory/lock, logs, and evidence paths.
3. Exercise the chosen lane. Shell/CDP verifies loopback `/console/` handoff, empty query/fragment, unavailable renderer `process`/`require`, allowed/blocked navigation, and reload. Avoid unnecessary valid popups: they open the user's external browser.
4. Verify native menus/windows/tray/dialogs through headed observation, not CDP DOM inference or another OS's fixtures. Verify packages against actual artifacts and their verifier; unsigned success is not release-signing evidence.
5. After the scenario and relevant inverse, close only the owned browser session and app, then verify disappearance of the Desktop-owned Console child and lock. Stop the app through [Setup](desktop/setup.md)'s helper: the launcher reparents the Electron main, so signalling the process your shell holds reports success while the app keeps running.

## Completion, blocks, and reporting

- Finish when the requested lanes and cleanup are observed. Classify product/test/environment failures. If the task includes a fix, resolve task-induced regressions and repeat the same verification.
- Never expose CDP externally, quit the user's app, globally close browsers or `pkill Electron`, delete a live lock, or print tokens.
- Missing OS, permissions, or signing credentials block only the affected lane. Mark it `[Unverified — requires <OS/permission>]`; do not infer its result from another lane.
- Report lanes/trust level, exact observations, commands/evidence, failure classification, cleanup, and unverified platforms. Use scratchpad temporary files and absolute worktree/binary paths.
