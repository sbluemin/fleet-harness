# Approved design implementation and verification

### Phase 6 — Implement (after approval)

- Work in a canary-based worktree via the `git-worktree` skill. If canary introduced new packages since the last install, run `corepack pnpm install` in the worktree first (plugin bundles fail to resolve otherwise).
- **Token-first**: add/adjust tokens in `theme.css` base `:root`, retune in each theme variant block. **No CSS comments inside theme variant blocks** — the contract test's declaration matcher treats them as declarations and fails; comments belong in base `:root` only.
- **Schema stability**: for persisted keys (accents, group colors), prefer a read-side legacy mapping (`normalizeAccentKey`/`LEGACY_ACCENT_KEYS` pattern) over a durable-schema migration; keep write-side accepting legacy keys.
- **Co-update the contract test**: `instrument-design-contract.test.ts` is a living contract, not an obstacle — when the grammar legitimately changes, update the pinned counts, block assertions, and token whitelist regex *with* the change. Making the old pins pass without moving the contract is the defect, not the fix.
- **Plugin CSS**: `var()`/`color-mix` only — never introduce a new raw literal while removing an old one.

### Phase 7 — Verify and ship

- Build (tsc — vitest alone does not typecheck) + fleet-console tests + **each touched plugin's own test runner** (fleet-console green ≠ plugin green).
- **Headed visual verification gate before delivery**: compare the result against the approved mock in all three themes with screenshot evidence; if token cohesion falls short or default form styles survive, polish before handing over.
- Ship via the `pr-workflow` skill. Changelog note: a plugin-visible change is a Fleet Console change — it goes under `### fleet-console`, because that is the runtime the user notices it in.

Use `pr-workflow` only when PR publication belongs to the user-authorized delivery scope. Diagnosis or implementation approval does not automatically authorize external publication.
