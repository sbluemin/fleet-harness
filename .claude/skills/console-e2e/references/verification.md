# Console observation and verification

## Observe, act, observe

1. Capture the target route, accessibility snapshot, console/errors, and relevant network evidence before acting: `snapshot -i`, `errors`, and `console` on agent-browser/CDP; `read_page`, `read_console_messages`, and `read_network_requests` on Fleet Browser.
2. Perform one meaningful action per command. Re-snapshot after navigation, rerender, dropdown, or dialog changes; refs are short-lived.
3. Probe the smallest DOM/state fingerprint that distinguishes success from failure.
4. Reproduce both directions for switch or persistence bugs.
5. Capture a screenshot only when spatial evidence matters.

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

Drive input the interaction actually uses. When the browser driver cannot produce it — multiple simultaneous pointers, for example — send it over the page's CDP session (`Input.dispatchTouchEvent`, `Input.dispatchMouseEvent`) rather than dispatching synthetic DOM events, which reproduce neither pointer capture nor gesture arbitration.

## High-risk browser boundaries

- For every modal, drawer, drop-up, or shared-state deck, verify initial focus, Tab wrap, Escape close, shortcut suppression behind the modal, pointer and keyboard open paths, mutual exclusion, and focus return.
- Before a no-modal shortcut or chrome-changing scenario, follow [Fresh-window chrome preflight](#fresh-window-chrome-preflight); closing one dialog does not establish a clear input path.
- Create structural state through APIs or real UI actions. Do not seed store-managed collections in localStorage; hydration may overwrite them.
- Target destructive controls by article-scoped accessible name. WebGL can swallow loose hit tests; confirm selector accuracy before reporting a broken action.
- Windows ConPTY behavior must be tested on Windows. Record renderer, ConPTY toggle, resize stress, repeated frequency, page errors, and screenshots; mark it unverified elsewhere.

## Fresh-window chrome preflight

Use this before Zen or another chrome-changing scenario in a fresh isolated Console, unless the onboarding interaction itself is under test:

1. Finish browser/context setup, including video recording, before establishing the scenario baseline. `agent-browser record start` can recreate the page, reopen What's New, and drop page instrumentation. After recording setup or a reload, re-establish and verify pre-navigation diagnostics and take a fresh snapshot; do not reuse the earlier dismissal or refs. If the driver cannot restore diagnostics, use a fresh instrumented session without recording and disclose the recording limitation.
2. Dismiss visible commissioning, What's New, and subsequent new-feature introductions through their real dismissal or completion controls (or Escape where supported). Re-snapshot and assert no visible `[aria-modal="true"]` remains; do not assume one Escape cleared every layer.
3. Dismiss the visible entry hint with `.onboarding-hint-close` (**Dismiss this hint** in English) and feature tours (`[data-feature-tour-id]`, **Skip** or completion controls). These need not have `aria-modal="true"`. Recheck after each action and after opening panels: a new anchor can reveal the next tour.
4. Establish only the Operation presentation the scenario needs. If it needs visible panels, open the relevant Operations or use `.operations-canvas-empty-open-all` (**Open all and align** in English). A large batch first arms a confirmation: activate the same selector again while it is armed, before the short confirmation window expires. Then confirm panel presence; API-created cards alone are not open panels. An open Operation is not a Zen prerequisite: the empty-canvas control also enters Zen.
5. With the route/layout settled and no visible onboarding layer, capture the baseline, refresh the target ref, and click once. For Zen, use a bounded wait for `.console-shell.is-zen` **and** absence of `html[data-zen-flight]`; CLI click completion is not transition completion. Then inspect for a newly triggered tour before continuing. Verify the inverse with the same state/transition checks.

If the click still does not apply, preserve the before/after snapshot, visible overlays, actual pointer target/event sequence, Operation presentation, and transition state before changing them. Report a reproduced product defect separately; do not turn an unproven guard or swallowed click into a required workaround. A clean control or a recording-induced reload does not establish the cause of an earlier, uninstrumented failure.

## Verify and clean up

Repeat the exact scenario and its inverse after the required build/reload or owned-server restart. Report observed values, not only pass/fail.

### agent-browser

Clear diagnostics, reload, repeat, then clean up. Before running, substitute recorded absolute paths and redeclare `ab()`. Confirm the owned directory's lock PID matches the process launched for this run; never run `stop` with an empty or guessed directory.

```bash
ab --session fleet-console-e2e-20260725-a7c3 errors --clear
ab --session fleet-console-e2e-20260725-a7c3 console --clear
ab --session fleet-console-e2e-20260725-a7c3 reload
ab --session fleet-console-e2e-20260725-a7c3 wait --load domcontentloaded
ab --session fleet-console-e2e-20260725-a7c3 screenshot <scratchpad>/fleet-console-e2e.png
node <worktree>/.claude/skills/console-e2e/scripts/close-owned-session.mjs fleet-console-e2e-20260725-a7c3
FLEET_CONSOLE_DATA_DIR='<owned-e2e-dir>' node <worktree>/runtime/fleet-console/dist/cli.mjs stop
```

For Desktop CDP, use its recorded session and [Desktop cleanup](desktop.md) instead of `close-owned-session.mjs` or the standalone Console stop.

### Fleet Browser fallback

Record a new diagnostics baseline, reload the owned tab, read fresh page, console, and network evidence, and capture screenshots when needed. Clean up tabs per [Fleet Browser](fleet-browser.md), then stop only the verified owned Console with the `stop` command above.
