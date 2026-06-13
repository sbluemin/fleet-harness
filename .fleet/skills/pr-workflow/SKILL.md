---
name: pr-workflow
description: End-to-end PR lifecycle on sbluemin/fleet-harness — commit staged work, open a PR as the authenticated user, await the Codex automated review, apply feedback under an Admiral judgment gate, request re-review, and detect approval. Supersedes the former pr-creates and pr-review-fixes skills.
---

# PR Workflow

Use this skill to drive a change from committed work to an approved pull request on `sbluemin/fleet-harness`, mirroring the full cycle the Admiral runs by hand: **commit → open PR → await Codex review → judge & apply feedback → re-review → detect approval**.

This is a single end-to-end workflow. Enter at Phase 1 for a fresh change; if the branch is already committed and pushed with an open PR, skip to Phase 3 to resume at the review loop.

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
- `<review_poll_interval>` — Optional. Cadence for the Codex review wait loop (e.g., `5m`). If omitted, default `5m`.

## Goal

Publish a PR authored by the authenticated user's GitHub account, carry it through the Codex automated review by applying only the feedback that passes the Admiral judgment gate, and stop when Codex signals approval.

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
4. Confirm the final title/body/base/head/draft with the Admiral of the Navy unless pre-authorized, then create:
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
5. Capture the PR number and URL.

### Phase 3 — Await the Codex review

The Codex automated reviewer (`chatgpt-codex-connector[bot]`) posts asynchronously. Poll rather than block.

1. Offer the Admiral a recurring wait loop at `<review_poll_interval>` (default `5m`), e.g. `/loop 5m <resume this skill at Phase 3>`. The loop checks the PR each tick and does nothing when there is no new feedback.
2. On each check, read: `gh pr view <pr_number> --repo <repo> --json reviews,comments,reviewDecision`; inline comments `gh api repos/<repo>/pulls/<pr_number>/comments`; top-level comments `gh api repos/<repo>/issues/<pr_number>/comments`; and the **approval signal** — Codex reactions on the PR body: `gh api repos/<repo>/issues/<pr_number>/reactions -H "Accept: application/vnd.github.squirrel-girl-preview+json"`.
3. **Approval = completion.** When `chatgpt-codex-connector[bot]` leaves a `+1` reaction on the PR body **and** there are no new actionable review comments, the workflow is complete — go to Phase 6.
4. If new actionable feedback exists, go to Phase 4. If neither (still pending), do nothing this tick and let the loop check again.

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
4. Push to the PR head branch: `git push origin <headRefName>`; verify up-to-date with remote.
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

### Phase 6 — Completion

Stop the wait loop (CronDelete the `/loop` job if one was armed). Report in Korean:
- PR number, title, head/base, URL, draft flag.
- Each review item across all passes: fix / declined / deferred, with verification evidence.
- Files changed, commit SHA(s), push target(s).
- Validation commands and pass/fail status; note any check not run.
- The approval signal observed (Codex `+1` on the PR body) and the `@codex` follow-up comment URL(s).

## Carrier Delegation Guidance

- **Genesis** — implementation of fixes (default for ≥ 2 files or non-trivial logic).
- **Sentinel** — additional code/security review when a fix touches concurrency, auth, input validation, or other sensitive surfaces.
- **Nimitz** — only when reviewers disagree or a fix needs an architecture decision (read-only).
- **Chronicle** — only when a fix introduces doc impact beyond touched code (README/CHANGELOG/AGENTS.md).
- Skip delegation for trivial single-file edits.

## Safety Rules

- Do not push to `main` / `master` or any protected branch — push only to the PR's `headRefName`.
- Do not address review items outside `<scope_hint>` that the user did not ask for.
- Do not silently expand scope: no opportunistic refactors, formatting-only churn, or dependency bumps.
- Do not create a new branch mid-flow, rebase, force-push, amend, or close/reopen the PR.
- Do not bypass Git hooks (`--no-verify`, `--no-gpg-sign`, etc.) without explicit user permission.
- Do not commit secrets, `.env` files, or generated artifacts that are not part of the change.
- Do not write commit messages in any language other than English.
- Do not post the `@codex` follow-up until the push has succeeded and the commit is visible on the remote.
- Do not invent validation results — if a check was not run, say so.
- Create PRs only against `sbluemin/fleet-harness` with this skill.
