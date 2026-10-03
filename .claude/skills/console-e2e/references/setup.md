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

### Record what is being reproduced

Before reproducing a user-reported defect, record the user's installed Fleet version or reported surface, the target SHA, and the served asset name. A local `canary` can lag or lead the user's build with a different UI; when they differ, reproduce on a detached [baseline](../../git-worktree/references/baseline.md) at the user's revision rather than assuming the newest checkout shows the same behavior. While measuring, do not let another build write the same `dist/` the owned server serves: use a separate checkout or output, and report a rebuild that landed mid-measurement as a contaminated run.

### First-load onboarding state

A fresh slot and a new origin show commissioning, What's New, welcome slides, entry hints, and feature tours, and they can race the scenario's first input. Prepare that state **before the first navigation** instead of dismissing layers mid-scenario. Once the lock exists, run [`scripts/seed-onboarding.mts`](../scripts/seed-onboarding.mts) with the Console package's `tsx`:

```bash
pnpm --dir <worktree>/runtime/fleet-console exec tsx \
  <worktree>/.claude/skills/console-e2e/scripts/seed-onboarding.mts \
  --console-dir "$E2E_DIR/console" --init-script "$E2E_DIR/whats-new.js"
```

- It derives every key from the current source (core and built-in plugin onboarding contributions, the seen-store key rules, the commissioning key), merges them into `seenFeatureTours` through the origin-gated `PUT /api/v1/settings/global`, reads them back, and fails when one is missing. `--dry-run` only lists the keys. Commissioning also opens only while no Theater is registered.
- What's New is a per-origin `localStorage` watermark, so the script writes it as a page script for `--init-script` of the session that opens the page. Every isolated-server restart picks a new port, which is a new origin: rerun the script and reopen the session. The [Fleet Browser fallback](fleet-browser.md) has no init script; there, dismiss What's New through its real control and record that the watermark could not be preset.
- When the claim concerns onboarding, a tour, or a hint, do not seed or dismiss the layer under test: pass `--keep <key>` (or a prefix ending in `.`, such as `objectives.`) for it, which also clears that key on a reused slot, omit `--init-script` when What's New is under test, and install diagnostics before the first navigation so its appearance and race stay observable.
- Confirm the first screenshot shows no unseeded onboarding layer before acting.

### No-cost fake Claude

When the claim needs a live agent process, MCP tools, or chat protocol traffic but not model output, point `CLAUDE_BIN` at [`scripts/fake-claude.mjs`](../scripts/fake-claude.mjs) instead of the real CLI. It answers `--version`, speaks the SDK stream-json control protocol in chat (`initialize`, `set_model`, `get_context_usage`, one canned turn per user message), and otherwise stays alive as an interactive terminal that echoes input. Nothing reaches a provider, so no quota is spent and no credential is needed.

- Boot through the [Claude state preflight](claude-state.md) environment anyway: add `CLAUDE_BIN=<worktree>/.claude/skills/console-e2e/scripts/fake-claude.mjs` and `FAKE_CLAUDE_DIR=<owned-run>/fake-claude`, and keep `node` on the explicit `PATH`. On Windows, point `CLAUDE_BIN` at the sibling `fake-claude.cmd` instead: Console launches only `.cmd`/`.bat` shims through `cmd.exe`, so a `.mjs` path does not start. A fake binary does not make the rest of the agent route inert.
- `FAKE_CLAUDE_DIR/log.jsonl` records each launch (mode, cwd, `--session-id`/`--resume`, MCP server names), control request, turn and exit without secrets. Use it to prove which Operation launched, resumed or exited. The script header lists the control files for context size, a failing `set_model`, and a held-open turn.
- To act as that launch on Console MCP (an Objectives Commander or member, `fleet-console-use`, and so on), run [`scripts/fake-claude-mcp.mjs`](../scripts/fake-claude-mcp.mjs) `--dir <FAKE_CLAUDE_DIR> --server <name> --tool <tool> --args '<json>'`; `--list` shows the saved launches. The Console-issued bearer tokens stay in owner-only files under `FAKE_CLAUDE_DIR/mcp/`; never print or copy them.
- The fake fires no Claude hooks. Console pins a `--session-id` at launch, which keeps the Operation's identity, but a coordinate whose source is still `launch` resumes as a fresh session. To exercise a real `--resume`, post the capture hook a real CLI would send: `POST /api/v1/agent/sessions/<operation>/capture` with the lock token as Bearer and `{"provider":"claude","input":"{\"session_id\":\"<pinned id>\",\"source\":\"startup\"}"}`. Turn, attention, and background states have their own lock-token hook routes. Recheck the resume and capture contracts in `features/execution/host/agent/routes.ts` when they change.
- Label results as fixture evidence. A fake proves launch, lifecycle, MCP and protocol paths, not real CLI behavior, authentication, trust prompts, or model quality.

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
