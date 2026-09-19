# Isolated Console setup

Build and boot the owned Console before connecting with the selected browser driver. Consult **Isolated Development Data** in `docs/fleet-development-reference.md`.

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

For proposal/audit screens that need Operations but no model turn, prefer a dormant fixture in the **owned, stopped runtime's** `state.json`, using the current durable schema and restore tests as the source of truth. Never copy user state or overwrite a running server's state. The old `providerSession` recipe is a legacy migration input, not the current payload: inspect `features/workspace/host/durable-state.ts` and the terminal restore contract for the current `payload.session` shape before authoring a fixture. Resume affordances require supported session identity; a fabricated identity is not proof that resume works. Verify the restored Operations through the API and UI without launching a provider.

Do not assume restored Operations are expanded or visible. Historical dormant fixtures restored minimized; inspect the actual presentation, restore/arrange it through real UI actions, and confirm the intended cards/tiles in screenshots before a visual sweep. If the scenario truly requires a live terminal body, use an owned Shell Operation and the current layout controls rather than launching an unnecessary paid agent. A missing fixture or hidden tile is not product-defect evidence.
