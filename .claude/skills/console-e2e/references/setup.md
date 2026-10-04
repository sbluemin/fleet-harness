# Isolated Console setup

Build and boot the owned Console before connecting with the selected browser driver. Consult **Isolated Development Data** in `docs/fleet-development-reference.md`. If the run may start Claude (terminal or SDK/chat), complete [Claude state and trust preflight](claude-state.md) first, leaving only its folder-dialog Theater trust step for after boot; Fleet slot isolation alone does not isolate agent state.

## Isolate the Console

Never restart or reuse an unknown Console daemon. Build the requested source, choose a unique runtime directory, and start `serve` through [the isolated-environment wrapper](#keep-the-real-home-out) so that no unrelated browser tab opens and no real home is inherited:

```bash
cd <worktree>
export PATH="<pnpm-bin>:$PATH"
pnpm --filter @dotobokuri/fleet-console build
E2E_DIR="<scratchpad>/fleet-console-e2e-<unique-id>"
node <worktree>/.claude/skills/console-e2e/scripts/isolated-env.mjs --run-dir "$E2E_DIR" \
  -- node <worktree>/runtime/fleet-console/dist/cli.mjs serve
```

The wrapper gives the host and every child it starts `$E2E_DIR/home` as `HOME`, together with `FLEET_DATA_DIR` (`root`), `FLEET_CONSOLE_DATA_DIR` (`console`), `FLEET_DESKTOP_DATA_DIR` (`desktop`), and `CLAUDE_CONFIG_DIR` (`claude`) under the run directory. It passes nothing else from the calling environment, which drops `INIT_CWD`, the parent Console's slot paths, session markers, and tokens. `CLAUDE_CONFIG_DIR` matters even in a UI-only run: adding a Theater through the folder dialog records Claude trust in the host's selected Claude config, which is the user's `~/.claude.json` without it. `FLEET_CONSOLE_DATA_DIR` isolates the Console slot, including credentials, durable state, lock, and gateway selection. `FLEET_DATA_DIR` also isolates host-shared data and legacy migration sources, so setting only the Console slot is not a no-user-data-write guarantee. These variables do not isolate Claude: before an agent run, complete the preflight's additional launch checks. (`FLEET_CONSOLE_DIR` is the former name of `FLEET_CONSOLE_DATA_DIR` and still works.)

The session scratchpad fits runs that end with the session. When the run must survive a session restart, such as objective work, put `E2E_DIR` and any throwaway Theater under the worktree's ignored `.fleet/` (for example `<worktree>/.fleet/e2e-<unique-id>`); the objective's evidence directory lies under `~/.fleet`, which the wrapper refuses. A throwaway Theater that needs git gets its own `git init`, so git commands in it do not resolve to the enclosing worktree.

### Keep the real home out

The Console Shell surface (the toolbar **Shell** button) starts the host's `$SHELL` with the host's `HOME`. A host that inherits the real home therefore writes the user's shell history and reads their startup files. The same holds for measurement commands such as `zsh -i` or a shell startup timing. Earlier runs mixed test commands into the real `~/.zsh_history` this way. Run every owned host, every pnpm or `tsx` helper (such as the onboarding seed below, because pnpm and `tsx` keep caches and state under `HOME`), and every command that starts a shell or an agent CLI through [`scripts/isolated-env.mjs`](../scripts/isolated-env.mjs), with the same `--run-dir`. The exceptions bullet below lists the helpers that run outside it.

```bash
node <worktree>/.claude/skills/console-e2e/scripts/isolated-env.mjs --run-dir "$E2E_DIR" \
  [--bin <name|abs-path>]... [--set NAME=VALUE]... [--check] -- <command> [args...]
```

- **Before launch:** run the same invocation with `--check`. It prints the owned directories, the `pathbin` links, `PATH`, `SHELL`, and the names (not values) of `--set` variables, and it starts nothing. The wrapper refuses a run directory, `--bin`, or `--set` path inside the real home's agent, Fleet, shell-history, or credential stores (`~/.claude`, `~/.claude.json`, `~/.fleet`, `~/.codex`, `~/.agent-browser`, `~/.config`, `~/.ssh`, Keychains, shell history and rc files, and similar) or inside an inherited Fleet or Claude directory, after resolving symlinks. It checks each `:`-separated segment of a `--set` value. It resolves every relative segment, including a bare one such as `.claude/x`, against the current directory, where the child also runs. It refuses `~`, because nothing expands it. It also refuses `--set` for the variables it manages and for credential-like names (`*TOKEN*`, `*API_KEY*`, `ANTHROPIC_*`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `CLAUDE_CODE_CHILD_SESSION`, `SSH_AUTH_SOCK`, ...). Fix a refusal by choosing an owned path, never by working around the check.
- **`PATH`:** a fresh `$E2E_DIR/pathbin/call-*` directory for each call, then the system directories. It links only the running `node` and that call's `--bin` entries (a name resolved on the caller's `PATH`, or an absolute path), and it is removed when the command exits. A later call on the same run directory therefore never adds a CLI to a host that is already running, such as `--bin claude` reaching a fake-only Console. A Node version manager's directory often also holds globally installed agent CLIs (`codex`, `gemini`, `opencode`, ...), so it is never put on `PATH` whole. Add `--bin pnpm` when the command needs pnpm, and name an agent CLI explicitly, for example `--set CLAUDE_BIN=<worktree>/.claude/skills/console-e2e/scripts/fake-claude.mjs --set FAKE_CLAUDE_DIR="$E2E_DIR/fake-claude"`.
- **Exceptions, stated only here:** outside the wrapper, by design, run the browser driver (agent-browser, Fleet Browser), [`close-owned-session.mjs`](../scripts/close-owned-session.mjs), [`cdp-input.mjs`](../scripts/cdp-input.mjs), and the Desktop helpers ([`desktop-preflight.mjs`](../scripts/desktop-preflight.mjs), [`stop-owned-desktop.mjs`](../scripts/stop-owned-desktop.mjs), [`main-inspector.mjs`](../scripts/main-inspector.mjs)). These locate sessions under the real home or only talk to an owned endpoint. So do plain-Node HTTP helpers that start no shell, agent CLI, pnpm, or `tsx`, such as [`fake-claude-mcp.mjs`](../scripts/fake-claude-mcp.mjs) and console-handoff's `seed-console.mjs`, and the workspace install and build (`pnpm install`, `pnpm --filter … build`), which write only the checkout and pnpm's own store and start nothing under the run. Inside it run the host's own launcher commands, including `cli.mjs stop` with the same `--run-dir`, so that it never sees an inherited Fleet root. A Desktop launch keeps its own owned-`HOME` allowlist in [Desktop setup](desktop/setup.md), because macOS `open` relaunches the bundle with the caller's environment. On Windows, where the wrapper does not run, apply the same owned-path allowlist by hand and report it as such. The one credential-like value the wrapper forwards is the fixed local placeholder `--set ANTHROPIC_API_KEY=sk-ant-fleet-local`, which is not a credential (see [the headless launcher](live-agent-prompt-testing.md)). Any other real store — the user's Claude home, an environment credential, the real Fleet root — needs the user's explicit authorization for that store. Such a run starts outside the wrapper, is disclosed before launch per the [Claude state preflight](claude-state.md), and is reported as non-isolated for that store.
- **After the run:** the wrapper reports which entries appeared in the owned home. After a shell ran in the Shell surface, `.zsh_history` (or the shell's equivalent) there is the positive evidence that history went to the owned home. For a stronger check, type a unique no-op marker such as `: fleet-e2e-<unique-id>` in that shell, close it, and confirm that `grep -c` finds it in `$E2E_DIR/home/.zsh_history`.
- **Real-home reads:** the only reads of real-home files allowed are the scoped digests in the [Claude state baseline](claude-state.md#record-the-baseline-before-any-child-starts) and `grep -c <unique marker>` against the user's shell history file, which prints a count only and should find 0. A denied read leaves that check unverified, not clean. Never print or copy real-home file contents.
- **Self-check before reporting:** confirm that each command that started a host, a shell, an agent CLI, or a pnpm or `tsx` helper for the run went through the wrapper. Confirm that no real-home read went beyond the allowance above, and that no command ran `security`, `login`, or token-refresh helpers. Report any command that ran outside the wrapper as a possible leak with its effect, rather than declaring the home untouched.

The wrapper is an environment boundary for macOS and Linux, not an OS sandbox. It does not isolate the macOS Keychain (see [credential limits](claude-state.md#select-a-child-route-not-just-an-environment-variable)), launchd session keys that `open` adds to a Desktop launch, or network access, and a child can still write to an absolute path it is given. The self-check above applies to the exceptions as well.

A fresh slot has no provider credentials. Do not copy real credentials, trigger login/token refresh, or silently reuse a user's root to make a test pass. Prefer a no-provider fixture when it proves the claim. A real-provider scenario needs an explicitly authorized credential path and quota use, with any non-isolated stores disclosed before launch.

Run the server as a background/managed process and wait for `$E2E_DIR/console/console.lock`. Read `port` and `token` locally, but never print the token. Confirm the route returns `200`. Seed a real Theater through the Console folder UI or authorized API only when the scenario needs it; do not copy the user's durable state. An API-registered Theater stays untrusted for Claude, so a terminal Operation that must receive a Console prompt needs the folder-UI route in [the trust preflight](claude-state.md#prepare-folder-trust-through-the-normal-gate).

Client changes require build plus reload. Host changes require build plus isolated server restart. Compare the asset name in `dist/client/index.html` with the served `/console/` HTML before blaming stale behavior.

### Record what is being reproduced

Before reproducing a user-reported defect, record the user's installed Fleet version or reported surface, the target SHA, and the served asset name. A local `canary` can lag or lead the user's build with a different UI; when they differ, reproduce on a detached [baseline](../../git-worktree/references/baseline.md) at the user's revision rather than assuming the newest checkout shows the same behavior. While measuring, do not let another build write the same `dist/` the owned server serves: use a separate checkout or output, and report a rebuild that landed mid-measurement as a contaminated run.

### First-load onboarding state

A fresh slot and a new origin show commissioning, What's New, welcome slides, entry hints, and feature tours, and they can race the scenario's first input. Prepare that state **before the first navigation** instead of dismissing layers mid-scenario. Once the lock exists, run [`scripts/seed-onboarding.mts`](../scripts/seed-onboarding.mts) with the Console package's `tsx`:

```bash
node <worktree>/.claude/skills/console-e2e/scripts/isolated-env.mjs --run-dir "$E2E_DIR" --bin pnpm \
  -- pnpm --dir <worktree>/runtime/fleet-console exec tsx \
  <worktree>/.claude/skills/console-e2e/scripts/seed-onboarding.mts \
  --console-dir "$E2E_DIR/console" --init-script "$E2E_DIR/whats-new.js"
```

- It derives every key from the current source (core and built-in plugin onboarding contributions, the seen-store key rules, the commissioning key), merges them into `seenFeatureTours` through the origin-gated `PUT /api/v1/settings/global`, reads them back, and fails when one is missing. `--dry-run` only lists the keys. Commissioning also opens only while no Theater is registered.
- What's New is a per-origin `localStorage` watermark, so the script writes it as a page script for `--init-script` of the session that opens the page. Every isolated-server restart picks a new port, which is a new origin: rerun the script and reopen the session. The [Fleet Browser fallback](fleet-browser.md) has no init script; there, dismiss What's New through its real control and record that the watermark could not be preset.
- When the claim concerns onboarding, a tour, or a hint, do not seed or dismiss the layer under test: pass `--keep <key>` (or a prefix ending in `.`, such as `objectives.`) for it, which also clears that key on a reused slot, omit `--init-script` when What's New is under test, and install diagnostics before the first navigation so its appearance and race stay observable.
- Confirm the first screenshot shows no unseeded onboarding layer before acting.

### No-cost fake Claude

When the claim needs a live agent process, MCP tools, or chat protocol traffic but not model output, point `CLAUDE_BIN` at [`scripts/fake-claude.mjs`](../scripts/fake-claude.mjs) instead of the real CLI. It answers `--version`, speaks the SDK stream-json control protocol in chat (`initialize`, `set_model`, `get_context_usage`, one canned turn per user message), and otherwise stays alive as an interactive terminal that echoes input. Nothing reaches a provider, so no quota is spent and no credential is needed.

- Boot through the [Claude state preflight](claude-state.md) environment anyway: add `--set CLAUDE_BIN=<worktree>/.claude/skills/console-e2e/scripts/fake-claude.mjs --set FAKE_CLAUDE_DIR=<owned-run>/fake-claude` to the [wrapper](#keep-the-real-home-out), which keeps `node` on its `PATH`. On Windows, point `CLAUDE_BIN` at the sibling `fake-claude.cmd` instead: Console launches only `.cmd`/`.bat` shims through `cmd.exe`, so a `.mjs` path does not start. A fake binary does not make the rest of the agent route inert.
- `FAKE_CLAUDE_DIR/log.jsonl` records each launch (mode, cwd, `--session-id`/`--resume`, MCP server names), control request, turn and exit without secrets. Use it to prove which Operation launched, resumed or exited. The script header lists the control files for context size, a failing `set_model`, and a held-open turn.
- To act as that launch on Console MCP (an Objectives Commander or member, `fleet-console-use`, and so on), run [`scripts/fake-claude-mcp.mjs`](../scripts/fake-claude-mcp.mjs) `--dir <FAKE_CLAUDE_DIR> --server <name> --tool <tool> --args '<json>'`; `--list` shows the saved launches. The Console-issued bearer tokens stay in owner-only files under `FAKE_CLAUDE_DIR/mcp/`; never print or copy them.
- The fake fires no Claude hooks. Console pins a `--session-id` at launch, which keeps the Operation's identity, but a coordinate whose source is still `launch` resumes as a fresh session. To exercise a real `--resume`, post the capture hook a real CLI would send: `POST /api/v1/agent/sessions/<operation>/capture` with the lock token as Bearer and `{"provider":"claude","input":"{\"session_id\":\"<pinned id>\",\"source\":\"startup\"}"}`. Turn, attention, and background states have their own lock-token hook routes. Recheck the resume and capture contracts in `features/execution/host/agent/routes.ts` when they change.
- Objective Commence and other Console prompts into a fake terminal pass only after the Theater was added through the folder dialog ([trust preflight](claude-state.md#prepare-folder-trust-through-the-normal-gate), step 4); otherwise they return 409 `claude_trust_required` before the fake sees input.
- Label results as fixture evidence. A fake proves launch, lifecycle, MCP and protocol paths, not real CLI behavior, authentication, trust prompts, or model quality.

### UI-only Operation fixtures

For proposal/audit screens that need Operations but no model turn, prefer a dormant fixture in the **owned, stopped runtime's** `state.json`, using the current durable schema and restore tests as the source of truth. Never copy user state or overwrite a running server's state. Inspect `features/workspace/host/durable-state.ts` and the terminal restore contract for the current `payload.session` shape before authoring a fixture. Resume affordances require supported session identity; a fabricated identity is not proof that resume works. Verify the restored Operations through the API and UI without launching a provider.

Do not assume restored Operations are expanded or visible. Dormant fixtures may restore minimized; inspect the actual presentation, restore/arrange it through real UI actions, and confirm the intended cards/tiles in screenshots before a visual sweep. If the scenario truly requires a live terminal body, use the owned Console's Shell surface (toolbar **Shell**) or a [fake Claude](#no-cost-fake-claude) terminal Operation and the current layout controls rather than launching an unnecessary paid agent. A missing fixture or hidden tile is not product-defect evidence.

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
