# Isolated Console and browser instrumentation

## Load the browser contract

Record the test host OS/architecture before choosing an agent-browser binary. If the host is Windows ARM64, the native wrapper is unavailable, or the result depends on platform-specific input behavior, read [the platform automation reference](platform-automation.md) completely before running browser commands. Never silently substitute an unofficial binary or report an emulated automation client as native ARM64 evidence.

Before browser commands, load the installed CLI workflow:

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

## Isolate the Console

Never restart or reuse an unknown Console daemon. Build the requested source, choose a unique runtime directory, and start `serve` so no unrelated browser tab opens:

```bash
cd <worktree>
export PATH="<pnpm-bin>:$PATH"
pnpm --filter @dotobokuri/fleet-console build
E2E_DIR="<scratchpad>/fleet-console-e2e-<unique-id>"
FLEET_CONSOLE_DATA_DIR="$E2E_DIR" node runtime/fleet-console/dist/cli.mjs serve
```

`FLEET_CONSOLE_DATA_DIR` isolates this Console's durable state, lock, and gateway selection while the run still reads the user's real credentials at `~/.fleet/auth.json` — which is what a scenario needing a logged-in Agent CLI depends on. Add `FLEET_DATA_DIR="$E2E_DIR/root"` only when the scenario must also start without credentials, installed plugins, or workspace knowledge; it isolates the whole Fleet root. (`FLEET_CONSOLE_DIR` is the former name of `FLEET_CONSOLE_DATA_DIR` and still works.)

Run the server as a background/managed process and wait for `$E2E_DIR/console.lock`. Read `port` and `token` locally, but never print the token. Confirm the route returns `200`. Seed a real Theater through the Console folder UI or authorized API only when the scenario needs it; do not copy the user's durable state.

Client changes require build plus reload. Host changes require build plus isolated server restart. Compare the asset name in `dist/client/index.html` with the served `/console/` HTML before blaming stale behavior.

### UI-only Operation fixtures

For proposal/audit screens that need Operations but no model turn, prefer a dormant fixture in the **owned, stopped runtime's** `state.json`, using the current durable schema and restore tests as the source of truth. Never copy user state or overwrite a running server's state. The old `providerSession` recipe is a legacy migration input, not the current payload: inspect `core/host/durable-state.ts` and the terminal restore contract for the current `payload.session` shape before authoring a fixture. Resume affordances require supported session identity; a fabricated identity is not proof that resume works. Verify the restored Operations through the API and UI without launching a provider.

Do not assume restored Operations are expanded or visible. Historical dormant fixtures restored minimized; inspect the actual presentation, restore/arrange it through real UI actions, and confirm the intended cards/tiles in screenshots before a visual sweep. If the scenario truly requires a live terminal body, use an owned Shell Operation and the current layout controls rather than launching an unnecessary paid agent. A missing fixture or hidden tile is not product-defect evidence.

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
