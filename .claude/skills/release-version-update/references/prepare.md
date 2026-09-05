# Release synchronization and local verification

### Phase 0 — Environment and doctrine

1. Confirm the current path, `git --version`, `gh auth status`, and `gh repo view --json nameWithOwner` for the acting account and `sbluemin/fleet-harness`. Check OS/shell only when command selection depends on them.
2. Read applicable `CLAUDE.md` instructions not already loaded. Run every command below from the verified `<canary-path>`, setting the absolute cwd again for independent calls.

### Phase 1 — Operate on canary, not a topic branch

1. `git worktree list --porcelain` and `git branch --show-current`.
2. Command context must be the checkout whose branch is `canary` (usually the main checkout). If the current worktree is a topic branch, switch every subsequent git command to the canary checkout with `git -C <canary-path>` — do **not** push the topic branch to `main`.
3. `git -C <canary-path> status --short --branch` must be clean. Stop if it is dirty. Do not stash, auto-commit unrelated files, or `git checkout --` to make it clean.

### Phase 2 — Fetch and synchronization

1. `git fetch origin canary main --tags --prune`.
2. Fast-forward the canary checkout: `git -C <canary-path> merge --ff-only origin/canary`. If that fails, stop — local canary has diverged from `origin/canary`.
3. Read `git rev-list --left-right --count origin/main...origin/canary` as `<main_ahead> <canary_ahead>`.

**Diverged (`<main_ahead> ≥ 1` and `<canary_ahead> ≥ 1`).** `main` is not an ancestor of canary, so `git push origin canary:main` would be rejected. Integrate `origin/main` into canary with a merge, never a rebase (canary is public):

- `git -C <canary-path> merge --no-edit origin/main`.
- On conflict: take `origin/main` for compiler-owned `CHANGELOG.md`, `CHANGELOG.ko.md`, and version fields in `package.json`; keep canary's unique product commits and any still-unreleased `.changelog.d/*.md` fragments that the release commit did not consume. Do not hand-write changelog history.
- Push: `git -C <canary-path> push origin HEAD:canary`.
- Recompute the left-right counts. Stop if still diverged.

**Canary behind main only (`<main_ahead> ≥ 1` and `<canary_ahead> == 0`).** Fast-forward canary onto the release commit:

- `git -C <canary-path> merge --ff-only origin/main`
- `git -C <canary-path> push origin HEAD:canary`

Then continue to Phase 3 — this is synchronization, not a new product release.

### Phase 3 — Decide whether anything ships

Re-fetch once before concluding. Then:

- `git log --oneline --decorate origin/main..origin/canary`
- `git diff --stat origin/main...origin/canary`
- `git diff --name-only origin/main...origin/canary`

**Empty range.** The tips already match. Confirm the tip is a published release (`git describe --tags --exact-match origin/main`, `gh release view` not draft, `npm view @dotobokuri/fleet-console version`). Report that there is nothing to ship. Do **not** invent an empty patch, bump versions, or push `main` to retrigger CI.

**Non-empty range.** Summarize:

- Commits waiting on `main`.
- Pending fragments: `.changelog.d/*.md` except `CLAUDE.md`, leftover `AGENTS.md`, `.gitkeep`.
- Commits since the last `chore(release):` that added no fragment (informational; CI compiles with `--allow-empty` and does not block).
- Expected CI bump: run the same grep Stable Release uses. `git log --format=%B origin/main..origin/canary` matching `^[[:space:]]*feat(\([^)]+\))?!?:` is `minor`; otherwise `patch`. That includes `feat!:` / `feat(scope)!:` and a `feat:` line in a commit body, not only a conventional subject. Record the inference. Do not write it into the tree. If the user demanded a version that would disagree with that result, stop and ask.

**Release-trigger gate.** Run `node scripts/release-tip-guard.mjs origin/main origin/canary`. Exit `0` / printed `ignorable:` means every path is in Stable Release `paths-ignore` (docs, `.fleet`, `.github`, `.claude`, `**.md`, except release-input prefixes). Pushing `main` then **does not start** Stable Release. Stop and report those paths. Do not add a dummy product file to force a version. Exit `1` / `release-affecting:` is the expected case for a real release — continue.

### Phase 4 — Full local verify

From `<canary-path>`:

```
pnpm build
pnpm typecheck
pnpm test
node scripts/compile-changelog-fragments.mjs --check --allow-empty
```

Root `pnpm build` already excludes `@dotobokuri/fleet-desktop`; do not add a desktop package unless the user asked. `workspace-verify.yml` is install + typecheck + test (postinstall builds); the explicit `pnpm build` is the operator gate the user asked for. The fragment `--check` is the local gate Stable Release does not run until it compiles notes on `main`; `--allow-empty` matches that compiler flag so a no-fragment range still proceeds.

**On failure:** fix on `canary` immediately — do not wait for a separate authorization. Keep the fix in the failing product; no opportunistic refactors. Commit in English Conventional Commits via HEREDOC (no `--amend`, no `--no-verify`). Push `git -C <canary-path> push origin HEAD:canary`. Re-run the four commands. Repeat until green. Do not push `main` on a red tree.
