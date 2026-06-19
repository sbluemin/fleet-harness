---
name: pr-workflow
description: End-to-end PR lifecycle on sbluemin/fleet-harness — commit staged work, open a PR as the authenticated user, await the Codex automated review, apply feedback under an Admiral judgment gate, request re-review, detect approval, and auto-merge the approved PR (rebasing the head onto canary and force-pushing first when it conflicts). Supersedes the former pr-creates and pr-review-fixes skills.
---

# PR Workflow

Use this skill to drive a change from committed work to a merged pull request on `sbluemin/fleet-harness`, mirroring the full cycle the Admiral runs by hand: **commit → open PR → await Codex review → judge & apply feedback → re-review → detect approval → auto-merge**.

This is a single end-to-end workflow. Enter at Phase 1 for a fresh change; if the branch is already committed and pushed with an open PR, skip to Phase 3 to resume at the review loop; if the PR is already approved, resume at Phase 6 to merge it.

## Inputs

Replace each `<placeholder>` before running. Optional inputs may be left blank — defaults will be inferred.

- `<commit_subject>` — Conventional Commits subject for the initial commit. Optional. If omitted, derive from the dominant change in the staged/working diff.
- `<commit_body>` — Optional commit body. If omitted, summarize the change as bullets.
- `<title>` — Conventional Commits PR title (≤ 70 chars). Optional. If omitted, derive from `git log <base>..HEAD`.
- `<body>` — Markdown PR body. Optional. If omitted, auto-build a Summary + Test Plan from the diff, following `.github/PULL_REQUEST_TEMPLATE.md` style (Korean prose is fine; the PR title stays English Conventional Commits).
- `<base>` — Base branch. Optional. Default `canary`. `main` / `master` are rejected unless explicitly overridden.
- `<head>` — Head branch. Optional. Default = current branch. Must not equal `<base>`.
- `<draft>` — `true` | `false`. Optional. Default `false`.
- `<scope_hint>` — Optional. Free-form note restricting review-fix scope (e.g., "only Codex P1/P2"). If omitted, default to "every actionable, unresolved review comment on the PR".
- `<review_poll_interval>` — Optional. Poll cadence for the Phase 3 background wait loop (e.g., `30s`). If omitted, default ~`30s` for the background poll (or `1m` for the cron fallback).
- `<repo>` — `owner/name` slug. Optional. If omitted, infer from `gh repo view --json nameWithOwner` (must be `sbluemin/fleet-harness`).
- `<merge_method>` — `squash` | `merge` | `rebase`. Optional. Default `squash` (the repo convention — squash-merge titles read `type(scope): summary (#N)`). Used by Phase 6 auto-merge.
- `<auto_merge>` — `true` | `false`. Optional. Default `true`. When `true`, Phase 6 merges the PR after approval (rebasing the head onto `<base>` and force-pushing first when it conflicts). When `false`, stop at approval and report the PR as approved-but-unmerged (the legacy behavior).
- `<pr_number>` — Target PR number. When entering at Phase 1 it is produced by Phase 2 (PR creation). When **resuming** at Phase 3/4/5/6 for an already-open PR it is **required** — if absent, resolve it from the current branch via `gh pr view --json number,headRefName` before polling. `<headRefName>` (the PR head branch) is recorded alongside it and is the only branch Phases 4–6 push to.

## Goal

Publish a PR authored by the authenticated user's GitHub account, carry it through the Codex automated review by applying only the feedback that passes the Admiral judgment gate, and — once Codex signals approval — auto-merge the PR into `<base>` (rebasing the head onto `<base>` and force-pushing first when the PR conflicts), unless `<auto_merge>` is `false`.

## Changelog Fragment Requirement

Every release-impacting PR must include one unique `.changelog.d/*.md` fragment unless the PR intentionally carries the `no-changelog` label. Fragments use `section: Added`, `Changed`, `Fixed`, `Removed`, or `Breaking Changes`, and English bullets tagged only with `[core-agent]`, `[core-unified-agent]`, `[fleet-infra]`, `[fleet-admiral]`, `[fleet-carriers]`, `[fleet-wiki]`, `[fleet-console]`, or `[fleet-cli]`. **Bullets must be ASCII-only English** — no `⌘`/arrow glyphs/em- or en-dashes/other non-ASCII (the compiler rejects them with "bullet summary must be English ASCII text"), so describe shortcuts as `Cmd+K`, not `⌘K`. Validate locally with `node scripts/compile-changelog-fragments.mjs --check` **before pushing** (a non-ASCII bullet blocks the merge-gate compile).

## Admiral Judgment Policy

Review comments are not accepted unconditionally. Every item must pass an Admiral-of-the-Navy judgment gate before being applied.

Classify an item as **decline-with-rationale** when any of the following hold:

1. **Context-blind** — The comment was written without awareness of the PR's background, intent, prior decisions, persistent memory feedback, or an in-flight staged refactor.
2. **Overfitting** — Defensive changes that exceed PR scope, overgeneralization from a single incident, or asks whose change cost is clearly disproportionate to the value. Meta-suggestions targeting prompt / doctrine / `AGENTS.md` content carry the highest overfitting risk.
3. **No user-visible value** — Items that produce no behavioral change for users or operators. Pure stylistic preference, theatrical safety, or micro-optimization fall here.

**Decline is not avoidance.** Every decline must cite at least one piece of evidence:

- A PR context fact the comment missed (commit message, prior decision, or memory feedback — one line).
- A stated mismatch between the PR's intent and the comment's ask.
- A user-stated "right-approach" principle.

**Decline ≠ silence.** When an item is declined: list it with reason and cited evidence in the final report, and post a short courteous decline note in the `## Notes` section of the `@codex` follow-up comment.

**Decline is inappropriate** (classify as fix or defer instead) when the comment correctly identifies a real user-visible regression, consistency break, security flaw, or potential data loss; when it aligns with the PR's stated intent; or when verification confirms an ambiguous concern is real — escalate ambiguous cases to the user.

This policy governs Phase 4 (classification / verification) and Phase 5 (self-verification audit).

## Required Workflow

### Phase 0 — Environment & doctrine (always first)

1. Confirm the environment in parallel: `pwd`; OS info (`uname -a`); shell (`echo "SHELL=$SHELL"`); `gh auth status`; `gh repo view --json nameWithOwner` (must equal `sbluemin/fleet-harness`).
2. Read the repository root `AGENTS.md`. For each subdirectory the change touches, read its `AGENTS.md` too — child rules override parent rules within their scope.
3. For release-impacting changes, confirm the PR will include a `.changelog.d/*.md` fragment or intentionally use the `no-changelog` label.

### Phase 1 — Commit

1. Inspect: `git status --short --branch`; `git branch --show-current`.
2. Stage only the files belonging to this change: `git add <file> [<file> ...]`. Do not use `git add -A` / `git add .` unless every pending change belongs to this commit.
3. Write the commit message in English using Conventional Commits (allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`). Subject `<commit_subject>` or inferred; body `<commit_body>` or addressed-change bullets.
4. Pre-commit self-check: re-read `git diff --cached` once and confirm the subject/body match what is staged — nothing more, nothing less.
5. Commit via HEREDOC. Do NOT use `--amend`, `--no-verify`, `--no-gpg-sign`, or any hook bypass. If a pre-commit hook fails, fix the cause and create a new commit (never amend).

### Phase 2 — Open the PR

1. Resolve `<head>` (default current branch) and `<base>` (default `canary`; reject `main`/`master` unless overridden). If `<head>` equals `<base>`, stop and ask.
2. `git push -u origin <head>` and verify `git status --short --branch` reports up-to-date with the remote.
3. Build PR metadata: derive `<title>` (≤ 70 chars, Conventional Commits) and `<body>` (`## Summary` 1–3 bullets + `## Test Plan` checklist) if not provided.
   - Include the changelog fragment checklist state from `.github/PULL_REQUEST_TEMPLATE.md`.
4. Echo the final title/body/base/head/draft once for the record, then create directly — invoking this skill is itself the authorization to open the PR, so do not pause for a separate confirmation round-trip. The safety guards still bind: the base-branch guard rejects `main`/`master` unless explicitly overridden, and `<head>` must not equal `<base>` (step 1). Pause for the Admiral of the Navy only when metadata is genuinely ambiguous or a safety guard trips.
   ```bash
   gh pr create --repo sbluemin/fleet-harness --base "$base" --head "$head" \
     --title "$title" --body "$(cat <<'EOF'
   ## Summary
   ...
   ## Test Plan
   ...
   EOF
   )" $( [ "$draft" = "true" ] && echo "--draft" )
   ```
5. Record the PR identity for the rest of the workflow: `<pr_number>` (number), `<repo>`, the PR URL, and `<headRefName>` (= `<head>`, the only branch Phases 4–6 push to). These are the target for Phases 3–7.

### Phase 3 — Await the Codex review (deterministic background poll)

The Codex automated reviewer (`chatgpt-codex-connector[bot]`) posts asynchronously. The skill **waits with a deterministic background poll that wakes you only when something real changes** — never ask the Admiral to run `/loop` by hand, and prefer this over a fixed-interval cron that re-invokes the model every tick whether or not anything happened. A cheap `gh` loop runs in the background (no model tokens) and re-invokes you on the first genuine signal.

0. **Ensure PR metadata and the right branch.** Confirm `<pr_number>`, `<repo>`, and `<headRefName>` are known. On a fresh run they come from Phase 2; on a resume entry, resolve them first via `gh pr view --json number,headRefName,url` for the current branch (or the `<pr_number>` carried in the resume prompt). Never poll or push without them. Then confirm the **current branch equals `<headRefName>`** (`git branch --show-current`); if it does not, stop and ask the Admiral before editing or committing — do not auto-checkout and never commit fixes onto a non-head branch. Finally confirm the **working tree is clean** (`git status --short`); if there are unrelated uncommitted changes, stop and ask the Admiral before editing — never overwrite them or fold pre-existing changes into a review-fix commit.
1. **Freeze the wait baseline.** Record what is *already* on the PR so the poll only fires on something new: the latest pushed head commit timestamp `HEAD_TS` (`gh api repos/<repo>/commits/<head_sha> -q .commit.committer.date`, or the time of the Phase 2 / Phase 5 push) and the current review count `BASE_REVIEWS` (`gh pr view <pr_number> --repo <repo> --json reviews -q '.reviews | length'`).
2. **Launch the background poll (signal-driven, not interval-driven).** Start one `run_in_background` Bash loop that polls with `gh` every ~30s (or `<review_poll_interval>`), capped at ~40 min, and **exits — re-invoking you — only on a genuine signal**, printing which:
   - **approval** — a `chatgpt-codex-connector[bot]` `+1` reaction on the PR body with `created_at > HEAD_TS` (fresh, not a stale carry-over);
   - **new review** — the review count exceeds `BASE_REVIEWS` (a new review pass carries its inline comments);
   - **new top-level** — a Codex top-level comment with `created_at > HEAD_TS`.
   On timeout it prints `TIMEOUT`; relaunch it. Report the background task id. Do not run model turns between signals.
   - **Re-anchor caveat — do not detect feedback by `commit_id`.** After each push GitHub re-anchors still-open review comments onto the newest commit, so an already-addressed comment reappears with `commit_id == <new head>` and would trip a false "new inline" signal. Detect new feedback by the **review count** and by **comment/reaction `created_at` vs `HEAD_TS`** only — never by matching `commit_id` to the head.
   - Reference loop (run it as the loop itself with `run_in_background: true`; its completion notification re-invokes you):
     ```bash
     REPO=<repo>; PR=<pr_number>; HEAD_TS="<iso8601 of latest push>"; BASE=<BASE_REVIEWS>
     for i in $(seq 1 80); do
       PLUS=$(gh api repos/$REPO/issues/$PR/reactions -H "Accept: application/vnd.github.squirrel-girl-preview+json" \
         -q "[.[]|select(.user.login==\"chatgpt-codex-connector[bot]\" and .content==\"+1\" and (.created_at > \"$HEAD_TS\"))]|length")
       RC=$(gh pr view $PR --repo $REPO --json reviews -q ".reviews|length")
       TOP=$(gh api repos/$REPO/issues/$PR/comments \
         -q "[.[]|select(.user.login==\"chatgpt-codex-connector[bot]\" and (.created_at > \"$HEAD_TS\"))]|length")
       [ "${PLUS:-0}" -gt 0 ] && { echo "SIGNAL=APPROVED"; exit 0; }
       [ "${RC:-$BASE}" -gt "$BASE" ] && { echo "SIGNAL=NEW_REVIEW"; exit 0; }
       [ "${TOP:-0}" -gt 0 ] && { echo "SIGNAL=NEW_TOPLEVEL"; exit 0; }
       sleep 30
     done
     echo "SIGNAL=TIMEOUT"; exit 0
     ```
     Do **not** wrap the loop in `nohup … &` — that detaches it from the harness, so its exit never re-invokes you. The `run_in_background` call itself is the only backgrounding needed.
3. **On wake, read the full state and route.** When the poll exits, read: `gh pr view <pr_number> --repo <repo> --json reviews,comments,reviewDecision`; inline comments `gh api repos/<repo>/pulls/<pr_number>/comments`; top-level comments `gh api repos/<repo>/issues/<pr_number>/comments`; PR-body reactions `gh api repos/<repo>/issues/<pr_number>/reactions -H "Accept: application/vnd.github.squirrel-girl-preview+json"`. Then:
   - **Approval = merge trigger.** A fresh `chatgpt-codex-connector[bot]` `+1` on the PR body (`created_at` newer than both the latest pushed head commit and the most recent `@codex` re-review comment) **and** no new actionable comments → approval is final, go to Phase 6 (auto-merge). A `+1` predating the latest push is stale (GitHub keeps the old reaction) — ignore it. A bare `eyes` reaction means the review is still in progress (pending), not approval.
   - **New actionable feedback** → Phase 4.
   - **Spurious wake or timeout** (only `eyes`, a re-anchored old comment, or nothing genuinely new) → relaunch the background poll (step 2) and keep waiting.

**Fallback — cron.** If the harness cannot re-invoke you when a background task completes, fall back to a recurring `CronCreate` (`*/1 * * * *`, `recurring: true`, prompt re-entering Phase 3 with `<pr_number>`/`<repo>`), armed exactly once; the same baseline, freshness, and re-anchor rules apply on each tick. Stop it with `CronDelete` at Phase 6 (instead of `TaskStop`).

### Phase 4 — Judge & apply feedback

1. Collect and group review items by author/severity (Codex P1/P2/P3, human asks, nits). Filter to `<scope_hint>`.
2. For each item, **verify the underlying claim against the current code/docs before editing** — review comments may be stale, speculative, or based on assumptions the repo does not hold.
3. Decide one of **fix / decline-with-rationale / defer** per item under the **Admiral Judgment Policy** above. Do not default to fix — default to review-then-decide. Record each decision and its evidence; never silently skip.
4. Apply changes narrowly — restrict edits to the files/lines the verified items demand. No opportunistic refactors, renames, or formatting churn. Prefer `Edit` over full-file rewrite; re-read each file immediately before editing. New code comments in Korean.
5. Delegate to **Genesis** (`carrier_dispatch`, `carrier_id: "genesis"`) for multi-file or non-trivial fixes with `<objective>`/`<scope>`/`<constraints>`/`<references>` blocks; apply trivial single-file edits directly.

### Phase 5 — Re-validate, commit, push, request re-review

1. Self-verification (before external checks): walk the diff hunk by hunk — every hunk maps to a recorded item (else revert as scope creep); every fix-item is reflected; decline/defer rationale is evidence-backed, not speculation; no boundary/scope breach; no unverified runtime assumption; new comments Korean; files re-read before edit; no single-call-site abstraction; replay each original comment ("does this concern still hold?").
2. External checks: `git status --short` + `git diff --stat` (only intended files); run available checks for touched workspaces — `pnpm --filter <pkg> typecheck`, `build` (tsc — vitest alone does NOT typecheck), `test`. State explicitly if a script is absent.
3. Commit the fixes (Conventional Commits, HEREDOC, no amend/bypass) staging only the fix files.
4. Confirm the current branch is `<headRefName>` (the recorded PR head); if it is not, stop and ask — do not push fixes from a non-head branch. Push the current commit explicitly with an `HEAD:<headRefName>` refspec so the actual fix commit lands on the PR branch (a bare `git push origin <headRefName>` pushes the like-named local ref, not necessarily current HEAD): `git push origin HEAD:<headRefName>`; then verify the local branch is up-to-date with the remote.
5. Post the `@codex` re-review comment via HEREDOC only after the push is visible on the remote:
   ```bash
   gh pr comment <pr_number> --repo <repo> --body "$(cat <<'EOF'
   @codex The review feedback has been addressed. Please re-review.

   ## Addressed
   - <item — file:line — one-line fix summary>
   ## Validation
   - <command — result>
   ## Notes
   - <declined items with rationale, deferred items with follow-up>
   EOF
   )"
   ```
6. Return to Phase 3 to await the next review pass.

### Phase 6 — Auto-merge

Reached only after Phase 3 confirms a final approval (a fresh Codex `+1` with no open actionable comments). When `<auto_merge>` is `false`, skip this phase: stop the Phase 3 wait poll (`TaskStop` the background task, or `CronDelete` the cron-fallback job) and go straight to Phase 7, reporting the PR as approved-but-unmerged.

1. **Stop the wait loop.** Stop the Phase 3 background poll — `TaskStop` its task id (or `CronDelete` the cron-fallback job). Approval is final, no more review polling.
2. **Check mergeability.** `gh pr view <pr_number> --repo <repo> --json mergeable,mergeStateStatus,baseRefName,headRefName`.
   - `mergeable: MERGEABLE` with `mergeStateStatus` `CLEAN` / `UNSTABLE` / `BEHIND` (no conflict) → go to step 4 (merge directly).
   - `mergeable: CONFLICTING` or `mergeStateStatus: DIRTY` → the head conflicts with `<base>`; go to step 3 (rebase path).
   - `mergeable: UNKNOWN` → GitHub is still computing mergeability; wait briefly and re-check before deciding.
3. **Conflict path — rebase the head onto `<base>`, then force-push.**
   1. Invoke the **rebase-on-canary** skill against the PR head (current-branch mode in the head's worktree, or its explicit `<worktree_path>`) with base = `<base>`. By default that skill auto-resolves conflicts by integrating both sides and validates the result.
   2. rebase-on-canary escalates only a genuinely ambiguous/unsafe conflict or a post-rebase validation failure. If it escalates, **halt auto-merge** and surface its report to the Admiral of the Navy — do not merge.
   3. On a successful rebase (clean or auto-resolved), confirm the current branch is `<headRefName>`, then publish the rewritten history with a lease: `git push --force-with-lease origin HEAD:<headRefName>`. Never `--force`; never force-push `<base>`.
   4. Re-check mergeability (step 2). The rebase preserves the approved change reconciled with the new base; if `mergeable` is still not `MERGEABLE`, halt and escalate.
4. **Merge.** `gh pr merge <pr_number> --repo <repo> --<merge_method>` (default `--squash`, matching the repo convention). Do not pass `--admin` or otherwise bypass branch protection or a required check — if the merge is rejected, halt and escalate.
5. **Verify the merge.** `gh pr view <pr_number> --repo <repo> --json state,mergedAt,mergeCommit` — confirm `state: MERGED` and record the merge commit SHA.
6. Go to Phase 7.

### Phase 7 — Cleanup & completion

**Autonomous cleanup (only when the merge succeeded).** When Phase 6 confirmed `state: MERGED`, clean up the merged head branch's local artifacts yourself — do **not** ask the Admiral of the Navy. Follow the git-worktree skill's remove flow:
1. If `<headRefName>` is checked out in a dedicated worktree under `.fleet/worktrees/`, run that remove flow against it: leave the worktree directory (`cd` to the main checkout), kill the matching tmux session if present, `git worktree remove --force <path>` + `git worktree prune`, then `git branch -D <headRefName>` (a squash merge leaves the branch "unmerged" to `-d`, so force-delete is expected).
2. If the head branch was worked directly in the main checkout (no separate worktree), switch to `<base>` (`git switch <base>`) and `git branch -D <headRefName>`.
3. Hard stops — never cross even autonomously: never delete the main checkout, and never delete a protected branch (`main` / `master` / `<base>`). The remote head branch is typically auto-deleted by GitHub on merge; otherwise leave it unless remote cleanup was requested.
4. Skip cleanup entirely when `<auto_merge>` is `false` or the merge halted — the branch and its worktree must survive for follow-up.

Then report in Korean:
- PR number, title, head/base, URL, draft flag.
- Each review item across all passes: fix / declined / deferred, with verification evidence.
- Files changed, commit SHA(s), push target(s).
- Validation commands and pass/fail status; note any check not run.
- The approval signal observed (Codex `+1` on the PR body) and the `@codex` follow-up comment URL(s).
- **Merge outcome**: merged (`<merge_method>` + merge commit SHA + whether a pre-merge rebase/force-push was needed), or — when `<auto_merge>` is `false` or auto-merge halted — the approved-but-unmerged state and the reason. The Phase 3 wait poll was stopped in Phase 6.
- **Cleanup outcome**: worktree removed / tmux session killed / local branch force-deleted, or skipped (with reason).

## Carrier Delegation Guidance

- **Genesis** — implementation of fixes (default for ≥ 2 files or non-trivial logic).
- **Sentinel** — additional code/security review when a fix touches concurrency, auth, input validation, or other sensitive surfaces.
- **Nimitz** — only when reviewers disagree or a fix needs an architecture decision (read-only).
- **Chronicle** — only when a fix introduces doc impact beyond touched code (README/CHANGELOG/AGENTS.md).
- Skip delegation for trivial single-file edits.

## Safety Rules

- Do not push commits directly to `main` / `master` / `<base>` or any protected branch — local pushes target only the PR's `headRefName`. Phase 6 integrates into `<base>` exclusively through the server-side `gh pr merge`, never a local push to the base.
- Do not address review items outside `<scope_hint>` that the user did not ask for.
- Do not silently expand scope: no opportunistic refactors, formatting-only churn, or dependency bumps.
- Do not create a new branch mid-flow, amend, or close/reopen the PR. Do not rebase or force-push **except** the Phase 6 auto-merge conflict path: it rebases the head onto `<base>` via the rebase-on-canary skill and force-pushes the result to `<headRefName>` with `--force-with-lease` only — never `--force`, never to `<base>`.
- Phase 6 merges only via `gh pr merge` with `<merge_method>` (default `squash`); never pass `--admin` or bypass branch protection or a required check — halt and escalate if the merge is rejected.
- Do not bypass Git hooks (`--no-verify`, `--no-gpg-sign`, etc.) without explicit user permission.
- Do not commit secrets, `.env` files, or generated artifacts that are not part of the change.
- Do not write commit messages in any language other than English.
- Do not post the `@codex` follow-up until the push has succeeded and the commit is visible on the remote.
- Do not invent validation results — if a check was not run, say so.
- Phase 7 autonomous cleanup runs only after Phase 6 confirms `state: MERGED`; it force-deletes only the merged head branch and its worktree/tmux session, never the main checkout or a protected branch (`main` / `master` / `<base>`).
- Create PRs only against `sbluemin/fleet-harness` with this skill.
