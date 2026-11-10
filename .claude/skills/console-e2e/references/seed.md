# Seed an owned Console

One procedure for the data a verification needs before the first navigation: commodores, theaters and, optionally, objectives. It shares **how the assets are made**, not the running environment: every objective boots its own Console through [setup.md](setup.md) and seeds that slot. Never seed a Console you do not own.

```bash
node .claude/skills/console-e2e/scripts/seed/seed.mjs --dir "$E2E_DIR/console" --profile <name> [--commodores N] [--theaters M] [--objectives K] [--root <theater folders>] [--fake-claude-dir "$FAKE_CLAUDE_DIR"]
```

`--dir` is the owned `FLEET_CONSOLE_DATA_DIR` of a running Console (its `console.lock` names the port). stdout is one JSON object with the ids of what was created, also saved as `<dir>/seed-ids.json`; progress goes to stderr. A slot is seeded once: a run that finds `seed-ids.json` stops before creating anything, so take a fresh slot.

| Profile | Contents |
|---|---|
| `empty` | nothing (first-run states) |
| `basic` | 1 commodore, 1 theater |
| `multi` | 3 commodores, 2 theaters each |
| `objectives` | 1 commodore, 1 theater, 2 objectives, each with a roster entry and 2 missions (board data only: no member session is launched or resumed) |

Counts override with the flags. Theater folders are created under `--root` (default `<os tmpdir>/seed-theaters/<slot hash>`), outside every repository as [setup.md](setup.md) requires; remove them with the run.

- `objectives` needs the owned fake agent (`CLAUDE_BIN` = [`fake-claude.mjs`](../scripts/fake-claude.mjs), `--fake-claude-dir` = its `FAKE_CLAUDE_DIR`): the Commodore's `objective` tool is the only creator, so the seed queues one `sdk-calls` entry per objective and wakes the commodore. `add` does not pass a Commander model; that model is chosen when the objective is planned or commenced.
- Marking first-run layers as seen is a separate step: [`seed-onboarding.mts`](../scripts/seed-onboarding.mts).
- Composition lives in [`scripts/seed/lib.mjs`](../scripts/seed/lib.mjs) (API calls, ownership order) and [`fixtures.mjs`](../scripts/seed/fixtures.mjs) (profiles). Use a shared profile as the baseline; keep scenario-specific additions in the objective’s fixture, reusing the helpers.

## Canary default-screen check

`node scripts/check-canary-screen.mjs` builds nothing: with the Console built, it serves it in a temp slot with the fake agent, seeds `basic`, loads the default screen in headless Chrome (`CHROME_BIN` or a standard path) and exits 1 on a thrown error, `console.error`, a 5xx answer or an empty screen. `--probe` prints the DOM summary instead. CI runs it as `.github/workflows/canary-screen.yml` after every canary merge and on relevant pull requests.
