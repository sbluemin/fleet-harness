# Browser fallback — agent-browser

Read only when Fleet Browser is unavailable or cannot provide evidence required by the scenario. Record the missing capability or actual error before switching. A permission denial is not permission to bypass that boundary with another tool.

## Load the agent-browser contract

Record the test host OS/architecture before choosing an agent-browser binary. If the host is Windows ARM64, the native wrapper is unavailable, or the result depends on platform-specific input behavior, read [the platform automation reference](platform-automation.md) completely before running browser commands. Never silently substitute an unofficial binary or report an emulated automation client as native ARM64 evidence.

Load the `agent-browser` skill, then the installed CLI workflow:

```bash
ab() {
  if command -v agent-browser >/dev/null 2>&1; then agent-browser "$@";
  else npx --yes agent-browser "$@"; fi
}
ab skills get core --full
ab skills get dogfood
```

Choose one unique literal session id matching `^fleet-console-e2e-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. Repeat that exact literal in every independent browser call; never store it in a shell variable or rely on shell state crossing tool calls. The examples use `fleet-console-e2e-20260725-a7c3`; replace it consistently before running them.

Agent-browser defaults to headless. Set the 30-minute owned-daemon idle timeout and pass `--headed false` on the first `open` to override user or project configuration:

The navigation example uses `/console/operations`; replace that literal only when the scenario targets another route.

## Instrument before navigation

Register errors, rejections, and WebSocket lifecycle before the first page load:

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

**`--headed false` is ignored because a daemon is already running -> stop and report when headless proof is required; never claim the run was headless or use `close --all`/kill an unknown daemon -> sessions isolate browser state, not daemon launch mode.**

Replace `<worktree>` and `<scratchpad>` with this session's absolute paths. Shell variables and `ab()` do not survive independent calls: redeclare required values or use recorded literals. Prefer the available Write tool to create script files.

After the first `open` attempt, run `node <worktree>/.claude/skills/console-e2e/scripts/close-owned-session.mjs <session>` on every success and failure path. It must verify both session and recorded PID disappearance. Never apply this helper to a Fleet Browser tab or Desktop CDP session.
