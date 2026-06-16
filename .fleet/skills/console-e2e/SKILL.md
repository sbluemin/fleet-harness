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

- `<port>` — console loopback port. Required. Find it from the URL the user gives, or `fleet-console status`, or `lsof -nP -iTCP -sTCP:LISTEN | grep node`. For an **isolated instance** (see Prerequisites #1), read it from `<FLEET_CONSOLE_DIR>/console.lock`.
- `<route>` — `/console/operations` (terminal + sidebar) or `/console/` (Welcome). Default `/console/operations`.
- `<scenario>` — the interaction to drive (e.g., "switch between two terminal-only sessions"). Required for a bug repro.
- `<symptom>` — observable failure to reproduce (e.g., "terminal area goes blank, needs refresh"). Optional but recommended.

## Prerequisites (confirm first)

1. **Console is running and serving**: `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<port>/console/operations` → expect `200`. If not, start it (`pnpm fleet-console` from repo root, or `fleet-console start`).
   - **Testing your own build? Isolate it — do NOT reuse or restart the user's daemon.** `fleet-console start` is a singleton per runtime dir: if a healthy daemon already exists it just **opens that daemon**, so it serves the *user's* running bundle, not your freshly-built one, and you would silently test the wrong code. To verify YOUR build (e.g. a worktree) without disturbing the user's daemon, launch a throwaway isolated instance with its own runtime dir + port:
     ```bash
     pnpm --filter @dotobokuri/fleet-console build                       # build the bundle you want to test
     FLEET_CONSOLE_DIR=/tmp/fleet-console-e2e node runtime/fleet-console/dist/cli.mjs start
     PORT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/fleet-console-e2e/console.lock')).port)")
     ```
     `FLEET_CONSOLE_DIR` gives the instance its own lock + OS-assigned random port — read both from `<dir>/console.lock` — fully separate from the user's daemon. **Confirm it serves your bundle** (the hash check in Prerequisite #2) before driving, then `FLEET_CONSOLE_DIR=/tmp/fleet-console-e2e node runtime/fleet-console/dist/cli.mjs stop` when done. **Never `stop`/`restart` the user's shared daemon just to test your build — isolate instead.**
   - **Seeding sessions without the OS folder picker.** A fresh isolated instance has no sessions, and the `+` Add-Theater button is an OS-native folder dialog that cannot be automated. The `console.lock` carries a bearer `token`; use it to create sessions through the authorized API instead: `curl -X POST -H "Authorization: Bearer <token>" -H "Origin: http://127.0.0.1:<port>" -H "Content-Type: application/json" -d '{}' http://127.0.0.1:<port>/observer/theaters/<theaterId>/sessions` (optional `cliId` in the body; omitting it uses the default Agent CLI, which spawns a real CLI child process). List Theaters first with `GET /observer/theaters` (unauthenticated, loopback) — an isolated instance may already surface previously-registered Theaters, but registering a *new* Theater still requires the OS picker. Clean up seeded sessions with `DELETE /terminal/sessions/<id>` (authorized) or just `stop` the instance.
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
- **The `+` (Add workspace) button opens an OS-native folder dialog** — it is NOT controllable from the browser. Do not try to create sessions via playwriter; rely on sessions the user already created, or seed them through the authorized API (see Prerequisites #1).

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

### Scenario — Windows ConPTY 깨짐 A/B 검증

#### 배경

Windows CMD/PowerShell에서 드물게 발생하던 터미널 깨짐은 OS conhost ConPTY의 재생성(render→diff) 모델과 문자폭/리사이즈 엣지 조건에서 비롯된다. 이를 (①) 번들 신형 ConPTY DLL, (②) 리사이즈 디바운스+refresh, (③) Unicode11 폭 정합, (④) WebGL/DOM 렌더러 토글의 네 가지 개선으로 완화하였으며, 이 시나리오는 그 효과를 A/B 실측으로 비교한다.

> **Windows 호스트 전용**: ConPTY 경로의 차이는 Windows에서만 나타난다. macOS/Linux 호스트에서는 이 시나리오를 실행해도 의미 있는 차이를 관측할 수 없다.

#### 토글 계약

두 가지 독립 토글로 A/B 축을 구성한다.

**useConptyDll** — 환경변수 `FLEET_USE_CONPTY_DLL`

- Windows에서 기본 ON(번들 ConPTY DLL 사용).
- `FLEET_USE_CONPTY_DLL=0`(또는 `false`)으로 끄고 재기동하면 OS conhost ConPTY로 대조할 수 있다.
- 백엔드 변경이므로 콘솔 서버 **재기동** 필요 — Prerequisites의 static-serve/재기동 규칙 참조. 재기동 후 번들 해시가 바뀔 수 있으므로 Phase 1을 다시 수행해 새 URL로 `goto`한다.

```powershell
# A 상태 (기본): FLEET_USE_CONPTY_DLL 환경변수 미설정 또는 1
# B 상태 (대조):
$env:FLEET_USE_CONPTY_DLL = "0"
pnpm fleet-console          # 서버 재기동
```

**렌더러** — topbar 토글 / localStorage 키 `fleet-console.terminalRenderer`

- 기본값 `webgl`. topbar 토글로 WebGL ↔ DOM 전환.
- 클라이언트 상태이므로 토글 즉시 적용(서버 재기동 불요).
- 토글은 라이브 xterm 인스턴스에 WebGL 애드온만 붙였다 떼는 방식이며, WebSocket 세션과 서버 연결은 유지된다. 토글 전후로 `state.sockets`에 새 `close` 이벤트가 없는지 확인해 세션이 끊기지 않았음을 검증한다.

```bash
# playwriter로 렌더러 상태 읽기 / 직접 전환
playwriter -s <id> -e "$(cat <<'EOF'
const renderer = await state.page.evaluate(() => localStorage.getItem('fleet-console.terminalRenderer') ?? 'webgl');
console.log('current renderer:', renderer);
EOF
)"
```

topbar 토글 버튼을 클릭하거나 localStorage를 직접 쓴 뒤 페이지를 리로드해도 전환된다:

```bash
playwriter -s <id> -e "$(cat <<'EOF'
await state.page.evaluate(() => localStorage.setItem('fleet-console.terminalRenderer', 'dom'));
await state.page.reload({ waitUntil: 'domcontentloaded' });
await waitForPageLoad({ page: state.page, timeout: 6000 });
console.log('renderer set to dom, page reloaded');
EOF
)"
```

#### 깨짐 유발(스트레스) 입력

터미널 세션 안에서 아래 명령을 붙여 실행한다. 셸 세션에 타이핑하거나, playwriter로 xterm 입력 포커스를 잡은 뒤 `page.keyboard.type()`으로 주입해도 된다.

**CJK + 박스드로잉 TUI 프레임 — PowerShell**:

```powershell
# 한글/CJK 와이드 문자와 박스드로잉을 혼합 출력해 폭 정합 엣지를 노린다
1..30 | ForEach-Object { Write-Host "┌─────────────────────────────┐"; Write-Host "│ 가나다라마바사 $_ 테스트 출력 │"; Write-Host "└─────────────────────────────┘" }
```

**고속 리페인트 루프 — PowerShell**:

```powershell
# clear + 재출력을 빠르게 반복해 conhost 재생성 경쟁을 유발한다
1..60 | ForEach-Object { Clear-Host; Write-Host "리페인트 $_: $(Get-Date -Format 'HH:mm:ss.fff')"; Start-Sleep -Milliseconds 80 }
```

**CMD 환경(cmd.exe)**:

```cmd
for /l %i in (1,1,50) do (cls & echo 박스 %i: [└─┐│┘├┼] & timeout /t 0 /nobreak >nul)
```

**창 리사이즈**: 스트레스 루프 실행 중 브라우저 창을 마우스로 드래그해 리사이즈한다. conhost↔xterm 그리드 불일치 창을 노리는 핵심 트리거다.

#### 관찰·캡처 절차

A/B 각 상태에서 스트레스 입력 후 아래 probe를 실행하고 스크린샷을 남긴다.

```bash
playwriter -s <id> -e "$(cat <<'EOF'
const probe = () => state.page.evaluate(() => {
  const q = s => document.querySelector(s);
  const canvas = q('.terminal-canvas');
  const xterm = canvas ? canvas.querySelector('.xterm') : null;
  return {
    hasXterm: !!xterm,
    canvasCount: canvas ? canvas.querySelectorAll('canvas').length : 0,
    appLen: (q('#app') || document.body).innerHTML.length,
    renderer: localStorage.getItem('fleet-console.terminalRenderer') ?? 'webgl',
  };
});
const result = await probe();
const socketsClosed = state.sockets.filter(s => s.closed).length;
console.log('probe:', JSON.stringify(result));
console.log('sockets closed:', socketsClosed, '/ total:', state.sockets.length);
console.log('pageerrors:', JSON.stringify(state.logs.filter(l => l.startsWith('[pageerror]'))));
await state.page.screenshot({ path: '/tmp/conpty-ab-' + result.renderer + '.png', scale: 'css' });
await resizeImageForAgent({ input: '/tmp/conpty-ab-' + result.renderer + '.png', maxDimension: 1100 });
EOF
)"
```

스크린샷을 읽어 시각 확인: `Read /tmp/conpty-ab-webgl.png`, `Read /tmp/conpty-ab-dom.png`.

#### 비교 체크리스트

스트레스 입력 종료 직후 A/B 각각에 대해 아래 항목을 확인한다.

| 항목 | 건강한 상태 | 깨짐 징후 |
|------|------------|----------|
| 셀 정렬 | 박스드로잉 문자가 열(column)에 맞게 연속 | 문자가 겹치거나 열이 어긋남 |
| 박스 연속성 | `└─┐` 등 선이 끊기지 않고 이어짐 | 선 단절 또는 문자가 잘려 나타남 |
| 잔상 | 이전 출력이 남지 않음 | clear 후에도 이전 줄이 남음 |
| `canvasCount` | `3` (xterm WebGL 3레이어) | `0` 또는 `1` — WebGL 초기화 실패 |
| `appLen` | 수천 이상 | 0에 가까우면 React 트리 언마운트(블랭크) |
| WS 세션 유지 | 렌더러 토글 전후 `sockets closed` 증가 없음 | 새 close 발생 시 세션 끊김 |
| `pageerror` | 없음 | WebGL context lost 또는 dispose 예외 |

#### 한계

깨짐은 "드물게" 발생하는 타이밍 의존 현상이므로 1회 관측으로 개선 여부를 단정할 수 없다. 스트레스 루프를 여러 번(최소 3회) 반복하고, A/B 간 깨짐 **빈도**를 비교해 판단한다. 이 하니스는 Windows 호스트에서만 의미 있으며, macOS/Linux에서는 ConPTY 경로가 다르므로 비교 결과가 무효다.

---

## Fleet-console specifics (gotchas)

- **Static-serve reflection**: client changes need `build` + reload; backend (`src/**`) changes need `build` + **server restart**. A "fix that didn't work" is often just an unrestarted server or a stale bundle — verify the served `index-*.js` hash matches `dist` before re-debugging.
- **Auth/route**: when the console runs loopback-only without a browser token gate, `/console/operations` renders directly. If a token handoff is in force, the launcher passes tokens once via the URL **fragment** (never a query string) — never inject tokens into query strings or logs.
- **Sessions are backend-shared**: any Chrome profile observes the same registered sessions; profile choice doesn't change what you see.
- **Folder picker is OS-native**: cannot be automated; reuse existing sessions for switch tests, or seed sessions via the authorized `POST /observer/theaters/<id>/sessions` API (see Prerequisites #1) — handy for a fresh isolated instance.
- **Terminal stack**: xterm.js + `@xterm/addon-webgl` (WebGL renderer, DOM fallback). A healthy `.terminal-canvas` holds 3 `canvas` layers. Watch for WebGL `context lost` and dispose-time exceptions on unmount.

## Safety rules

- **Never** `browser.close()` / `context.close()`, and never close the user's tabs. Reuse `state.page`; recreate only if `state.page.isClosed()`.
- **Never** `bringToFront` unless asked — you can drive background tabs.
- Clean up listeners at the end of a run: `state.page.removeAllListeners()`.
- Do not write fixes from this skill blindly — diagnose with evidence (stack + DOM + network), then edit, then re-verify here.
- The screenshot/artifact paths must be absolute (e.g. `/tmp/...`).
