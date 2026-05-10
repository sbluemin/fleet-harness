---
name: pr-review-fixes
description: PR 리뷰 지적 사항을 반영하고 재검토를 요청하는 절차를 정의합니다.
---

# PR Review Fixes

Use this prompt when applying fixes that were requested by a PR review (e.g., Codex automated review, human reviewer comments) and following through to commit, push, and a `@codex` re-review request.

## Inputs

Replace each `<placeholder>` before running. Optional inputs may be left blank — defaults will be inferred.

- `<pr_number>` — PR number on the current GitHub repository (required, e.g., `8`).
- `<repo>` — `owner/name` slug. Optional. If omitted, infer from `gh repo view --json nameWithOwner`.
- `<scope_hint>` — Optional. Free-form note restricting the fix scope (e.g., "only Codex P1/P2 items", "only the security-review thread"). If omitted, default to "every actionable, unresolved review comment on the PR".
- `<commit_subject>` — Optional Conventional Commit subject (e.g., `fix(fleet): guard AbortSignal.any for Node 18`). If omitted, derive a Conventional Commit subject from the dominant change.
- `<commit_body>` — Optional commit body. If omitted, summarize the addressed review items as bullet points.
- `<comment_template>` — Optional `@codex` follow-up comment body. If omitted, use the default template in step 10.

## Goal

Resolve the actionable feedback raised on PR `<pr_number>`, validate the changes, commit and push them to the PR branch, then post a `@codex` follow-up comment requesting re-review.

## Required Workflow

1. Confirm the current environment before running repository commands:
   - `pwd`
   - OS information
   - shell type
   - `gh auth status` (verify GitHub CLI is authenticated)

2. Read the applicable `AGENTS.md` files before planning or editing:
   - Always read the repository root `AGENTS.md`.
   - For each subdirectory you intend to touch, read its `AGENTS.md` if present. Child rules override parent rules within their scope.

3. Inspect the current branch and working tree:
   - `git status --short --branch`
   - `git branch --show-current`
   - Confirm the working tree is clean. If not, stop and ask the user how to handle pre-existing changes.
   - Confirm the local branch matches the PR head branch (see step 4). If it does not, stop and ask before checking out.

4. Collect PR metadata and reviews:
   - `gh pr view <pr_number> --json number,title,state,headRefName,baseRefName,url,headRepositoryOwner,headRepository`
   - `gh api repos/<repo>/pulls/<pr_number>/reviews`
   - `gh api repos/<repo>/pulls/<pr_number>/comments` (inline review comments with `path`, `line`, `body`, `diff_hunk`)
   - `gh api repos/<repo>/issues/<pr_number>/comments` (top-level PR comments — sometimes contain reviewer asks)
   - Record `headRefName` as the push target. Do not invent a different branch.

5. Classify and verify each review item:
   - Group comments by author and severity (e.g., Codex P1/P2/P3, human reviewer asks, nits).
   - Filter to the `<scope_hint>` set.
   - For every item to be addressed, verify the underlying claim against the current code and docs before editing — review comments may be stale, speculative, or based on assumptions that the repo does not actually hold (Node engines, naming conventions, dependency versions, etc.).
   - For each item, decide one of: **fix**, **decline-with-rationale**, **defer**. Record the decision and the evidence used. Do not silently skip items.
   - When uncertainty remains after verification, ask the user before applying a fix that changes user-visible behavior.

6. Plan the fix scope:
   - Restrict edits to the files and lines that the verified review items demand.
   - Do not refactor unrelated code, do not bundle unrelated improvements, do not rename variables that are not part of the fix.
   - If a fix needs a new shared helper, place it under the smallest appropriate shared directory (e.g., `extensions/<ext>/<area>/_shared/`).
   - Prefer `Edit` over full-file rewrite. Re-read each file immediately before editing.

7. Apply the changes:
   - Apply directly for low-risk, narrow edits (≤ 3 dependent steps, single file or tightly coupled set).
   - Delegate to Genesis via `carrier_dispatch` with `carrier_id: "genesis"` for multi-file or non-trivial implementation work. Provide `<objective>`, `<scope>`, `<constraints>`, and `<references>` blocks; do not prescribe step-by-step instructions.
   - Korean is required for all new code comments per the user's global instruction.

8. Self-verification (do this before any external check is run):
   - Walk through the diff one hunk at a time and answer each question explicitly. If any answer is "no" or "unsure", return to step 5–7 and resolve before proceeding.
     - Mapping: does every modified hunk map to a specific review item recorded in step 5? Hunks without a mapping are scope creep — revert them.
     - Coverage: is every fix-classified item from step 5 actually reflected in the diff? Items missing from the diff must be either implemented now or re-classified as declined/deferred with rationale.
     - Decline/defer audit: for items not implemented, is the rationale defensible (concrete evidence or explicit user policy), not speculation ("probably fine", "might break")?
     - Boundary: did any change exceed `<scope_hint>`? Did any opportunistic refactor, rename, or formatting-only churn slip in? Remove if so.
     - Assumptions: does any new code rely on an unverified runtime guarantee (engine version, library behavior, environment variable)? If yes, verify it now or guard it.
     - Conventions: are new comments in Korean? Do new files honor the closest `AGENTS.md` (file structure, naming, domain assignment)? Do new slash commands match the documented `fleet:<domain>:<feature>` contract?
     - Concurrency safety: was every file re-read immediately before editing? Did any other agent modify the same files between read and write?
     - Abstraction: was a new helper, type, or module introduced for a single call site? If yes, justify it or inline it.
     - Reviewer-perspective replay: re-read each original review comment and ask "does this exact concern still hold against the new diff?" If yes, the fix is incomplete.
   - Record the self-verification outcome (pass / issues found and resolved) — it must appear in the final report.

9. Validate the changes (external checks):
   - `git status --short` and `git diff --stat` — confirm only the intended files changed.
   - `git diff` — final pass to confirm the diff still matches the self-verification outcome from step 8.
   - Run the workspace's available checks for the touched packages. Common entry points:
     - `pnpm --filter <workspace-name> typecheck` (e.g., `--filter @sbluemin/fleet-harness`)
     - `pnpm --filter <workspace-name> build` if a build script exists
     - `pnpm --filter <workspace-name> test` if a test script exists and is relevant
   - If a script does not exist for the touched workspace, state that explicitly in the report.
   - Re-grep the touched symbols to confirm no stragglers (e.g., the original anti-pattern was fully replaced).

10. Commit:
    - Stage only the files modified for this fix set: `git add <file> [<file> ...]`. Do not use `git add -A` or `git add .`.
    - Write the commit message in English using Conventional Commits.
      - Subject: `<commit_subject>` if provided; otherwise infer (`fix(<scope>): ...`, `docs(<scope>): ...`, `chore(<scope>): ...`).
      - Body: `<commit_body>` if provided; otherwise list the addressed review items, each as a single bullet referencing the file and the reviewer's concern.
    - Pre-commit self-check: re-read the staged diff (`git diff --cached`) once and confirm the subject/body accurately describe what is staged — nothing more, nothing less.
    - Use a HEREDOC to pass the commit message:
      ```
      git commit -m "$(cat <<'EOF'
      <subject>

      <body>
      EOF
      )"
      ```
    - Do NOT use `--amend`, `--no-verify`, `--no-gpg-sign`, or any hook bypass.
    - If a pre-commit hook fails, fix the underlying issue and create a new commit. Do not amend.

11. Push and post the `@codex` follow-up comment:
    - Push to the PR head branch recorded in step 4: `git push origin <headRefName>`.
    - Verify the push: `git status --short --branch` should show the local branch up-to-date with the remote.
    - Post a follow-up comment on the PR with `@codex` mentioned. Use `<comment_template>` if provided; otherwise use the default template below. Always send via HEREDOC to preserve formatting:
      ```
      gh pr comment <pr_number> --body "$(cat <<'EOF'
      @codex 리뷰에서 지적해 주신 사항을 반영했습니다. 재확인 부탁드립니다.

      ## Addressed
      - <item 1 — file:line — one-line summary of the fix>
      - <item 2 — ...>

      ## Validation
      - <command 1 — result>
      - <command 2 — result>

      ## Notes
      - <optional: declined items with rationale, deferred items with follow-up plan>
      EOF
      )"
      ```
    - Capture the returned comment URL.

12. Report the result in Korean:
    - PR number, title, head branch.
    - Each review item classified as fix / declined / deferred, with the verification evidence summarized.
    - Files changed (path list with one-line description each).
    - Self-verification outcome from step 8 (pass, or issues found and how they were resolved).
    - Commands run during validation and their pass/fail status.
    - Commit SHA(s) created and the push target.
    - URL of the `@codex` follow-up comment.

## Carrier Delegation Guidance

- **Genesis** — implementation of the fixes (default for ≥ 2 files or non-trivial logic).
- **Sentinel** — additional code/security review when a fix touches concurrency, auth, input validation, or other sensitive surfaces.
- **Nimitz** — only when reviewers disagree or the fix requires an architecture decision before editing. Read-only.
- **Chronicle** — only when the fix introduces user-visible documentation impact beyond the touched code (e.g., updating multiple `AGENTS.md` files, README, CHANGELOG).
- Skip delegation for trivial single-file edits (typo, one-line guard, single import).

## Safety Rules

- Do not address review items the user did not ask for and that are outside `<scope_hint>`.
- Do not silently expand scope (no opportunistic refactors, no formatting-only churn, no dependency bumps).
- Do not modify files owned by other agents working on the same branch — re-read each file immediately before editing.
- Do not create a new branch, do not rebase, do not force-push, do not close or reopen the PR.
- Do not push to `main` or any protected branch — push only to the PR's `headRefName`.
- Do not commit secrets, `.env` files, or generated artifacts that are not part of the fix.
- Do not skip Git hooks (`--no-verify`, `--no-gpg-sign`, etc.) without explicit user permission.
- Do not write commit messages in any language other than English.
- Do not invent validation results — if a check was not run, say so in the report.
- Do not post the `@codex` follow-up comment until the push has succeeded and the commit is visible on the remote.
