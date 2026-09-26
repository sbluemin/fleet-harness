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
  const state = window.__fleetE2E = { errors: [], rejections: [], sockets: [] };
  addEventListener('error', e => state.errors.push({ message: e.message, stack: e.error?.stack || '' }));
  addEventListener('unhandledrejection', e => state.rejections.push(String(e.reason?.stack || e.reason)));
  const Native = window.WebSocket;
  function Tracked(...args) {
    const socket = new Native(...args);
    const record = { url: String(args[0]), closed: false };
    state.sockets.push(record);
    socket.addEventListener('close', () => { record.closed = true; });
    return socket;
  }
  Tracked.prototype = Native.prototype;
  Object.setPrototypeOf(Tracked, Native);
  window.WebSocket = Tracked;
})();
EOF

AGENT_BROWSER_IDLE_TIMEOUT_MS=1800000 ab --session fleet-console-e2e-20260725-a7c3 --headed false open --init-script "$INIT" "http://127.0.0.1:<port>/console/operations"
ab --session fleet-console-e2e-20260725-a7c3 wait --load domcontentloaded
```

Replace `/console/operations` only when the scenario targets another route. `--headed false` overrides a user/project `headed` config; pass `--headed` instead when the task requires a headed visual gate. The launch mode belongs to the daemon: if a running daemon ignores the flag, report the actual mode rather than claiming the requested one, and never `close --all` or kill an unknown daemon to reset it.

## Cleanup

After the first `open` attempt, run on every success and failure path:

```bash
node <worktree>/.claude/skills/console-e2e/scripts/close-owned-session.mjs fleet-console-e2e-20260725-a7c3
```

Cleanup succeeds only when the helper reports that both the session and its recorded PID disappeared, not from a raw `close` exit code. The helper is for standalone agent-browser sessions only, not Fleet Browser tabs or a Desktop CDP session.
