# Browser route — agent-browser

Default driver for Console browser E2E. Switch to [Fleet Browser](fleet-browser.md) only when agent-browser cannot run here (missing binary, blocked install, unusable daemon), recording the error first.

## Load the contract

Record the host OS/architecture. On Windows ARM64, when the native wrapper is unavailable, or when the result depends on platform-specific input, read [the platform automation reference](platform-automation.md) before running browser commands.

Load the `agent-browser` skill, then the installed CLI workflow:

```bash
ab() {
  if command -v agent-browser >/dev/null 2>&1; then agent-browser "$@";
  else npx --yes agent-browser "$@"; fi
}
ab skills get core --full
ab skills get dogfood
```

Choose one unique session id matching `^fleet-console-e2e-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` and repeat that literal in every call; shell variables, `ab()`, and cwd do not survive between tool calls. The examples use `fleet-console-e2e-20260725-a7c3`, `<worktree>`, `<scratchpad>`, and `<port>`: substitute recorded absolute values consistently.

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
