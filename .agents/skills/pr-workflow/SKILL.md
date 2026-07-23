---
name: pr-workflow
description: End-to-end PR lifecycle on sbluemin/fleet-harness — commit staged work, open a PR, add its PR-number changelog fragment in a second commit, await Codex review, adversarially adjudicate context-incomplete feedback against frozen product intent, roll back review-driven scope drift, and auto-merge only after a final context audit. Supersedes the former pr-creates and pr-review-fixes skills.
---

# PR Workflow

Use this skill to drive a change from committed work to a merged pull request on `sbluemin/fleet-harness`, mirroring the full cycle the Admiral runs by hand: **commit → open PR → add `pr-<number>.md` and push again → await Codex review → judge & apply feedback → re-review → detect approval → auto-merge**.

This is a single end-to-end workflow. Enter at Phase 1 for a fresh change; if the branch is already committed and pushed with an open PR, skip to Phase 3 to resume at the review loop; if the PR is already approved, resume at Phase 6 to merge it.

## Inputs

Replace each `<placeholder>` before running. Optional inputs may be left blank — defaults will be inferred.

- `<commit_subject>` — Conventional Commits subject for the initial commit. Optional. If omitted, derive from the dominant change in the staged/working diff.
- `<commit_body>` — Optional commit body. If omitted, summarize the change as bullets.
- `<changelog_commit_subject>` — Conventional Commits subject for the post-creation fragment commit. Optional. Default `docs(changelog): add PR <pr_number> release note`.
- `<title>` — Conventional Commits PR title (≤ 70 chars). Optional. If omitted, derive from `git log <base>..HEAD`.
- `<body>` — Markdown PR body. Optional. If omitted, auto-build a Summary + Test Plan from the diff, following `.github/PULL_REQUEST_TEMPLATE.md` style (Korean prose is fine; the PR title stays English Conventional Commits).
- `<base>` — Base branch. Optional. Default `canary`. `main` / `master` are rejected unless explicitly overridden.
- `<head>` — Head branch. Optional. Default = current branch. Must not equal `<base>`.
- `<draft>` — `true` | `false`. Optional. Default `false`.
- `<scope_hint>` — Optional. Free-form note restricting review-fix scope (e.g., "only Codex P1/P2"). If omitted, default to "every actionable, unresolved review comment on the PR".
- `<review_poll_interval>` — Optional. Poll cadence for the Phase 3 background wait loop (e.g., `30s`). If omitted, default ~`30s` for the background poll (or `1m` for the cron fallback).
- `<review_activation_timeout>` — Optional. Bounded wait after an explicit `@codex` review request for Codex to acknowledge it. Default `60s`. If no Codex reaction, review, or comment appears, treat automated review as unavailable and proceed to merge.
- `<repo>` — `owner/name` slug. Optional. If omitted, infer from `gh repo view --json nameWithOwner` (must be `sbluemin/fleet-harness`).
- `<merge_method>` — `squash` | `merge` | `rebase`. Optional. Default `squash` (the repo convention — squash-merge titles read `type(scope): summary (#N)`). Used by Phase 6 auto-merge.
- `<auto_merge>` — `true` | `false`. Optional. Default `true`. When `true`, Phase 6 merges the PR after approval (rebasing the head onto `<base>` and force-pushing first when it conflicts). When `false`, stop at approval and report the PR as approved-but-unmerged (the legacy behavior).
- `<pr_number>` — Target PR number. When entering at Phase 1 it is produced by Phase 2 (PR creation). When **resuming** at Phase 3/4/5/6 for an already-open PR it is **required** — if absent, resolve it from the current branch via `gh pr view --json number,headRefName` before polling. `<headRefName>` (the PR head branch) is recorded alongside it and is the only branch Phases 4–6 push to.

## Goal

Publish a PR authored by the authenticated user's GitHub account, carry it through the Codex automated review by applying only the feedback that passes the Admiral judgment gate, and — after Codex signals approval and the cumulative review-driven diff passes a final product-context audit — auto-merge the PR into `<base>` (rebasing the head onto `<base>` and force-pushing first when the PR conflicts), unless `<auto_merge>` is `false`.

## Changelog Fragment Requirement

Every release-impacting PR must include exactly one `.changelog.d/pr-<pr_number>.md` unless it intentionally carries the `no-changelog` label. The PR number does not exist before Phase 2, so the initial product commit and PR are created first; the fragment is then added in a second commit and pushed before Codex review activation.

The fragment body groups entries under `### <product>` and `#### <section>` headings. Products are `fleet-cli`, `fleet-console`, `fleet-desktop`, `fleet-plugin`, and `fleet-core`; sections are `Added`, `Changed`, `Fixed`, `Removed`, and `Breaking Changes`. Each `- [tag] English summary.` line is immediately followed by exactly one two-space-indented `  ko: 한글 요약.` line. English summaries must be ASCII-only, Korean summaries must contain Hangul, and tags retain the repository allowlist. Validate with `node scripts/compile-changelog-fragments.mjs --check` before the second push. `canary.md` is reserved for explicitly authorized direct-canary work outside this PR workflow and must never be used for a PR.

## Admiral Judgment Policy

Treat GitHub Codex review as code-local, context-incomplete evidence, never authority. Codex sees the code tree and diff but may not know the product background, cognitive-debt decisions, original user intent, or intended trade-offs. Codex approval is not proof of product correctness.

Treat every finding as an adversarial hypothesis. Severity is not disposition. First classify it as either **code-local correctness / security / data-loss** or **product policy / behavior / trade-off / hypothetical hardening**; then decide **FIX / DECLINE / DEFER** from evidence.

- **FIX** only after verifying all four gates: the defect occurs on a supported execution path; the change aligns with the original scope; no supported functionality regresses or narrows; and change cost is proportional to user/operator value. Code correctness is necessary, not sufficient.
  - **Reproduce before you edit, and record how.** An unreproduced finding is a hypothesis, and a hypothesis is a DECLINE — never a cheap defensive fix "while we are here". If the reviewer claims a defect you cannot make happen, say so and decline it; do not harden against it to close the comment.
  - **A supported execution path is one a real workflow reaches.** For a security finding, an attacker-constructed state counts. For everything else, a state that exists only because you hand-built an exotic fixture to satisfy the reviewer does not. "The predicate should be consistent", "it is only a few lines", and "the tests are green anyway" are not user value.
- **DECLINE** with cited Product Context Record or repository evidence when the finding is context-blind, hypothetical or overfit, outside scope, conflicts with an intended trade-off, narrows supported behavior, or lacks user/operator value. Record and courteously post every decline; never silently skip it.
- **DEFER** a real architectural or product-policy issue that is outside the PR scope. State why it is real and why this PR must not absorb it.
- **STOP and ask the user** when product intent is genuinely ambiguous and the Product Context Record plus cited evidence cannot resolve it. Never let the reviewer decide product policy.

Do not treat re-review comments as new scope. After every review pass, audit the cumulative review-fix diff from `REVIEW_BASE_HEAD` against the frozen Product Context Record. Roll back drifted review-fix hunks to the base behavior; do not stack compensating fixes on top of scope drift.

**A fix that breeds the next finding was over-scoped.** When a pass reports problems that exist only because the previous pass's fix created them, that is evidence against the previous fix, not a request for another one. Prefer rolling it back over widening it again.

This policy governs Phase 4 (classification / verification) and Phase 5 (self-verification audit).

## Product Context Record

Before the first review-fix, freeze one Product Context Record for the entire PR. Do not rewrite it to justify later feedback. Only an explicit later user or release-owner directive may append a cited context amendment; preserve the original record, and never treat reviewer feedback as authority to amend it. Record:

- Original request and acceptance criteria.
- Explicit exclusions.
- Intended trade-offs.
- Supported behavior that must not regress or narrow.
- Cited issue, PRD, Fleet Wiki, and decision evidence when available.
- `REVIEW_BASE_HEAD`: the pushed PR head SHA after the PR-number changelog commit and before any review-fix.

If resuming after review fixes and this record or a trustworthy pre-fix `REVIEW_BASE_HEAD` cannot be reconstructed from the PR history and cited evidence, stop and ask the user before applying more feedback or merging.

## Required Workflow

### Phase 0 — Environment & doctrine (always first)

1. Confirm the environment in parallel: `pwd`; OS info (`uname -a`); shell (`echo "SHELL=$SHELL"`); `gh auth status`; `gh repo view --json nameWithOwner` (must equal `sbluemin/fleet-harness`).
2. Read the repository root `AGENTS.md`. For each subdirectory the change touches, read its `AGENTS.md` too — child rules override parent rules within their scope.
3. Classify the change as release-impacting or `no-changelog`. A release-impacting change receives `.changelog.d/pr-<pr_number>.md` only after Phase 2 creates the PR.

### Phase 1 — Commit

1. Inspect: `git status --short --branch`; `git branch --show-current`.
2. Stage only the files belonging to this change: `git add <file> [<file> ...]`. Do not use `git add -A` / `git add .` unless every pending change belongs to this commit.
3. Write the commit message in English using Conventional Commits (allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`). Subject `<commit_subject>` or inferred; body `<commit_body>` or addressed-change bullets.
4. Pre-commit self-check: re-read `git diff --cached` once and confirm the subject/body match what is staged — nothing more, nothing less.
5. Commit via HEREDOC. Do NOT use `--amend`, `--no-verify`, `--no-gpg-sign`, or any hook bypass. If a pre-commit hook fails, fix the cause and create a new commit (never amend).
6. Do not invent a changelog filename before PR creation. The initial commit normally excludes `.changelog.d/`; an explicitly selected `no-changelog` flow excludes it permanently.

### Phase 2 — Open the PR

1. Resolve `<head>` (default current branch) and `<base>` (default `canary`; reject `main`/`master` unless overridden). If `<head>` equals `<base>`, stop and ask.
2. `git push -u origin <head>` and verify `git status --short --branch` reports up-to-date with the remote.
3. Build PR metadata: derive `<title>` (≤ 70 chars, Conventional Commits) and `<body>` (`## Summary` 1–3 bullets + `## Test Plan` checklist) if not provided.
   - For release-impacting work, mark the changelog checklist as pending PR-number assignment. For `no-changelog`, record that classification explicitly.
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
6. For release-impacting work, create exactly `.changelog.d/pr-<pr_number>.md` using the grouped product/section syntax from `.changelog.d/AGENTS.md`. Include every release-facing product claim in that one file; never create `canary.md` or a product-section filename for the PR.
7. Validate the complete fragment set with `node scripts/compile-changelog-fragments.mjs --check`, stage only `.changelog.d/pr-<pr_number>.md`, re-read its cached diff, and commit it via HEREDOC using `<changelog_commit_subject>` or the default. Do not amend the product commit or bypass hooks.
8. Confirm the current branch still equals `<headRefName>`, then push the fragment commit explicitly with `git push origin HEAD:<headRefName>`. Verify the remote head equals local `HEAD` and the working tree is clean.
9. Finalize the PR body's Changelog checklist so it names `.changelog.d/pr-<pr_number>.md` and marks the fragment syntax, bilingual summaries, and validation complete. Preserve all other user-provided body content. Only then may Phase 3 activate Codex review.

### Phase 3 — Await the Codex review (deterministic background poll)

The Codex automated reviewer (`chatgpt-codex-connector[bot]`) posts asynchronously. The skill **waits with a deterministic background poll that wakes you only when something real changes** — never ask the Admiral to run `/loop` by hand, and prefer this over a fixed-interval cron that re-invokes the model every tick whether or not anything happened. A cheap `gh` loop runs in the background (no model tokens) and re-invokes you on the first genuine signal.

0. **Ensure PR metadata, changelog completion, the right branch, and frozen context.** Confirm `<pr_number>`, `<repo>`, and `<headRefName>` are known. On a fresh run they come from Phase 2; on a resume entry, resolve them first via `gh pr view --json number,headRefName,url` for the current branch (or the `<pr_number>` carried in the resume prompt). Never poll or push without them. For release-impacting work, require `.changelog.d/pr-<pr_number>.md` on the remote head; if it is missing, return to Phase 2 step 6 before activating review. Then confirm the **current branch equals `<headRefName>`** (`git branch --show-current`); if it does not, stop and ask the Admiral before editing or committing — do not auto-checkout and never commit fixes onto a non-head branch. Finally confirm the **working tree is clean** (`git status --short`); if there are unrelated uncommitted changes, stop and ask the Admiral before editing — never overwrite them or fold pre-existing changes into a review-fix commit. Before the first review-fix, freeze the Product Context Record and set `REVIEW_BASE_HEAD` to the current pushed head SHA.
1. **Activate the initial review before waiting.** Apply this gate once per PR, before the first long-running poll. Skip it after Codex has already reacted, reviewed, commented, or been explicitly requested.
   1. Check PR-body reactions, reviews, and Codex top-level comments. Any `chatgpt-codex-connector[bot]` reaction, review, or comment means the reviewer is active; continue to step 2.
   2. If no Codex signal exists, post `@codex Please review this PR.` as a PR comment and record its comment ID, URL, and creation time. Do not start the 40-minute poll yet.
   3. For `<review_activation_timeout>` (default 60 seconds), check every ~10 seconds for a Codex reaction on either the PR body or request comment, a Codex review, or a Codex top-level comment newer than the request. Any one is activation; continue to step 2. An `eyes` reaction means active, not approved.
   4. If the bounded window expires, refresh all four surfaces once to avoid a boundary race. If no signal exists, set `REVIEW_BYPASS_REASON=codex_activation_timeout` and go directly to Phase 6. This fallback is not approval and never bypasses branch protection or required checks.
2. **Freeze the wait baseline.** Record what is *already* on the PR so the poll only fires on something new: the latest pushed head commit timestamp `HEAD_TS` (`gh api repos/<repo>/commits/<head_sha> -q .commit.committer.date`, or the time of the Phase 2 / Phase 5 push) and the current review count `BASE_REVIEWS` (`gh pr view <pr_number> --repo <repo> --json reviews -q '.reviews | length'`).
3. **Launch the background poll (signal-driven, not interval-driven).** Start one `run_in_background` Bash loop that polls with `gh` every ~30s (or `<review_poll_interval>`), capped at ~40 min, and **exits — re-invoking you — only on a genuine signal**, printing which:
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
4. **On wake, read the full state and route.** When the poll exits, read: `gh pr view <pr_number> --repo <repo> --json reviews,comments,reviewDecision`; inline comments `gh api repos/<repo>/pulls/<pr_number>/comments`; top-level comments `gh api repos/<repo>/issues/<pr_number>/comments`; PR-body reactions `gh api repos/<repo>/issues/<pr_number>/reactions -H "Accept: application/vnd.github.squirrel-girl-preview+json"`. Then:
   - **Approval = final-audit trigger.** A fresh `chatgpt-codex-connector[bot]` `+1` on the PR body (`created_at` newer than both the latest pushed head commit and the most recent `@codex` re-review comment) **and** no new actionable comments → go to Phase 6. Treat the signal as code-review completion, not product-correctness proof. A `+1` predating the latest push is stale (GitHub keeps the old reaction) — ignore it. A bare `eyes` reaction means the review is still in progress (pending), not approval.
   - **New actionable feedback** → Phase 4.
   - **Spurious wake or timeout** (only `eyes`, a re-anchored old comment, or nothing genuinely new) → relaunch the background poll (step 3) and keep waiting.

   **Stop rule — the loop must terminate on your judgment, not on the reviewer running out of ideas.** Count review passes. Go to Phase 6 as soon as a pass yields no FIX-class finding under the Admiral Judgment Policy, and by default stop after the third pass; post the declines first either way. A clean approval is not a merge requirement — Codex can always produce another suggestion, so waiting for silence is an unbounded loop. Continuing past the third pass requires naming the specific reproduced defect that justifies it. If the Admiral of the Navy has to interrupt to end the loop, the stop rule was already breached.

**Fallback — cron.** If the harness cannot re-invoke you when a background task completes, fall back to a recurring `CronCreate` (`*/1 * * * *`, `recurring: true`, prompt re-entering Phase 3 with `<pr_number>`/`<repo>`), armed exactly once; the same baseline, freshness, and re-anchor rules apply on each tick. Stop it with `CronDelete` at Phase 6 (instead of `TaskStop`).

### Phase 4 — Judge & apply feedback

1. Require the frozen Product Context Record and trustworthy `REVIEW_BASE_HEAD`; stop if either is missing.
2. Before considering new feedback, audit existing cumulative review-driven changes with `git diff REVIEW_BASE_HEAD` plus staged/untracked-file inventory. Compare every hunk to the frozen record and cited user-directed amendments. Roll back only drifted review-driven intent to `REVIEW_BASE_HEAD` behavior; preserve later user-directed and concurrent changes.
3. Collect and group review items by author/severity (Codex P1/P2/P3, human asks, nits). Filter to `<scope_hint>`. Severity never determines disposition and no comment grants new scope.
4. For each item, verify the claim against current code/docs and classify it as code-local correctness/security/data-loss or product policy/behavior/trade-off/hypothetical hardening.
5. Decide **FIX / DECLINE / DEFER** under the Admiral Judgment Policy. For FIX, record evidence for all four gates before editing. Record cited evidence for every disposition; never silently skip.
6. Delegate to **Genesis** (`carrier_dispatch`, `carrier_id: "genesis"`) for multi-file or non-trivial FIX items with the frozen Product Context Record in `<references>` plus explicit `<objective>`/`<scope>`/`<constraints>` blocks; apply trivial single-file edits directly.
7. Apply FIX items narrowly — restrict edits to the verified defect and preserve all supported behavior named in the record. No opportunistic refactors, renames, formatting churn, or speculative hardening. Prefer `Edit` over full-file rewrite; re-read each file immediately before editing. New code comments in Korean.
8. Repeat the cumulative audit after applying the pass. Roll back drifted review-driven hunks before continuing while preserving cited user-directed amendments; never add a compensating fix for review-created drift.

### Phase 5 — Re-validate, commit, push, request re-review

1. Self-verification (before external checks): walk `git diff REVIEW_BASE_HEAD` hunk by hunk — every review-driven hunk maps to a FIX item and passes all four gates (else roll it back); every fix-item is reflected; decline/defer rationale is cited; supported behavior is preserved; no boundary/scope breach; no unverified runtime assumption; new comments Korean; files re-read before edit; no single-call-site abstraction; replay each original comment ("does this concern still hold?").
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

Reached after Phase 3 confirms review completion (a fresh Codex `+1` with no open actionable comments), the Phase 3 stop rule (a pass with no FIX-class finding, or the third pass), or `REVIEW_BYPASS_REASON=codex_activation_timeout` from the bounded explicit activation gate. None of these signals proves product correctness, and the final context audit below is what gates the merge in every case. The timeout fallback authorizes normal merge checks only; it never bypasses branch protection or required checks. When `<auto_merge>` is `false`, skip merging and report the PR as review-complete-but-unmerged or review-unavailable-and-unmerged.

1. **Stop the wait loop.** If Phase 3 started a background poll, stop it with `TaskStop` (or `CronDelete` for the cron fallback). Under `codex_activation_timeout`, no long-running poll exists; continue directly. No more review polling occurs after this point.
2. **Run the final context audit.** Compare the cumulative review-driven diff from `REVIEW_BASE_HEAD` to the frozen Product Context Record. Confirm every hunk remains in original scope, preserves supported behavior and intended trade-offs, and has proportional user/operator value. On drift, roll back the drift and return to Phase 5 for validation/re-review; if rollback or product intent is ambiguous, stop and ask the user. Never merge merely because Codex approved.
3. **Check mergeability.** `gh pr view <pr_number> --repo <repo> --json mergeable,mergeStateStatus,baseRefName,headRefName`.
   - `mergeable: MERGEABLE` with `mergeStateStatus` `CLEAN` / `UNSTABLE` / `BEHIND` (no conflict) → go to step 5 (merge directly).
   - `mergeable: CONFLICTING` or `mergeStateStatus: DIRTY` → the head conflicts with `<base>`; go to step 4 (rebase path).
   - `mergeable: UNKNOWN` → GitHub is still computing mergeability; wait briefly and re-check before deciding.
4. **Conflict path — rebase the head onto `<base>`, then force-push.**
   1. Invoke the **rebase-on-canary** skill against the PR head (current-branch mode in the head's worktree, or its explicit `<worktree_path>`) with base = `<base>`. By default that skill auto-resolves conflicts by integrating both sides and validates the result.
   2. rebase-on-canary escalates only a genuinely ambiguous/unsafe conflict or a post-rebase validation failure. If it escalates, **halt auto-merge** and surface its report to the Admiral of the Navy — do not merge.
   3. On a successful rebase (clean or auto-resolved), confirm the current branch is `<headRefName>`, then publish the rewritten history with a lease: `git push --force-with-lease origin HEAD:<headRefName>`. Never `--force`; never force-push `<base>`.
   4. Re-check mergeability (step 3), then repeat the final context audit (step 2) against the rebased diff. If mergeability or context validation fails, halt and escalate; never merge a conflict resolution that changed product intent or supported behavior.
5. **Merge.** `gh pr merge <pr_number> --repo <repo> --<merge_method>` (default `--squash`, matching the repo convention). Do not pass `--admin` or otherwise bypass branch protection or a required check — if the merge is rejected, halt and escalate.
6. **Verify the merge.** `gh pr view <pr_number> --repo <repo> --json state,mergedAt,mergeCommit` — confirm `state: MERGED` and record the merge commit SHA.
7. Go to Phase 7.

### Phase 7 — Cleanup & completion

**Autonomous cleanup (only when the merge succeeded).** When Phase 6 confirmed `state: MERGED`, clean up the merged head branch's local artifacts yourself — do **not** ask the Admiral of the Navy. Follow the git-worktree skill's remove flow:
1. If `<headRefName>` is checked out in a dedicated worktree under `.fleet/worktrees/`, run that remove flow against it: leave the worktree directory (`cd` to the main checkout), kill the matching tmux session if present, `git worktree remove --force <path>` + `git worktree prune`, then `git branch -D <headRefName>` (a squash merge leaves the branch "unmerged" to `-d`, so force-delete is expected).
2. If the head branch was worked directly in the main checkout (no separate worktree), switch to `<base>` (`git switch <base>`) and `git branch -D <headRefName>`.
3. Hard stops — never cross even autonomously: never delete the main checkout, and never delete a protected branch (`main` / `master` / `<base>`). The remote head branch is typically auto-deleted by GitHub on merge; otherwise leave it unless remote cleanup was requested.
4. Skip cleanup entirely when `<auto_merge>` is `false` or the merge halted — the branch and its worktree must survive for follow-up.

Then report in Korean:
- PR number, title, head/base, URL, draft flag.
- Frozen Product Context Record evidence, `REVIEW_BASE_HEAD`, and the final cumulative context-audit outcome.
- Each review item across all passes: fix / declined / deferred, with verification evidence.
- Files changed, the initial product commit SHA, the PR-number fragment commit SHA when applicable, later fix commit SHA(s), and push target(s).
- Validation commands and pass/fail status; note any check not run.
- The approval signal observed (Codex `+1` on the PR body), or the explicit activation request URL plus `codex_activation_timeout`; include every `@codex` follow-up comment URL.
- **Merge outcome**: merged (`<merge_method>` + merge commit SHA + whether a pre-merge rebase/force-push was needed), or — when `<auto_merge>` is `false` or auto-merge halted — the approved-but-unmerged state and the reason. The Phase 3 wait poll was stopped in Phase 6.
- **Cleanup outcome**: worktree removed / tmux session killed / local branch force-deleted, or skipped (with reason).

## Carrier Delegation Guidance

- **Genesis** — implementation of fixes (default for ≥ 2 files or non-trivial logic).
- **Sentinel** — additional code/security review when a fix touches concurrency, auth, input validation, or other sensitive surfaces.
- **Nimitz** — only when reviewers disagree or a fix needs an architecture decision (read-only).
- Skip delegation for trivial single-file edits.

## Documentation Synthesis

PR titles, summaries, bodies, and `.changelog.d/pr-<pr_number>.md` fragments are host-owned. Synthesize them directly from the frozen Product Context Record, verified `git diff`/`git log` evidence, and validated changelog fragments — never delegate documentation synthesis to a Carrier.

## Safety Rules

- Do not push commits directly to `main` / `master` / `<base>` or any protected branch — local pushes target only the PR's `headRefName`. Phase 6 integrates into `<base>` exclusively through the server-side `gh pr merge`, never a local push to the base.
- Do not address review items outside `<scope_hint>` that the user did not ask for.
- Do not treat reviewer severity, re-review comments, or approval as scope or product-policy authority; the frozen Product Context Record governs every pass and the final merge audit.
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
