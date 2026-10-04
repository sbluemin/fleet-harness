# Browser route — agent-browser

Default driver for Console browser E2E. Switch to [Fleet Browser](fleet-browser.md) only when agent-browser cannot run here (missing binary, blocked install, unusable daemon), recording the error first.

## Load the contract

Record the host OS/architecture. On Windows ARM64, when the native wrapper is unavailable, or when the result depends on platform-specific input, read [the platform automation reference](platform-automation.md) before running browser commands.

Load the `agent-browser` skill, then the installed CLI workflow. Multi-command examples here and in the verification reference show scenario order, not a batch to paste: run each CLI command separately under the deadline below, repeating the resolver definition or using the resolved executable in each tool call.

```bash
ab() {
  if command -v agent-browser >/dev/null 2>&1; then agent-browser "$@";
  else npx --yes agent-browser "$@"; fi
}
ab skills get core --full
ab skills get dogfood
```

Choose one unique session id matching `^fleet-console-e2e-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` and repeat that literal in every call; shell variables, `ab()`, and cwd do not survive between tool calls. The examples use `fleet-console-e2e-20260725-a7c3`, `<worktree>`, `<scratchpad>`, and `<port>`: substitute recorded absolute values consistently.

## Bound commands and recover stuck input

Run each agent-browser command in its own tool call with an explicit wall-clock deadline (normally `Bash.timeout: 30000`), including `open`, input, `find`, `reload`, and diagnostics; the resolver above does not impose a deadline, and a long timeout around a batch is not a substitute. Choose and record a longer finite deadline before an expected slow operation, such as first-time installation or a deliberate longer wait, rather than repeatedly extending a hung interaction. This also applies to `npx` and Windows native-wrapper calls; if the execution tool cannot bound a command, report that blocker instead of running it unbounded.

Drive the page with agent-browser commands. For an exact key press or a held touch/coarse-pointer state, use the [CDP input helpers](cdp-input.md). Write a hand-rolled CDP helper only for other input the CLI cannot produce ([verification](verification.md)); it must not activate the window (see the focus rule in the skill entry point).

For a directly executed native CLI on macOS without `timeout`, an additional command-local guard is `perl -e 'alarm 30; exec @ARGV; die "exec failed: $!\n"' -- agent-browser --session <owned-session-id> <command>`. Set the enclosing tool deadline slightly longer (for example, 40000 ms). Change the alarm seconds as well when intentionally allowing a longer operation. The alarm limits only the direct process: do not rely on it to bound an `npx`/Node wrapper's child processes or clean up the daemon. Record a tool timeout or alarm termination as such, not as a product assertion failure.

Suspect stuck automation input when one key press produces an event flood (for example, repeated `Unidentified` keydown/keypress), an action fires more times than the input sent, or subsequent observation/navigation commands stop returning. These are diagnostic signals, not proof of a product defect or of a driver fault.

1. Stop sending input or retrying `find`/`reload` in the suspect session. Preserve available command, timing, event-count, and error evidence; bound any diagnostic attempt too.
2. Run the [owned-session cleanup](#cleanup) helper with a finite enclosing tool deadline. A timed-out CLI command may leave its daemon and browser alive. If cleanup fails or times out, report cleanup as unconfirmed and stop this route rather than using global closes, killing unknown processes, or accumulating replacement sessions.
3. After verified cleanup, choose a new unique session id, open the same owned runtime with fresh pre-navigation instrumentation, restore the scenario's starting state, and repeat the exact action sequence once. Do not use a reload of the suspect session as the fresh-session control.
4. Compare the runs before classifying the failure. A failure confined to the contaminated session is evidence of an automation/session issue; report that the product defect was not reproduced in the fresh session, not that it is disproved. A fresh-session recurrence needs further driver/product isolation before changing product code. If the fresh run blocks too, stop and report the verification blocker instead of retrying indefinitely. Clean up the replacement session on either outcome.

## Open with instrumentation

Register errors, rejections, and WebSocket lifecycle before the first page load (prefer the Write tool for the script file):

```bash
INIT="<scratchpad>/fleet-console-e2e-init-<unique-id>.js"
cat > "$INIT" <<'EOF'
(() => {
  const state = window.__fleetE2E = { errors: [], rejections: [], consoleErrors: [], sockets: [] };
  addEventListener('error', e => state.errors.push({ message: e.message, stack: e.error?.stack || '' }), true);
  addEventListener('unhandledrejection', e => state.rejections.push(String(e.reason?.stack || e.reason)));
  const nativeConsoleError = console.error.bind(console);
  console.error = (...args) => { state.consoleErrors.push(args.map(String).join(' ')); nativeConsoleError(...args); };
  const Native = window.WebSocket;
  function Tracked(...args) {
    const socket = new Native(...args);
    const target = new URL(String(args[0]), location.href);
    const record = { url: target.origin + target.pathname, closed: false }; // query can carry a WS ticket; never record it
    state.sockets.push(record);
    socket.addEventListener('close', () => { record.closed = true; });
    return socket;
  }
  Tracked.prototype = Native.prototype;
  Object.setPrototypeOf(Tracked, Native);
  window.WebSocket = Tracked;
})();
EOF
cat "$E2E_DIR/whats-new.js" >> "$INIT"   # from the setup onboarding seed, unless What's New is under test

AGENT_BROWSER_IDLE_TIMEOUT_MS=1800000 ab --session fleet-console-e2e-20260725-a7c3 --headed false open --init-script "$INIT" "http://127.0.0.1:<port>/console/operations"
ab --session fleet-console-e2e-20260725-a7c3 wait --load domcontentloaded
```

Replace `/console/operations` only when the scenario targets another route. `--headed false` overrides a user/project `headed` config; pass `--headed` instead when the task requires a headed visual gate. The launch mode belongs to the daemon: if a running daemon ignores the flag, report the actual mode rather than claiming the requested one, and never `close --all` or kill an unknown daemon to reset it.

## Mock page API responses before navigation

For page-level API fixtures, use a `window.fetch` wrapper in `open --init-script`, not `agent-browser network route`. In a Console verification run, `network route` did not intercept the app's fetches; accepting the route command is not evidence that a fixture reached the page. This is the preferred page-fetch recipe, not a claim that network routing never works.

Append the following to the **same** init script as the diagnostics above, before opening a new owned browser session. This example supplies an empty Agent CLI launch list without probing installed CLIs through this endpoint; replace the exact path and JSON with the current endpoint's browser DTO for the scenario.

```js
(() => {
  const nativeFetch = window.fetch.bind(window);
  const hits = window.__fleetE2EMockHits = [];
  window.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input), location.href);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    if (url.origin !== location.origin || method !== 'GET' || url.pathname !== '/api/v1/agent/state') {
      return nativeFetch(input, init);
    }
    const signal = init?.signal ?? request?.signal;
    if (signal?.aborted) throw signal.reason;
    hits.push({ method, pathname: url.pathname });
    return new Response(JSON.stringify({ agentClis: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
})();
```

Use the instrumented `open --init-script "$INIT"` command above; do not first open the app and then install the wrapper with `eval`. After the app's normal load/action, inspect the hit list (without manually fetching the endpoint just to make it nonempty):

```bash
ab --session fleet-console-e2e-20260725-a7c3 eval 'JSON.stringify(window.__fleetE2EMockHits)'
```

Require a matching hit **and** the expected UI state before claiming interception. A wrapper-created response does not reach the network, so a missing network-log entry is not a failure by itself. If the init script must change after opening, clean up the owned session and reopen with a new unique id and the complete script; do not accumulate browsers while debugging a missed first-load request.

Keep unmatched requests unchanged and scope mocks to the owned origin, exact endpoint, method, and any scenario-specific query/body discriminator. For a POST read endpoint, inspect a cloned `Request` rather than consuming the body that a passthrough request still needs. Never broadly mock writes, authentication, permission denials, or provider launches to make a check pass. This wrapper covers page `fetch`, not worker fetches, XHR, WebSockets, or server-side calls; live events may overwrite a mocked snapshot. Report the mocked lane as UI-only evidence, not proof of backend behavior or agent activity. For durable objective/member identity, use the [child-session fixture](setup.md#objective-member-child-session-fixture) rather than inventing session names in a response.

## Driver pitfalls

These CLI behaviors have produced false results in Console runs. Recheck them against the installed agent-browser version before relying on a workaround, and verify every action with an `eval` of the expected DOM or state change; an exit code of 0 is not evidence that input landed.

- **Installation:** when `agent-browser` is not on `PATH`, back-to-back `npx` calls can fail with `ENOTEMPTY` while npm renames its cache and then do nothing. After the first `npx` run, call the cached `node_modules/.bin/agent-browser` directly. `~/.npm/_npx` can keep older versions beside it, so use the cache whose `--version` matches `npx --yes agent-browser --version` and check its `--help` for the options the run needs: a cached 0.21.0 has no `--init-script` and opens the script path as the URL, leaving `chrome-error://`. An empty result or `MODULE_NOT_FOUND` from a cache being reinstalled by another session is a tooling failure, not product evidence.
- **Init script:** `--init-script` registers only on the command that launches the browser. Make the instrumented `open` the session's first command; if a launch leaves `about:blank` or any earlier command already started the browser, clean up and reopen. The script runs before `document.documentElement` exists, so observe `document`. Confirm a global it sets before trusting measurements.
- **Eval scope:** every `eval` runs in the same page scope until reload, so a repeated top-level `const` throws on the second call and returns nothing. Wrap multi-statement scripts in an IIFE.
- **Double click:** `dblclick` sends one click with `detail=2`. A double-submit or double-delete race needs two real presses (CDP `Input.dispatchMouseEvent` with a real gap).
- **Wheel:** `mouse wheel` dispatches at `(0, 0)` even after `mouse move`. Scroll an inner pane with `scroll <direction> <px> --selector <pane>` and read `scrollTop`; canvas zoom or any claim about wheel hit testing needs CDP `mouseWheel` at the checked point.
- **Off-screen targets:** `click` on an element below the fold can report success without firing. Run `scrollintoview` and the [pointer target preflight](verification.md#pointer-target-preflight) first.
- **Key names:** in agent-browser 0.27.0, `press Space` and `press " "` send a real Space (`key: " "`, `code: "Space"`), but `press Spacebar` and `keydown Space`/`keyup Space` return exit 0 while sending empty key/code values (`keyCode: 0`) and do not activate a button. When Space itself is under test, use the [single-key helper](cdp-input.md#one-key-press) with `--key Space` and confirm the click or state change after keyup.
- **Key floods:** a single `press Escape`, an Alt shortcut, or `keyboard type` with focus on `body` has flooded thousands of repeated keydowns (`Unidentified`/`Minus` on macOS). Prefer the visible UI control; when a key itself is under test, send it with the [single-key helper](cdp-input.md#one-key-press). It sends one keyDown/keyUp pair, counts the page's keydowns, including those a page shortcut swallows, and fails unless exactly one arrived. Treat any flood as [stuck input](#bound-commands-and-recover-stuck-input). A synthetic `KeyboardEvent` is handler evidence only.
- **Active target:** in Desktop, opening a native view or popup makes it the active CDP page, so later commands run inside the page under test. Select the Console target before every SPA command.
- **Shell quoting:** when the shell is zsh (the macOS default), an unquoted `$p` is not word-split; split coordinates explicitly (`read -r x y <<< "$p"`).
- **Evidence before cleanup:** closing the session destroys `window.__fleetE2E`. Print the full error, rejection, and `console.error` records before cleanup and after risky actions such as reload or resize; a count without messages is lost evidence.

## Cleanup

After the first `open` attempt, run on every success and failure path:

```bash
node <worktree>/.claude/skills/console-e2e/scripts/close-owned-session.mjs fleet-console-e2e-20260725-a7c3
```

Cleanup succeeds only when the helper reports that both the session and its recorded PID disappeared, not from a raw `close` exit code. The helper closes agent-browser sessions, including a Desktop CDP session named by the same rule; it does not stop the Electron app (use the Desktop stop helper) and does not apply to Fleet Browser tabs.
