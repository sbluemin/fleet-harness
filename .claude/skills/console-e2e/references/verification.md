# Console observation and verification

## Observe, act, observe

1. Capture the target route, accessibility snapshot, console/errors, and relevant network evidence before acting: `snapshot -i`, `errors`, and `console` on agent-browser/CDP; `read_page`, `read_console_messages`, and `read_network_requests` on Fleet Browser.
2. Perform one meaningful action per command. Re-snapshot after navigation, rerender, dropdown, or dialog changes; refs are short-lived.
3. Probe the smallest DOM/state fingerprint that distinguishes success from failure.
4. Reproduce both directions for switch or persistence bugs.
5. Capture a screenshot only when spatial evidence matters.
6. After submitting input, compare each value you entered with what the screen then shows (the field, the list row, the detail view). A missing or altered value is a finding even when the action reported success.

For terminal failures, probe the render chain. On Fleet Browser run the inner read-only expression through `javascript_tool`. `window.__fleetE2E` exists only when init instrumentation was installed; its absence is not a clean diagnostics result:

```bash
cat <<'EOF' | ab --session fleet-console-e2e-20260725-a7c3 eval --stdin
(() => {
  const q = s => document.querySelector(s);
  const canvas = q('.terminal-canvas');
  return {
    shell: !!q('.console-shell'),
    stage: !!q('.operations-terminal-stage'),
    terminalSize: q('.terminal-stage') ? [q('.terminal-stage').offsetWidth, q('.terminal-stage').offsetHeight] : null,
    xterm: !!canvas?.querySelector('.xterm'),
    canvasCount: canvas?.querySelectorAll('canvas').length || 0,
    appLength: (q('#app') || document.body).innerHTML.length,
    e2e: window.__fleetE2E,
  };
})()
EOF
```

Interpret evidence in this order: page errors/rejections, DOM presence and size, WebSocket churn, console/network symptoms, screenshot. A missing React tree, zero-sized layout, absent xterm, and closed-socket flood are different failures.

## Pointer target preflight

Before real pointer input, especially near rails, captions, floating panels, or overlays, establish that the intended control receives the planned coordinate:

1. Confirm the actual viewport and scroll position, visible overlays, and settled layout with a fresh snapshot and screenshot when spatial evidence matters. Use [Fresh-window chrome preflight](#fresh-window-chrome-preflight) when applicable. Do not reuse coordinates after scrolling, resizing, rerendering, or a transition.
2. Resolve the current target and inspect its center with `elementFromPoint` in the same document and viewport coordinate system as `getBoundingClientRect`. For example, with `target` set to the intended control:

   ```js
   const r = target.getBoundingClientRect();
   const x = r.left + r.width / 2;
   const y = r.top + r.height / 2;
   const inViewport = r.width > 0 && r.height > 0 &&
     x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
   const hit = inViewport ? document.elementFromPoint(x, y) : null;
   ({
     viewport: [innerWidth, innerHeight], scroll: [scrollX, scrollY],
     rect: { x: r.x, y: r.y, width: r.width, height: r.height },
     point: [x, y], inViewport,
     hit: hit && { tag: hit.tagName, id: hit.id, class: hit.getAttribute('class') },
     reachesTarget: !!hit && (hit === target || target.contains(hit)),
   });
   ```

3. If the center is outside the viewport, the hit is null, or another control/overlay receives it, **do not click or attribute the result to the intended control**. Preserve the target/occluder evidence first. Resolve expected obstruction only through supported UI actions, or scroll the target into view, then refresh the snapshot and repeat the hit-test. Do not remove overlays, force-click, or use DOM `.click()` to bypass them. If testing a visible non-center point, record and hit-test that exact point too; do not silently substitute it for a center-click claim. Unexpected obstruction may be a product defect, not a required workaround.
4. Send real pointer input at the checked point using the selected driver and inspect the resulting target/event and state. If the driver's click chooses a different coordinate, check that coordinate instead. A passing hit-test is a precondition, not proof of a usable click, focus, or completed transition; synthetic DOM activation remains handler-diagnosis evidence only.

## Event contracts: record the sequence before changing code

When a fix turns on **which** event fires, in what order, or at which target, log the real sequence first. The specification and the engine disagree often enough that a listener placed by reasoning can silently never run, and the symptom — nothing happens — looks identical to a wrong fix. Record type, pointer id, and coordinate, install in the capture phase so nothing is missed, and read the order rather than the outcome:

```js
window.__ev = [];
const rec = (name) => (event) => window.__ev.push(`${name}#${event.pointerId}@${Math.round(event.clientX)}`);
for (const name of ["pointerdown", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture"]) {
  window.addEventListener(name, rec(name), true);
}
document.addEventListener("lostpointercapture", rec("doc-lost"), false);
```

For example, Chromium fires `lostpointercapture` at the **document**, not at the element that held capture, and defers it to the next pointer event; it also ends the first touch pointer the instant a second finger lands, so a terminal event that looks like another pointer's carries the drag's own id.

Drive input the interaction actually uses. When the browser driver cannot produce it — multiple simultaneous pointers, for example — send it over the page's CDP session (`Input.dispatchTouchEvent`, `Input.dispatchMouseEvent`) rather than dispatching synthetic DOM events, which reproduce neither pointer capture nor gesture arbitration. A touch-device claim (`pointer: coarse`, `hover: none`, touch detection) also needs that emulation held for the whole scenario and confirmed after every reload and resize: use the [coarse pointer and touch holder](cdp-input.md#coarse-pointer-and-touch-holder). A key-specific claim uses the [single-key helper](cdp-input.md#one-key-press).

## Compare against an approved mock

When the work implements an adopted proposal or mock, capture the mock and the built screen at the same viewport and theme and compare them region by region: header and footer, dividers and borders, and the colors of neighboring columns. A single full-page glance misses these edges. Report each region's result, not one overall verdict.

## Plan activation paths by starting state

Before measuring an activation flow, including non-modal surfaces, list its starting states and target control. For each state, check whether another surface covers the target or blocks pointer input; record the covering surface and starting focus. Use a screenshot and [Pointer target preflight](#pointer-target-preflight) to plan and verify each pointer route.

- Verify pointer and keyboard activation paths where available. Keep the requested starting state intact: closing a covering surface or moving a panel creates a separate control case, not evidence for the covered state.
- When pointer input cannot reach the target, measure through an available user path such as Tab/Shift+Tab followed by Enter or Space as supported. Record the focus origin and actual keys; a terminal may consume Tab. If no supported path reaches the target, report the block rather than forcing activation.
- `:focus-visible` follows the last input modality. After a mouse click, a modifier shortcut such as ⌘B does not switch the page to keyboard mode, so a focus-ring defect that needs keyboard mode stays hidden. When the claim depends on it, first press a non-modifier key such as Tab, confirm `document.activeElement.matches(':focus-visible')`, then send the shortcut; run the click-then-shortcut sequence as its own case when the user reported it.
- Programmatic `focus()` followed by a key is supporting activation-handler evidence only, not proof of normal keyboard reachability or visible focus. Do not remove `inert`, disabled state, focus traps, or pointer blocking to make the scenario pass.
- Report what each route proves, what remains unverified, and what is not applicable. Keyboard activation can establish the resulting reveal or surface reuse, but not the covered control's pointer handler or hit testing. Mark pointer access not applicable only when intentional blocking is supported by design or implementation evidence; separate that intent judgment from observed behavior and record any untested handler separately. Report observed failures, such as focus hidden behind a covering surface, with their evidence rather than as unverified; judge separately whether they are product defects.

## Narrow viewports use the mobile layout

The browser Console picks its layout from the viewport width, so a phone-width run such as `set viewport 390 844` never reaches the desktop canvas, rail, or chips. `initializeViewportQueries` in `core/client/src/integration/view-mode-store.ts` switches to mobile at `max-width: 767px` and back to desktop at `min-width: 832px`. Between the two widths the previous layout stays, and a page first opened there starts on desktop. A stored `fleet-console.view-mode.preference` of `mobile` or `desktop` overrides the width on that origin, and an Electron renderer is always desktop. Before measuring at a narrow width, confirm which layout rendered, for example from `html[data-view-mode="mobile"]`, rather than inferring it from the width. The mobile layout also carries its own color mode as `html[data-mobile-scheme]` (`dark` or `light`), independent of the desktop Console theme.

In the mobile layout there are no bottom tabs. The top bar's menu button opens a drawer that lists the destinations (**Theater**, plugin destinations such as **Objectives**, **Files**, **Wiki**, and **Shell**, then **Archive**, **Plugins**, and **Settings**), the items that need attention, and recent Operations of the current Theater; the drawer's pill starts a new task. Settings is its own route, and screens and sheets close through the browser back stack. When a desktop selector returns null at a narrow width, the panel has a different entry path in this layout. That alone is not a product finding.

## Lifecycle, network, and storage changes

Use this only when the change touches state lifetime, a connection or retry path, or durable storage. Choose the representative inputs that exercise the changed mechanism, not a matrix of every state:

- **State lifetime:** trace one instance through creation, change, restore after reload or restart, and teardown (close, delete, archive, process exit). For each step, name the event the code actually waits on; a delay or `await` may also be covering a process exit or a late callback, so find what it resolves on before removing or relying on it.
- **Connections:** inject the failure the path claims to handle — a silent hang (no bytes, no close), an early close, and two failures at once — and note that independent timers or backoffs run out of phase. CDP offline emulation does not drop an already-open EventSource or WebSocket; fail the stream at its source or through the page hook and confirm in the instrumentation that it actually closed.
- **Moved records:** when a record or log is rendered by a different component than before, exercise the first page edge, a page boundary, and an entry cut off by it (a turn still in progress, a truncated input), not only a complete history. Compare the same entry before and after.
- **Durable state:** build fixtures through the current reader and writer, or from a fresh owned runtime, so files that must agree (for example state and its archive or revision) are written together. A guard that refuses an inconsistent pair is product behavior to report, not something to bypass with a fresh directory, a deleted archive, or a relaxed check. When restart or restore is the claim, a new slot is not an equivalent verification.

Report which of these inputs ran and which remain unverified. Promote one into the permanent suite only through the root test admission policy.

## High-risk browser boundaries

- For every modal, drawer, drop-up, or shared-state deck, verify initial focus, Tab wrap, Escape close, shortcut suppression behind the modal, [activation paths by starting state](#plan-activation-paths-by-starting-state), mutual exclusion, and focus return.
- Before a no-modal shortcut or chrome-changing scenario, follow [Fresh-window chrome preflight](#fresh-window-chrome-preflight); closing one dialog does not establish a clear input path.
- Create structural state through APIs or real UI actions. Do not seed store-managed collections in localStorage; hydration may overwrite them.
- Target destructive controls by article-scoped accessible name. WebGL can swallow loose hit tests; confirm selector accuracy before reporting a broken action.
- Windows ConPTY behavior must be tested on Windows. Record renderer, ConPTY toggle, resize stress, repeated frequency, page errors, and screenshots; mark it unverified elsewhere.

## Fresh-window chrome preflight

Use this before Zen or another chrome-changing scenario in a fresh isolated Console, unless the onboarding interaction itself is under test:

1. Finish browser/context setup, including video recording, before establishing the scenario baseline. `agent-browser record start` can recreate the page, reopen What's New, and drop page instrumentation. After recording setup or a reload, re-establish and verify pre-navigation diagnostics and take a fresh snapshot; do not reuse the earlier dismissal or refs. If the driver cannot restore diagnostics, use a fresh instrumented session without recording and disclose the recording limitation.
2. Seed onboarding before the first navigation through the [setup onboarding seed](setup.md#first-load-onboarding-state); do not dismiss seeded layers through the UI. Assert no visible `[aria-modal="true"]`, `[data-feature-tour-id]`, or `.onboarding-hint-close` remains, and recheck after opening panels.
3. A layer that still appears after seeding is a finding: record which one and its key gap before dismissing it through its real control (**Skip**, **Dismiss this hint**, or Escape where supported).
4. Establish only the Operation presentation the scenario needs. If it needs visible panels, open the relevant Operations or use `.operations-canvas-empty-open-all` (**Open all and align** in English). A large batch first arms a confirmation: activate the same selector again while it is armed, before the short confirmation window expires. Then confirm panel presence; API-created cards alone are not open panels. An open Operation is not a Zen prerequisite: the empty-canvas control also enters Zen.
5. With the route/layout settled and no visible onboarding layer, capture the baseline, refresh the target ref, and click once. For Zen, use a bounded wait for `.console-shell.is-zen` **and** absence of `html[data-zen-flight]`; CLI click completion is not transition completion. Then inspect for a newly triggered tour before continuing. Verify the inverse with the same state/transition checks.

If the click still does not apply, preserve the before/after snapshot, visible overlays, actual pointer target/event sequence, Operation presentation, and transition state before changing them. Report a reproduced product defect separately; do not turn an unproven guard or swallowed click into a required workaround. A clean control or a recording-induced reload does not establish the cause of an earlier, uninstrumented failure.

## Verify and clean up

Repeat the exact scenario and its inverse after the required build/reload or owned-server restart. Report observed values, not only pass/fail.

### agent-browser

Clear diagnostics, reload, repeat, then clean up. Before running, substitute recorded absolute paths and redeclare `ab()`. Confirm the owned directory's lock PID matches the process launched for this run; never run `stop` with an empty or guessed directory, and pass the same `--run-dir` that started the server.

```bash
ab --session fleet-console-e2e-20260725-a7c3 errors --clear
ab --session fleet-console-e2e-20260725-a7c3 console --clear
ab --session fleet-console-e2e-20260725-a7c3 reload
ab --session fleet-console-e2e-20260725-a7c3 wait --load domcontentloaded
ab --session fleet-console-e2e-20260725-a7c3 screenshot <scratchpad>/fleet-console-e2e.png
node <worktree>/.claude/skills/console-e2e/scripts/close-owned-session.mjs fleet-console-e2e-20260725-a7c3
node <worktree>/.claude/skills/console-e2e/scripts/isolated-env.mjs --run-dir '<owned-run>' -- node <worktree>/runtime/fleet-console/dist/cli.mjs stop
```

For Desktop CDP, close the recorded session with the same `close-owned-session.mjs`, then stop the app through [Desktop cleanup](desktop.md) instead of the standalone Console `stop`.

### Fleet Browser fallback

Record a new diagnostics baseline, reload the owned tab, read fresh page, console, and network evidence, and capture screenshots when needed. Clean up tabs per [Fleet Browser](fleet-browser.md), then stop only the verified owned Console with the `stop` command above.
