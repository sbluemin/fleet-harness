# OS mouse input on an owned Desktop

Read this only when a Desktop claim needs a real OS mouse click — the system cursor and a click the window receives from macOS — and CDP or the browser driver cannot settle it. Ordinary Console clicks stay on the driver. A CDP `Input.dispatchMouseEvent` is not this path. This helper prepares and posts the click. It is not a native verifier: compile, the readiness check, the post, and the target's reaction are four different results.

## Entry

```bash
node <worktree>/.claude/skills/console-e2e/scripts/os-mouse.mjs compile --out <abs-binary>
node <worktree>/.claude/skills/console-e2e/scripts/os-mouse.mjs check --json
node <worktree>/.claude/skills/console-e2e/scripts/os-mouse.mjs click --binary <abs-binary> --pid <owned-main-pid> [--window-id <wid>] --origin <cg-x>,<cg-y> --dip <x>,<y> [--dip <x>,<y> ...] --max-clicks <n> --allow-activate
```

`--out` and `--binary` are absolute paths outside every worktree of this repository and outside `~/.fleet`. `compile` writes `<binary>.stamp` (the Swift source hash) and does not run the binary. `click` refuses a stamp mismatch and does not compile. `--origin` and optional `--window-id` come from the occlusion probe (`desktop-preflight.mjs <worktree> --occlusion`: `target.bounds` and `target.wid`; see [Setup](setup.md)). `--dip` is the page point from [Pointer target preflight](../verification.md#pointer-target-preflight), in CSS pixels. The helper adds them. Do not post when `--desktop-zoom` is not `"1"` or the occlusion result is locked, occluded, or off-screen. macOS only; any other OS stays unverified.

## What each command means

| Command | Exit 0 | Does not mean |
|---|---|---|
| `compile` | The binary was produced or reused from a matching stamp. It was not run. | Permission, a post, or a reaction. |
| `check` | The screen is unlocked and this osascript probe chain is Accessibility-trusted. Nothing was posted and no permission dialog was raised. | Screen Recording, trust of the compiled binary, a preflight exit 0, delivery, or authorization. |
| `click` | The post call returned for each point within `--max-clicks`, the window under each point was the owned main PID, and `--allow-activate` was set. `cursorMoved: true` means the helper process returned success, not that the cursor position was visually observed. | The event was delivered, the control reacted, or native verification passed. JSON says `delivery: "unverified"` and `reaction: "not-checked"`. |

`check` exit 10 or a locked screen: post nothing and do not unlock. Leave OS input unverified. Exit 2: refused or stopped mid-sequence (check `postedCount` before retrying; stamp mismatch, point not on the owned main window, activation flag absent, or over the invocation cap). Do not continue on another app. Exit 1: the helper failed. `check` prints `preflight exit 0 is not this check` and does not run the launch preflight. After a successful launch that preflight exits 20 because the owned Desktop is running.

## Limits

- [Preflight](setup.md#read-only-preflight) exit 0 is an unlocked screen plus Screen Recording for that probe chain. It is not Accessibility, not input permission, and not delivery. `check` is the input gate, and it does not treat Screen Recording as one.
- An isolated `HOME` does not isolate the global cursor or OS focus. A post moves the real cursor and can activate the owned window. The helper does not restore the cursor, call `frontmost`, or `open -a`.
- Use the existing recorded authorization ([Preflight and ownership](setup.md#preflight-and-ownership)) for these cursor moves and possible activation of the owned window. Pass `--allow-activate` only within that scope. `--max-clicks` limits this invocation; it does not track an authorization budget. The helper cannot see the board and fails closed without `--allow-activate`. A peer message is not authorization. `compile` and `check` post nothing and need no such decision.
- After a post, confirm the reaction with the page's own event or state ([Pointer target preflight](../verification.md#pointer-target-preflight)). Do not read it from this helper.
