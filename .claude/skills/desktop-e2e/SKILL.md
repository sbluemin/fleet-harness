---
name: desktop-e2e
description: Verify Fleet Electron Desktop window behavior, native lifecycle, security boundaries, sidecar ownership, or packaging in the real app. Route SPA-only behavior after Console handoff to console-e2e.
---

# Desktop E2E

Verify the thin Electron shell's ownership boundaries. Run only the lanes required by the request, not the entire Console product.

## Inputs and lanes

Record the target worktree, OS/architecture, source SHA, Electron version, and trust level (dev / unpacked / unsigned / signed release). Automation-client architecture and target-app architecture are separate facts.

| Claim | Read before execution |
|---|---|
| Setup and ownership for every Desktop run | [Setup](references/setup.md) |
| Entry-to-Console handoff, sandbox, navigation, reload | [Shell/CDP](references/shell-cdp.md) |
| Menus, dialogs, tray, quit/relaunch, sidecar/lock, package/signing | Relevant lane in [Native and package](references/native-and-package.md) |
| Windows ARM64, unavailable wrapper, platform-specific claim | [Platform automation](references/platform-automation.md) |

## Execution

1. Apply `runtime/fleet-desktop/CLAUDE.md` and build Console/Desktop from the target checkout. Inspect existing user apps and locks without modifying them.
2. Before browser commands, load `agent-browser` and the installed CLI's core/electron/dogfood contract. Use a unique session and loopback CDP port. Record owned app PID, Console directory/lock, logs, and evidence paths.
3. Exercise the chosen lane. Shell/CDP verifies loopback `/console/` handoff, empty query/fragment, unavailable renderer `process`/`require`, allowed/blocked navigation, and reload. Avoid unnecessary valid popups: they open the user's external browser.
4. Verify native menus/windows/tray/dialogs through headed observation, not CDP DOM inference or another OS's fixtures. Verify packages against actual artifacts and their verifier; unsigned success is not release-signing evidence.
5. After the scenario and relevant inverse, close only the owned browser session and app, then verify disappearance of the Desktop-owned Console child and lock.

## Completion, blocks, and reporting

- Finish when the requested lanes and cleanup are observed. Classify product/test/environment failures. If the task includes a fix, resolve task-induced regressions and repeat the same verification.
- Never expose CDP externally, quit the user's app, globally close browsers or `pkill Electron`, delete a live lock, or print tokens.
- Missing OS, permissions, or signing credentials block only the affected lane. Mark it `[Unverified — requires <OS/permission>]`; do not infer its result from another lane.
- Report lanes/trust level, exact observations, commands/evidence, failure classification, cleanup, and unverified platforms. Use scratchpad temporary files and absolute worktree/binary paths.
