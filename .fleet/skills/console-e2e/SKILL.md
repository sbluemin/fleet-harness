---
name: console-e2e
description: Drive a real-browser end-to-end test or bug diagnosis of the fleet-console web UI through the playwriter skill — open /console/operations, attach console/pageerror/WebSocket listeners, drive interactions (workspace-session switch, terminal render), and inspect DOM/console/network/screenshot to reproduce bugs and verify fixes. Use whenever a fleet-console issue is runtime/visual (blank screen, terminal not rendering, layout breakage) and cannot be settled by unit tests alone, or to confirm a console fix in the actual browser.
---

# Fleet Console E2E (real browser)

Drive and inspect the **fleet-console** React SPA in the user's real Chrome via the `playwriter` skill. Unit tests (`vitest`) cover the reducer/store/server but **cannot** reproduce xterm/WebGL/CSS/React-lifecycle behavior — that needs a real browser. This skill is the repeatable procedure for reproducing a runtime bug, finding its root cause through DOM/console/network channels, and verifying the fix.

This skill **depends on the `playwriter` skill**. Read its full docs first (`playwriter skill`, no truncation) — it owns session/selector/timeout rules. This skill only adds the fleet-console-specific procedure on top.

## When to use

- Runtime/visual fleet-console bugs: blank screen, terminal not rendering, session switch breakage, layout/height collapse, font/CSP issues.
- Verifying a console fix end-to-end after `build` (the decisive proof, beyond typecheck/test).
- NOT for backend-only logic already covered by `vitest` — run the unit suite instead.

## Inputs

Replace each `<placeholder>` before running. Optional inputs default as noted.

- `<port>` — console loopback port. Required. Find it from the URL the user gives, or `fleet-console status`, or `lsof -nP -iTCP -sTCP:LISTEN | grep node`.
- `<route>` — `/console/operations` (terminal + sidebar) or `/console/` (Welcome). Default `/console/operations`.
- `<scenario>` — the interaction to drive (e.g., "switch between two terminal-only sessions"). Required for a bug repro.
- `<symptom>` — observable failure to reproduce (e.g., "terminal area goes blank, needs refresh"). Optional but recommended.

## Prerequisites (confirm first)

1. **Console is running and serving**: `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<port>/console/operations` → expect `200`. If not, start it (`pnpm fleet-console` from repo root, or `fleet-console start`).
2. **Reflecting your code?** The console serves **static `dist/client/`** (`Cache-Control: no-store`), so a client change needs `pnpm --filter @dotobokuri/fleet-console build` + a browser **reload** (no server restart). A **backend** change (`src/**` — server, security headers, terminal transport) needs `build` **and a server restart** to take effect. Confirm the served bundle matches your build: compare `grep -o 'assets/index-[A-Za-z0-9_-]*\.js' dist/client/index.html` against `curl -s http://127.0.0.1:<port>/console/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'`.
3. **playwriter is available** and Chrome is running. Create a session; if multiple Chrome profiles are detected, re-run with `--browser <key>` (any profile works — console session state lives in the backend and is profile-independent).

## Workflow

### Phase 1 — Session + instrumented page

The single most important step: attach your **own** listeners **before** `goto`, because playwriter's built-in `getLatestLogs` may return nothing for `pageerror`. `state.logs` (your array) is what actually captures the uncaught exceptions that blank the screen.

```bash
playwriter session new            # → note the id; if multi-profile: playwriter session new --browser <key>
```

```bash
playwriter -s <id> -e "$(cat <<'EOF'
const pages = context.pages();
state.page = pages.find(p => p.url().includes('127.0.0.1:<port>')) ?? pages.find(p => p.url() === 'about:blank') ?? await context.newPage();
state.logs = [];
state.sockets = [];
state.page.removeAllListeners('console');
state.page.removeAllListeners('pageerror');
state.page.removeAllListeners('websocket');
state.page.on('console', m => state.logs.push("[" + m.type() + "] " + m.text()));
state.page.on('pageerror', e => state.logs.push("[pageerror] " + e.message + "\n" + (e.stack || '(no stack)')));
state.page.on('websocket', ws => { const r = { url: ws.url(), closed: false }; state.sockets.push(r); ws.on('close', () => { r.closed = true; }); });
await state.page.goto('http://127.0.0.1:<port><route>', { waitUntil: 'domcontentloaded' });
await waitForPageLoad({ page: state.page, timeout: 6000 });
console.log('url:', state.page.url());
EOF
)"
```

### Phase 2 — Observe the entry state

- Snapshot the sidebar to read the workspace/session list and pick targets:
  `playwriter -s <id> -e 'await snapshot({ locator: state.page.locator(".sidebar") }).then(console.log)'`
- Session rows are `.session-row` buttons; terminal-only sessions show status text `terminal-only`. **At least 2 sessions are needed to test switching.**
- **The `+` (Add workspace) button opens an OS-native folder dialog** — it is NOT controllable from the browser. Do not try to create sessions via playwriter; rely on sessions the user already created.

### Phase 3 — Drive the interaction (observe → act → observe)

One action per call; re-observe after each. Example for the canonical "switch terminal sessions" scenario:

```bash
playwriter -s <id> -e "$(cat <<'EOF'
await state.page.locator('.session-row').nth(0).click();
await state.page.waitForTimeout(1600);
const probe = () => state.page.evaluate(() => {
  const q = s => document.querySelector(s); const box = e => e ? [e.offsetWidth, e.offsetHeight] : null;
  const canvas = q('.terminal-canvas'); const xterm = canvas ? canvas.querySelector('.xterm') : null;
  return {
    consoleShell: !!q('.console-shell'), sidebar: !!q('.sidebar'),
    opStage: !!q('.operations-terminal-stage'), terminalStage: box(q('.terminal-stage')),
    hasXterm: !!xterm, canvasCount: canvas ? canvas.querySelectorAll('canvas').length : 0,
    appLen: (q('#app') || document.body).innerHTML.length,   // ~0 ⇒ React tree unmounted (blank screen)
  };
});
console.log('A:', JSON.stringify(await probe()));
await state.page.locator('.session-row').nth(1).click();
await state.page.waitForTimeout(2200);
console.log('B:', JSON.stringify(await probe()));
console.log('pageerrors:', JSON.stringify(state.logs.filter(l => l.startsWith('[pageerror]'))));
console.log('sockets:', JSON.stringify(state.sockets.map(s => s.closed)));
EOF
)"
```

Healthy terminal: `opStage:true`, `hasXterm:true`, `canvasCount:3` (xterm renders 3 canvas layers), `terminalStage` non-zero, `appLen` in the thousands. **Blank screen fingerprint: `appLen` near 0 and `opStage/sidebar` false** — the whole React tree unmounted.

### Phase 4 — Diagnose the root cause

Combine channels; do not guess. The decisive ones, in order:

1. **`state.logs` pageerrors + stack** — a `[pageerror]` with a stack is almost always why the tree unmounted (an uncaught exception in render/effect/cleanup with no error boundary unmounts everything). Read the stack frames top-down to find the throwing function. Minified frames still reveal the call chain (e.g. `AddonManager.dispose` → `WebglAddon.dispose` pinpoints an xterm dispose bug, not your code).
2. **DOM probe** — sizes/children of `.operations-terminal-stage` → `.terminal-stage` → `.terminal-shell` → `.terminal-canvas` and its `.xterm`/`canvas` children. Distinguishes "tree gone" (all absent) vs "rendered but 0×0" (CSS height collapse) vs "rendered fine".
3. **WebSocket** — `state.sockets`: terminal connects via `ws://…/terminal/ws?ticket=…`. `closed` flags show whether the old session's socket closed and a new one opened on switch. A flood of closed sockets ⇒ reconnect loop.
4. **`getStylesForLocator`** (playwriter) for CSS height/layout questions; **`screenshotWithAccessibilityLabels`** only when spatial layout matters.

### Phase 5 — Verify the fix

After editing client code: `pnpm --filter @dotobokuri/fleet-console typecheck && build`, then in the same playwriter session **reset listeners + reload** and re-run the scenario:

```bash
playwriter -s <id> -e "$(cat <<'EOF'
state.logs = []; state.sockets = [];
state.page.removeAllListeners('pageerror'); state.page.removeAllListeners('websocket');
state.page.on('pageerror', e => state.logs.push("[pageerror] " + e.message));
state.page.on('websocket', ws => { const r = { closed: false }; state.sockets.push(r); ws.on('close', () => { r.closed = true; }); });
await state.page.reload({ waitUntil: 'domcontentloaded' });
await waitForPageLoad({ page: state.page, timeout: 6000 });
EOF
)"
```

Re-drive Phase 3 (ideally **both directions** for a switch bug: A→B→A). The fix passes when the failure fingerprint is gone (`appLen` healthy, target pageerror count `0`). Capture proof:

```bash
playwriter -s <id> -e "$(cat <<'EOF'
await state.page.screenshot({ path: '/tmp/console-e2e.png', scale: 'css' });
await resizeImageForAgent({ input: '/tmp/console-e2e.png', maxDimension: 1100 });
EOF
)"
```

Bash cannot display the image — read it back with the Read tool (`/tmp/console-e2e.png`).

For a **backend** header/CSP fix, also verify the raw response after a server restart: `curl -s -I http://127.0.0.1:<port>/console/ | grep -i content-security-policy` (and confirm the offending console error is gone in `state.logs` after reload).

## Fleet-console specifics (gotchas)

- **Static-serve reflection**: client changes need `build` + reload; backend (`src/**`) changes need `build` + **server restart**. A "fix that didn't work" is often just an unrestarted server or a stale bundle — verify the served `index-*.js` hash matches `dist` before re-debugging.
- **Auth/route**: when the console runs loopback-only without a browser token gate, `/console/operations` renders directly. If a token handoff is in force, the launcher passes tokens once via the URL **fragment** (never a query string) — never inject tokens into query strings or logs.
- **Sessions are backend-shared**: any Chrome profile observes the same registered sessions; profile choice doesn't change what you see.
- **Folder picker is OS-native**: cannot be automated; reuse existing sessions for switch tests.
- **Terminal stack**: xterm.js + `@xterm/addon-webgl` (WebGL renderer, DOM fallback). A healthy `.terminal-canvas` holds 3 `canvas` layers. Watch for WebGL `context lost` and dispose-time exceptions on unmount.

## Safety rules

- **Never** `browser.close()` / `context.close()`, and never close the user's tabs. Reuse `state.page`; recreate only if `state.page.isClosed()`.
- **Never** `bringToFront` unless asked — you can drive background tabs.
- Clean up listeners at the end of a run: `state.page.removeAllListeners()`.
- Do not write fixes from this skill blindly — diagnose with evidence (stack + DOM + network), then edit, then re-verify here.
- The screenshot/artifact paths must be absolute (e.g. `/tmp/...`).
