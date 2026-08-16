---
name: release-version-update
description: canary를 현행화하고 전체 검증한 뒤 main에 fast-forward해 Stable Release 워크플로로 배포하는 절차를 정의합니다.
---

# Release Version Update

Use this skill when the user asks to release fleet-harness, ship canary, cut a version, or sync canary and release. Invoking the skill authorizes **direct canary work** and a **fast-forward push of canary onto `main`**.

## Goal

Ship the current `origin/canary` tip through `.github/workflows/stable-release.yml`. That workflow is the sole owner of version math, workspace `package.json` sync, changelog compilation, the `chore(release): vX.Y.Z` commit, the git tag, the GitHub Release, npm publish of `@dotobokuri/fleet-console`, and desktop/mobile assets.

This skill does **not** locally bump versions, compile `CHANGELOG.md` / `CHANGELOG.ko.md`, create tags, or publish. The operator sequence is:

1. Fast-forward local `canary` to `origin/canary` (and onto `origin/main` when canary is behind a release commit).
2. Run the full local build, typecheck, and test.
3. If green, fast-forward `origin/canary` onto `main` so Stable Release runs.
4. If verification fails, fix on `canary`, commit, push, re-verify, then do the same fast-forward.
5. Wait until Stable Release finishes successfully.
6. Fast-forward `canary` to the new `chore(release):` commit — the workflow does not do that itself.

## Inputs

None required. Optional free-form user text may only:

- Insist on a fresh `git fetch` before concluding that nothing is waiting (always fetch anyway).
- Ask to stop after 현행화 without pushing `main`.
- Ask to keep watching a named Stable Release run.

A user-supplied version number is **not** an input. CI computes patch vs minor from `feat` commits since the latest `v*` tag. If the user demands a version that would disagree with that rule, stop and ask — do not write the number into `package.json`.

## Required Workflow

### Phase 0 — Environment and doctrine

1. Confirm in parallel: `pwd`; `uname -a`; `echo "SHELL=$SHELL"`; `git --version`; `gh auth status`; `gh repo view --json nameWithOwner` (must be `sbluemin/fleet-harness`).
2. Read the repository root `CLAUDE.md`.

### Phase 1 — Operate on canary, not a topic branch

1. `git worktree list --porcelain` and `git branch --show-current`.
2. Command context must be the checkout whose branch is `canary` (usually the main checkout). If the current worktree is a topic branch, switch every subsequent git command to the canary checkout with `git -C <canary-path>` — do **not** push the topic branch to `main`.
3. `git -C <canary-path> status --short --branch` must be clean. Stop if it is dirty. Do not stash, auto-commit unrelated files, or `git checkout --` to make it clean.

### Phase 2 — Fetch and 현행화

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

Then continue to Phase 3 — this is 현행화, not a new product release.

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

**Release-trigger gate.** Run `node scripts/release-tip-guard.mjs origin/main origin/canary`. Exit `0` / printed `ignorable:` means every path is in Stable Release `paths-ignore` (docs, `.fleet`, `.github`, `.claude`, `.agents`, `**.md`, except release-input prefixes). Pushing `main` then **does not start** Stable Release. Stop and report those paths. Do not add a dummy product file to force a version. Exit `1` / `release-affecting:` is the expected case for a real release — continue.

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

### Phase 5 — Fast-forward main (this is the release)

1. `git fetch origin canary main`.
2. Confirm `git merge-base --is-ancestor origin/main origin/canary`.
3. Confirm the canary working tree is still clean and matches `origin/canary`.
4. `git push origin origin/canary:main`.

That push must be a fast-forward. If GitHub rejects it, stop. Never `--force`, never `--force-with-lease` to `main`, never merge on `main`, never push a topic SHA.

Stable Release starts only when the pusher is not `github-actions[bot]` and the changed paths are not all ignored. The first job commit message is the canary tip subject, not `chore(release):`.

### Phase 6 — Watch Stable Release to completion

1. Resolve the run whose `headSha` is the SHA just pushed to `main`:

   ```
   gh run list --repo sbluemin/fleet-harness --branch main --workflow "Stable Release" \
     --json databaseId,headSha,status,conclusion,url,displayTitle --limit 10
   ```

2. Watch that run until it reaches a terminal conclusion (`gh run watch <id> --exit-status`, or poll). Typical wall-clock is several minutes (verify + npm). Do not declare success from a still-running `release` job.

3. Success means all of:

   - Run `conclusion: success`.
   - `resolve`, `verify / verify`, `release`, `console / publish`, and `publish-release` succeeded.
   - Exactly one of `desktop-build` or `desktop-carry` succeeded (the other is skipped).
   - `git fetch origin main --tags` shows `origin/main` as `chore(release): vX.Y.Z`.
   - `gh release view vX.Y.Z --json isDraft,publishedAt,tagName,url` is not a draft.
   - `npm view @dotobokuri/fleet-console version` equals `X.Y.Z`.

4. On failure: stop. Report the run URL and the failed job. Do not locally craft a `chore(release):` commit, tag, or npm publish to "finish" it. Re-running the failed GitHub jobs is allowed; pushing a new empty commit to `main` is not, unless the user explicitly directs a recovery.

### Phase 7 — Fast-forward canary to the release commit

Stable Release does **not** move `canary`. After Phase 6 success:

```
git fetch origin main canary --tags
```

Then:

- If `origin/canary` is still an ancestor of `origin/main` (no concurrent canary landings): `git -C <canary-path> merge --ff-only origin/main`, then `git -C <canary-path> push origin HEAD:canary`.
- If `origin/canary` advanced while CI ran (`git rev-list --left-right --count origin/main...origin/canary` shows both sides ahead): first `git -C <canary-path> merge --ff-only origin/canary` so the checkout matches the advanced tip, then `git -C <canary-path> merge --no-edit origin/main` with the same changelog/version conflict rule as Phase 2, then `git -C <canary-path> push origin HEAD:canary`. Do not force-push. Stop if that merge is still diverged after the push.

If local `main` exists and is not checked out in another worktree, fast-forward that ref too (`git fetch origin main:main`). Confirm `origin/main` is the `vX.Y.Z` release commit and that `origin/canary` contains it. When no concurrent work landed, `canary` = `origin/canary` = `origin/main` = `vX.Y.Z`. When concurrent work landed, report that canary contains the release commit and is ahead of `origin/main`.

### Phase 8 — Report in Korean

- Canary checkout path and that HEAD was `canary`.
- 현행화: old canary SHA → SHA after fetch/FF/merge, and whether `origin/main` had to be merged in.
- Commits shipped (`origin/main` before the push → canary tip pushed).
- Pending fragments consumed vs commits with no fragment.
- Local `pnpm build` / `typecheck` / `test` / fragment `--check` pass or fail; any canary fix commit SHAs.
- Whether `release-tip-guard` reported release-affecting or ignorable.
- Main push SHA and the Stable Release run URL.
- Published version, tag, GitHub Release URL, npm version, desktop built vs carried.
- Final refs: equality of `canary` / `origin/canary` / `origin/main` / the version tag, or that canary contains the release commit and is ahead, or that 현행화 found nothing to ship.

## Host Synthesis

The Korean report, the commit-without-fragment audit, and any operator summary of what ships are host-owned. Synthesize them directly from the branch diff, commit history, and validated `.changelog.d/` fragments — never delegate release-note synthesis. Do not invent release bullets, do not rewrite fragment prose, and do not edit `CHANGELOG.md` or `CHANGELOG.ko.md`.

## Safety Rules

- Do not locally change `package.json` version fields, `pnpm-lock.yaml` importer versions, `CHANGELOG.md`, or `CHANGELOG.ko.md` for a release.
- Do not run `pnpm version`, `node scripts/compile-changelog-fragments.mjs --version`, `git tag`, `gh release create`, or `npm publish`.
- Do not push a topic branch or worktree HEAD to `main`. The refspec is `origin/canary:main` (or `canary:main` from the canary checkout).
- Do not `--force` / `--force-with-lease` to `main` or `canary`.
- Do not rebase `canary` onto `main`; merge `origin/main` into canary when they have diverged.
- Do not invent an empty release when `origin/canary` equals `origin/main`.
- Do not push `main` on a red local verify, and do not skip local verify because CI will run `workspace-verify` anyway.
- Do not bypass Git hooks (`--no-verify`, `--no-gpg-sign`).
- Commit messages stay English Conventional Commits. Final operator prose is Korean.
