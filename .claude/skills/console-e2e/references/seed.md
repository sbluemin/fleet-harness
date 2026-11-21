# Seed an owned Console

One procedure for the data a verification needs before the first navigation: commodores, theaters and, optionally, objectives. It shares **how the assets are made**, not the running environment: every objective runs its own Console through [setup.md](setup.md) and seeds its own slot. Never seed a Console you do not own.

```bash
node .claude/skills/console-e2e/scripts/seed/seed.mjs --dir "$E2E_DIR/console" --profile <name> [--commodores N] [--theaters M] [--objectives K] [--root <theater folders>] [--fake-claude-dir "$FAKE_CLAUDE_DIR"]
node .claude/skills/console-e2e/scripts/seed/seed.mjs --dir "$E2E_DIR/console" --profile ledger --fake-claude-dir "$FAKE_CLAUDE_DIR" --claude-config-dir "$E2E_DIR/claude"
```

The `ledger` profile's synthetic turns prepare a ledger or replay check; creating them does not prove that replay works or that an agent survived.
For long-group measurements, stop the owned Console after seeding `ledger`, run [`group-scale.mjs`](../scripts/seed/group-scale.mjs) through its isolated wrapper, then restart the same slot. Immediately before each measurement (including after reload), pass the intended group’s `expect` from `group-scale.json` to [`window.__fleetGroupReady.judge`](../scripts/group-ready-gate.js); proceed only on `ok: true`.

`--dir` is the owned `FLEET_CONSOLE_DATA_DIR` of a running Console (its `console.lock` names the port). For `--profile advanced --offline`, seed a new slot before its first boot through the [isolated-environment wrapper](setup.md#keep-the-real-home-out) with `--bin pnpm` (the helper starts pnpm/tsx), then boot it. stdout is one JSON object with the ids of what was created, also saved as `<dir>/seed-ids.json`; progress goes to stderr. A slot is seeded once: a run that finds `seed-ids.json` stops before creating anything, so take a fresh slot.

| Profile | Contents |
|---|---|
| `empty` | nothing (first-run states) |
| `basic` | 1 commodore, 1 theater |
| `multi` | 3 commodores, 2 theaters each |
| `objectives` | 1 commodore, 1 theater, 2 objectives, each with a roster entry and 2 missions (board data only: no member session is launched or resumed) |
| `activity` | `objectives` board data, with each commodore's first objective commenced (in-progress commander), a synthetic last reply, and that commodore in a local sidebar section |
| `details` | `activity` (1 objective by default), with brief, criteria, mission records, sealed results and shared files on its commenced objective; excludes actor-rewritten mission-resume records. |
| `advanced` | 3 commodores, no theater: auto memory, base system prompt and subagents requested on/off/unset (no saved override; product defaults apply). Running Console: on/off only (`--commodores 2`). `commodores[].advanced` separates requested, stored and effective values at seed time. |
| `inbox` | 1 commodore, 1 theater, three objectives handed to the person (one criteria proposal, one review, one open follow-up) and one open commodore question. No sidebar section and no transcript turns. |
| `taskforce` | Fixed counts: 2 commodores, 1 taskforce, no theaters or objectives. Enables `taskforce` in the owned slot; other experiments unchanged. Needs the owned fake agent. |
| `ledger` | Fixed: 1 commodore, 1 theater, commenced objectives whose commanders and members each have several synthetic turns. No count overrides. Needs the owned fake agent and `--claude-config-dir` (the isolated-env `claude` directory, not the console data dir). |

Counts override with the flags, except profiles whose row says the counts are fixed (`taskforce`, `ledger`). Theater folders are created under `--root` (default `<os tmpdir>/seed-theaters/<slot hash>`), outside every repository as [setup.md](setup.md) requires; remove them with the run.

- `objectives` and `inbox` need the owned fake agent (`CLAUDE_BIN` = [`fake-claude.mjs`](../scripts/fake-claude.mjs), `--fake-claude-dir` = its `FAKE_CLAUDE_DIR`): the Commodore's `objective` tool is the only creator, so the seed queues `sdk-calls` and wakes the commodore. `inbox` then drives the fake Commander's tools the way `details` does, and hands each waiting item to the person. `add` does not pass a Commander model; that model is chosen when the objective is planned or commenced. `--objectives` does not apply to `inbox`.
- `activity` and `details` use the same owned fake-agent setup (no provider). Keep the Console running: stopping ends the live fake sessions; restored display/history after restart does not prove a live fake session. Read `commodores[].activity` in the seed output for `inProgressObjectiveId`, `lastResponse`, `sectionId`, and `sectionName`.
- For `taskforce`, start the Console with the same owned fake-agent setup as `objectives`/`inbox`; `--fake-claude-dir` neither sets nor checks the running Console's `CLAUDE_BIN`. Use only this run's seed-output IDs: `commodores[].commodoreId` and `taskforce.taskforceId`.
- Marking first-run layers as seen is a separate step: [`seed-onboarding.mts`](../scripts/seed-onboarding.mts).
- Composition lives in [`scripts/seed/lib.mjs`](../scripts/seed/lib.mjs) (API calls, ownership order) and [`fixtures.mjs`](../scripts/seed/fixtures.mjs) (profiles). Use a shared profile as the baseline; keep scenario-specific additions in the objective’s fixture, reusing the helpers.
- **Members.** The `objectives` roster is one default `worker` with no model chosen (`launch: null`, routed when mustered). An exact roster is not a profile option: take a fresh slot, have the Commodore `add` a new objective as [`ledger.mjs`](../scripts/seed/ledger.mjs) does (the same `objective` call), then `make.member(found.id, { role, launch: { mode: "model", model } })` for each intended member, with `model` an ID the target build offers (`make.model()` reads `GET /api/v1/ai-gateway/candidates`; `member/add` does not check it against that list). This is the call pattern, not the `ledger` profile. For a board-only check, stop after the members: no Plan or Commence. In a read-back, `members[].launch` is the saved selection; `members[].model` and `effort` are the running session's values and are absent until it starts.

## Memory and intel scale

On a running owned Console booted with the owned fake agent (description and intel wake the commodore; no provider):

```bash
node .claude/skills/console-e2e/scripts/seed/memory-scale.mjs --dir "$E2E_DIR/console"
```

Writes fleet-memory only under that slot. `POST /api/v1/commodore/memory` is read-only, so there is no API write and the helper does not touch `MEMORY.md`. Description and intel use the product routes. stdout is one JSON object, also `<dir>/memory-scale.json`, with the counts and branch distribution read back from the API. An existing `memory-scale.json` stops the run.

## Canary default-screen check

`node scripts/check-canary-screen.mjs` builds nothing: with the Console built, it serves it in a temp slot with the fake agent, seeds `basic`, loads the default screen in headless Chrome (`CHROME_BIN` or a standard path) and exits 1 on a thrown error, `console.error`, a 5xx answer or an empty screen. `--probe` prints the DOM summary instead. CI runs it as `.github/workflows/canary-screen.yml` after every canary merge and on relevant pull requests.
