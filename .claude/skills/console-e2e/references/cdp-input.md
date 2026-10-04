# Exact CDP input: one key, coarse pointer and touch

Use this when a claim depends on one real key press (Escape closing a surface, an Alt or ⌘ shortcut) or on a touch device's pointer/hover media and touch input. [`scripts/cdp-input.mjs`](../scripts/cdp-input.mjs) attaches to the owned page over CDP; it never activates a window or tab (the client itself refuses `Page.bringToFront`, `Target.activateTarget`, and `Browser.setWindowBounds`). Exit 1 always means the helper failed, never a page result.

Both modes need the owned browser's endpoint and a URL prefix that matches exactly one page target. For an agent-browser session, read the endpoint in its own bounded call and pass it on; it is a loopback debugging URL, so keep it in the scratchpad rather than in a report. For Desktop, pass the owned `<cdp-port>`.

```bash
ab --session fleet-console-e2e-20260725-a7c3 get cdp-url > <scratchpad>/fleet-console-e2e-cdp.txt
```

`--url-prefix "http://127.0.0.1:<port>/console/"` selects the Console page; a popup or native Browser view does not match it. Output names the target by origin and path only.

## One key press

```bash
node <worktree>/.claude/skills/console-e2e/scripts/cdp-input.mjs key \
  --cdp "$(cat <scratchpad>/fleet-console-e2e-cdp.txt)" --url-prefix "http://127.0.0.1:<port>/console/" \
  --key Escape [--modifiers Alt,Control,Meta,Shift] [--settle-ms 500] [--emulate-focus]
```

- It sends exactly one `Input.dispatchKeyEvent` keyDown/keyUp pair. Modifiers are flags on that pair (`event.altKey` and so on); no separate modifier keydown is sent. To press a modifier itself, pass it as the key (`--key Alt --modifiers Alt`). Keys are named keys (Escape, Enter, Tab, Backspace, Delete, Space, arrows, Home/End, PageUp/PageDown, F1–F12, Alt/Control/Meta/Shift) or one ASCII letter, digit, or punctuation mark. A printable key without Alt/Control/Meta also inserts its text.
- Before sending, it installs a capture-phase `keydown`/`keyup`/`keypress` counter on the page's main-frame `window`. It also temporarily wraps `Event.prototype.stopPropagation` and `stopImmediatePropagation`, because Console's global shortcuts listen earlier on the same window capture phase and swallow ⌘K and similar chords before a later listener runs. An event seen by either path counts once. When a page handler stopped it, the event is also counted in `consumedByPage`, and its sample shows `via`. Both are removed after `--settle-ms`. The JSON line reports `before` (`document.hasFocus()`, `visibilityState`, and the active element), `observed` counts with the first samples (key, code, `repeat`, `isTrusted`, modifiers, target tag, `via`), and `verdict`. Exit 0 means `exact`, with one keydown and one keyup; exit 2 means `flood` or `mismatch`.
- Focus the intended control through the real UI first and check `before.activeElement`. Keys typed into an iframe, such as a plugin pane or Browser view, are not counted by the main-frame counter. A key that navigates or reloads the page loses the counter and is reported as a mismatch. `--emulate-focus` holds `Emulation.setFocusEmulationEnabled` only for this call; use it when `before.hasFocus` is false in a headed run.
- A Desktop native Browser view relays registered Console shortcuts from its own `before-input-event` to Console with `sendInputEvent` (`runtime/fleet-desktop/src/browser-views.ts`). In one isolated Desktop run (objective 8c2005d2, mission 3 record `m3-desktop.md`), CDP `Input.dispatchKeyEvent` sent to that view reached the view page while Console did not react, which indicates that CDP input bypasses `before-input-event`; the relay fired only from a main-process `sendInputEvent` with focus emulation held on both pages. This helper therefore leaves the relay unverified. A main-process input step is outside the read-only [main inspector lane](desktop/native-and-package.md#main-inspector-observation-lane) and needs the user's authorization for that input and for the focus the relay itself takes.
- Pair it with the scenario's own state check, for example that the dialog closed and focus returned. An exact count shows that one trusted key event reached the page. It does not show that the key had the expected effect.

Why not `press`: on macOS, agent-browser 0.27.0 `press Escape` flooded thousands of `key: "Unidentified", code: "Minus"` keydowns that kept arriving after the command returned. A raw CDP pair that also set `nativeVirtualKeyCode: 27` reproduced the flood. macOS reads that field as a mac key code, and 27 is `kVK_ANSI_Minus`. Sending the pair without it produced exactly one event, so the helper omits the field. Once a session has flooded, it stays contaminated: follow [stuck input](agent-browser.md#bound-commands-and-recover-stuck-input) and use a fresh session.

## Coarse pointer and touch holder

CDP emulation overrides belong to the session that set them, and they are cleared the moment that session detaches. A one-shot script that sets `pointer: coarse` and then exits leaves the page fine-pointer again. Earlier runs lost this state and restarted sessions repeatedly because of it. Keep one holder alive for the whole scenario:

```bash
node <worktree>/.claude/skills/console-e2e/scripts/cdp-input.mjs hold \
  --cdp "$(cat <scratchpad>/fleet-console-e2e-cdp.txt)" --url-prefix "http://127.0.0.1:<port>/console/" \
  --log <scratchpad>/fleet-console-e2e-coarse.jsonl [--interval-ms 500] [--max-minutes 60]
```

1. Start it as a background/managed process with a finite tool deadline longer than `--max-minutes`. It applies `Emulation.setTouchEmulationEnabled` (5 touch points), `Emulation.setEmitTouchEventsForMouse` (`mobile`), and `Emulation.setEmulatedMedia` features `pointer: coarse`, `hover: none`, `any-pointer: coarse`, and `any-hover: none`. It then writes a `ready` line with its `pid` and the page state. Record that PID.
2. Reload the page once through the driver after `ready`. `'ontouchstart' in window` and the code that detects touch at startup only see emulation from a document created after it was applied. The media queries switch at once.
3. Confirm with the read-only probe, which uses its own short session and changes nothing:

   ```bash
   node <worktree>/.claude/skills/console-e2e/scripts/cdp-input.mjs probe \
     --cdp "$(cat <scratchpad>/fleet-console-e2e-cdp.txt)" --url-prefix "http://127.0.0.1:<port>/console/"
   ```

   Exit 0 and `held: true` require `matchMedia('(pointer: coarse)')`, `(hover: none)`, and `navigator.maxTouchPoints > 0`. The state also reports `pointerFine`, the `any-*` queries, `touchEvents`, and the viewport. Run the probe after every reload, resize (`set viewport`), and route change that the scenario performs, and once just before and once just after the input under test. An `eval` of `matchMedia('(pointer: coarse)').matches` in the agent-browser session is an equivalent spot check.
4. Read the log before using a result. The holder re-checks every interval. When another client resets the state, it re-applies the overrides and logs `reapplied` with the state it found. A `reapplied` event between the probes that bracket an input means that input may have run without coarse emulation, so repeat that step. `load` events record the state after each page load. `detached`, `target-destroyed`, or `cdp-closed` mean the holder lost the page, and the overrides are gone.
5. Stop it on every exit path with `kill -TERM <recorded pid>`, or stop the managed task, before closing the browser session. It logs `stopped` and detaches, and the media queries and `maxTouchPoints` return to the fine pointer at once. `'ontouchstart' in window` stays true until the next reload, so reload before a fine-pointer control case. It also stops by itself at `--max-minutes`.

With agent-browser 0.27.0 on a headless page, the holder's state survived `reload`, `set viewport 390 844`, `set media light`, and `set device "iPhone 14"`, and `set device` by itself did not produce `pointer: coarse`. Another CDP client that disabled touch emulation did reset it, and the holder re-applied it within one interval. Recheck these facts when the driver changes.

Touch emulation changes what the page believes about the device. It does not turn the driver's mouse commands into proof of touch handling. For a touch gesture, send `Input.dispatchTouchEvent` at a [preflighted point](verification.md#pointer-target-preflight) over a CDP session, and record the event sequence ([Event contracts](verification.md#event-contracts-record-the-sequence-before-changing-code)). A real device's hardware, OS gestures, and on-screen keyboard remain unverified in emulation.
