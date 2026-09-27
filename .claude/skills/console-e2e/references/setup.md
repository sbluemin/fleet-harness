# Isolated Console setup

Build and boot the owned Console before connecting with the selected browser driver. Consult **Isolated Development Data** in `docs/fleet-development-reference.md`. If the run may start Claude (terminal or SDK/chat), complete [Claude state and trust preflight](claude-state.md) first; Fleet slot isolation alone does not isolate agent state.

## Isolate the Console

Never restart or reuse an unknown Console daemon. Build the requested source, choose a unique runtime directory, and start `serve` so no unrelated browser tab opens:

```bash
cd <worktree>
export PATH="<pnpm-bin>:$PATH"
pnpm --filter @dotobokuri/fleet-console build
E2E_DIR="<scratchpad>/fleet-console-e2e-<unique-id>"
env -u INIT_CWD \
  FLEET_DATA_DIR="$E2E_DIR/root" \
  FLEET_CONSOLE_DATA_DIR="$E2E_DIR/console" \
  FLEET_DESKTOP_DATA_DIR="$E2E_DIR/desktop" \
  node <worktree>/runtime/fleet-console/dist/cli.mjs serve
```

`FLEET_CONSOLE_DATA_DIR` isolates the Console slot, including credentials, durable state, lock, and gateway selection. `FLEET_DATA_DIR` also isolates host-shared data and legacy migration sources; setting only the Console slot is not a no-user-data-write guarantee. Override all three inherited Fleet paths explicitly. These variables do not isolate Claude: for an agent run, use the additional environment and launch checks in the preflight rather than this UI-only example. (`FLEET_CONSOLE_DIR` is the former name of `FLEET_CONSOLE_DATA_DIR` and still works.)

A fresh slot has no provider credentials. Do not copy real credentials, trigger login/token refresh, or silently reuse a user's root to make a test pass. Prefer a no-provider fixture when it proves the claim. A real-provider scenario needs an explicitly authorized credential path and quota use, with any non-isolated stores disclosed before launch.

Run the server as a background/managed process and wait for `$E2E_DIR/console/console.lock`. Read `port` and `token` locally, but never print the token. Confirm the route returns `200`. Seed a real Theater through the Console folder UI or authorized API only when the scenario needs it; do not copy the user's durable state.

Client changes require build plus reload. Host changes require build plus isolated server restart. Compare the asset name in `dist/client/index.html` with the served `/console/` HTML before blaming stale behavior.

### UI-only Operation fixtures

For proposal/audit screens that need Operations but no model turn, prefer a dormant fixture in the **owned, stopped runtime's** `state.json`, using the current durable schema and restore tests as the source of truth. Never copy user state or overwrite a running server's state. Inspect `features/workspace/host/durable-state.ts` and the terminal restore contract for the current `payload.session` shape before authoring a fixture. Resume affordances require supported session identity; a fabricated identity is not proof that resume works. Verify the restored Operations through the API and UI without launching a provider.

Do not assume restored Operations are expanded or visible. Dormant fixtures may restore minimized; inspect the actual presentation, restore/arrange it through real UI actions, and confirm the intended cards/tiles in screenshots before a visual sweep. If the scenario truly requires a live terminal body, use an owned Shell Operation and the current layout controls rather than launching an unnecessary paid agent. A missing fixture or hidden tile is not product-defect evidence.

### Objective member child-session fixture

For an Objectives roster with existing member sessions but no model turn, seed **both** the objective roster and the commander's nested sessions. `runtime/fleet-plugins/objectives/server/store.ts` projects each member by matching `members[].id` to the commander's `childSessions[].id`, then reads `child.payload.session.sessionName`. A `sessionName` added to the roster record is not its source of truth; a separate top-level member Operation does not establish this relationship either. No matching child means the projected member's `sessionName` is `null`.

1. In the owned isolated Console, register the target worktree as a Theater and create an objective with one roster member through the UI or authorized API, **without** Plan, Commence, muster, or resume. Record the generated Theater, objective, and member ids. Creating the objective/roster does not require a provider turn.
2. Stop only that owned runtime and confirm it has stopped before editing. Preserve its generated Theater registration, state version, other state fields, and objective metadata. Never use the user's Console slot or edit a running server's files.
3. In `$E2E_DIR/console/state.json`, keep the generated `version` unchanged and add the commander below to `operations`, or update its existing entry, without duplicating its id. Replace `fixture-objective`, `fixture-member`, `<registered-theater-id>`, and `<absolute-worktree>` with the recorded values. The code block is a **state excerpt**, not a replacement for the whole file.

```json
{
  "operations": [
    {
      "id": "fixture-objective",
      "theaterId": "<registered-theater-id>",
      "title": "Objective roster fixture",
      "type": "agent",
      "pluginId": null,
      "payload": {
        "cwd": "<absolute-worktree>",
        "session": {
          "harness": "claude-code",
          "sessionName": "fixture-cmdr"
        }
      },
      "childSessions": [
        {
          "id": "fixture-member",
          "payload": {
            "cwd": "<absolute-worktree>",
            "session": {
              "harness": "claude-code",
              "sessionName": "fixture-member-1"
            }
          },
          "ts": { "createdAt": 1001, "updatedAt": 1001 }
        }
      ],
      "geometry": null,
      "ts": { "createdAt": 1000, "updatedAt": 1000 }
    }
  ]
}
```

The generated objective record lives under the **isolated Console slot's** `workspaces/<workspace-key>/objectives/<objective-id>/objective.json`. Locate the record created in step 1 rather than guessing the workspace key or using a legacy Fleet-root path. **Remove its `pending` field when adding the commander Operation**, while the owned runtime is still stopped; preserve the remaining metadata. `pending` means no commander Operation exists yet, so retaining both sends later edits down the pending-only path instead of updating the Operation. Its relevant fields match the state excerpt as follows (substitute the same generated ids; retain its other fields except `pending`):

```json
{
  "operationId": "fixture-objective",
  "members": [
    { "id": "fixture-member", "role": "Verifier", "by": "human" }
  ]
}
```

Restart the same owned runtime. Read `POST /plugins/objectives/state` with `{ "theaterId": "<registered-theater-id>" }` through the authorized local page/API and confirm `objectives[].members[].sessionName` is `fixture-member-1` for that objective/member. Confirm the roster/session surface in the UI too. Top-level Operation lists contain the commander only; the member is derived from `childSessions`. Do not click resume to make the fixture visible: these restored sessions are dormant, and the names above are display/session-routing names, **not** provider resume identities.

This fixture proves identity projection and dormant presentation, not a live member's idle/working/permission-pending state. If a UI-only scenario needs one of those API snapshots, use the [pre-navigation fetch wrapper](agent-browser.md#mock-page-api-responses-before-navigation), record the mocked endpoint/fields, and do not describe it as live-agent verification. Recheck the current durable reader in `runtime/fleet-console/features/workspace/host/durable-state.ts`, the member projection in `runtime/fleet-plugins/objectives/server/store.ts`, and the existing child-session restore example in `runtime/fleet-console/tests/server.test.ts` when these contracts change.
