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
- Clear auto-open commissioning or What's New dialogs before asserting a no-modal shortcut path. First assert no visible `[aria-modal="true"]` remains.
- Create structural state through APIs or real UI actions. Do not seed store-managed collections in localStorage; hydration may overwrite them.
- Target destructive controls by article-scoped accessible name. WebGL can swallow loose hit tests; confirm selector accuracy before reporting a broken action.
- Windows ConPTY behavior must be tested on Windows. Record renderer, ConPTY toggle, resize stress, repeated frequency, page errors, and screenshots; mark it unverified elsewhere.

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
