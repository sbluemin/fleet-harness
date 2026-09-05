# Final audit, merge, and cleanup

### Phase 6 — Auto-merge

Reached after Phase 3 confirms review completion (a fresh Codex `+1` with no open actionable comments), the Phase 3 stop rule (a pass with no FIX-class finding, or the third pass), or `REVIEW_BYPASS_REASON=codex_activation_timeout` from the bounded explicit activation gate. None of these signals proves product correctness, and the final context audit below is what gates the merge in every case. The timeout fallback authorizes normal merge checks only; it never bypasses branch protection or required checks. When `<auto_merge>` is `false`, skip merging and report the PR as review-complete-but-unmerged or review-unavailable-and-unmerged.

1. **Stop the wait loop.** If Phase 3 started a background poll, stop it with `TaskStop` (or `CronDelete` for the cron fallback). Under `codex_activation_timeout`, no long-running poll exists; continue directly. No more review polling occurs after this point.
2. **Run the final context audit against a recorded base.** Fetch `origin/<base>`, record its SHA as `FINAL_AUDIT_BASE`, and record the current PR file set with `gh pr diff <pr_number> --repo <repo> --name-only`. Compare the cumulative review-driven diff from `REVIEW_BASE_HEAD` to the frozen Product Context Record. Confirm every hunk remains in original scope, preserves supported behavior and intended trade-offs, and has proportional user/operator value. On drift, roll back the drift and return to Phase 5 for validation/re-review; if rollback or product intent is ambiguous, stop and ask the user. Never merge merely because Codex approved.
3. **Check base freshness and mergeability.** Fetch `origin/<base>` again immediately before interpreting `gh pr view <pr_number> --repo <repo> --json mergeable,mergeStateStatus,baseRefName,headRefName`.
   - If `origin/<base>` advanced past `FINAL_AUDIT_BASE`, compare the files in `FINAL_AUDIT_BASE..origin/<base>` with the recorded PR file set. Any overlap → go to step 4 even when GitHub reports `MERGEABLE / CLEAN`; textual mergeability does not prove the combined same-file behavior. No overlap → update `FINAL_AUDIT_BASE` and continue.
   - `mergeable: MERGEABLE` with `mergeStateStatus` `CLEAN` / `UNSTABLE` / `BEHIND` and no overlapping base advance → go to step 5 (merge directly).
   - `mergeable: CONFLICTING` or `mergeStateStatus: DIRTY` → go to step 4.
   - `mergeable: UNKNOWN` → GitHub is still computing mergeability; wait briefly and re-check before deciding.
4. **Integration path — rebase the head onto `<base>`, then force-push.**
   1. Invoke the **rebase-on-canary** skill against the PR head (current-branch mode in the head's worktree, or its explicit `<worktree_path>`) with base = `<base>`. By default that skill auto-resolves conflicts by integrating both sides and validates the result.
   2. rebase-on-canary escalates only a genuinely ambiguous/unsafe conflict or a post-rebase validation failure. If it escalates, **halt auto-merge** and surface its report to the user — do not merge.
   3. On a successful rebase (clean or auto-resolved), run the available tests, typecheck, and build for every workspace affected by the overlapping files; a textually clean rebase does not waive integration validation. Confirm the current branch is `<headRefName>`, then publish the rewritten history with a lease: `git push --force-with-lease origin HEAD:<headRefName>`. Never `--force`; never force-push `<base>`.
   4. Wait for the rewritten head's remote checks, repeat the final context audit (step 2), then re-check base freshness and mergeability (step 3). If validation, CI, mergeability, or context fails, halt and escalate; never merge an integration result that changed product intent or supported behavior.
5. **Merge.** Fetch `origin/<base>` once more and repeat step 3 immediately before running `gh pr merge <pr_number> --repo <repo> --<merge_method>` (default `--squash`, matching the repo convention). Do not pass `--admin` or otherwise bypass branch protection or a required check — if the merge is rejected, halt and escalate.
6. **Verify the merge.** `gh pr view <pr_number> --repo <repo> --json state,mergedAt,mergeCommit` — confirm `state: MERGED` and record the merge commit SHA.
7. Go to Phase 7.

### Phase 7 — Cleanup & completion

**Autonomous cleanup (only when the merge succeeded).** When Phase 6 confirmed `state: MERGED`, clean up the merged head branch's local artifacts yourself — do **not** ask the user. Follow the git-worktree skill's remove flow:
1. If `<headRefName>` is in this task's dedicated worktree, invoke `git-worktree` remove mode. That skill owns protected/dirty/unpushed/ownership checks and removal commands. Terminate tmux only when the exact session is confirmed to belong to this task.
2. If the user authorized direct work in the main checkout, first confirm its current branch is `<headRefName>`, clean, and unprotected. Then switch to `<base>` and delete only the merged head branch. Otherwise preserve user changes and report incomplete cleanup.
3. Hard stops — never cross even autonomously: never delete the main checkout, and never delete a protected branch (`main` / `master` / `<base>`). The remote head branch is typically auto-deleted by GitHub on merge; otherwise leave it unless remote cleanup was requested.
4. Skip cleanup entirely when `<auto_merge>` is `false` or the merge halted — the branch and its worktree must survive for follow-up.

Then report in Korean:
- PR number, title, head/base, URL, draft flag.
- Frozen Product Context Record evidence, `REVIEW_BASE_HEAD`, `FINAL_AUDIT_BASE`, and the final cumulative context-audit outcome.
- Each review item across all passes: fix / declined / deferred, with verification evidence.
- Files changed, the initial commit SHA (fragment included when a feature-level note was warranted), later fix commit SHA(s), and push target(s).
- Validation commands and pass/fail status; note any check not run.
- The approval signal observed (Codex `+1` on the PR body), or the explicit activation request URL plus `codex_activation_timeout`; include every `@codex` follow-up comment URL.
- **Merge outcome**: merged (`<merge_method>` + merge commit SHA + whether a pre-merge rebase/force-push was needed), or — when `<auto_merge>` is `false` or auto-merge halted — the approved-but-unmerged state and the reason. The Phase 3 wait poll was stopped in Phase 6.
- **Cleanup outcome**: worktree removed / tmux session killed / local branch force-deleted, or skipped (with reason).

## Documentation Synthesis

PR titles, summaries, bodies, and `.changelog.d/` fragments are host-owned. Synthesize them directly from the frozen Product Context Record, verified `git diff`/`git log` evidence, and validated changelog fragments — never delegate documentation synthesis.

## Safety Rules

- Do not push commits directly to `main` / `master` / `<base>` or any protected branch — local pushes target only the PR's `headRefName`. Phase 6 integrates into `<base>` exclusively through the server-side `gh pr merge`, never a local push to the base.
- Do not address review items outside `<scope_hint>` that the user did not ask for.
- Do not treat reviewer severity, re-review comments, or approval as scope or product-policy authority; the frozen Product Context Record governs every pass and the final merge audit.
- Do not silently expand scope: no opportunistic refactors, formatting-only churn, or dependency bumps.
- Do not create a new branch mid-flow, amend, or close/reopen the PR. Do not rebase or force-push **except** the Phase 6 integration path: it rebases the head onto `<base>` for a textual conflict or overlapping post-audit base advance via the rebase-on-canary skill and force-pushes the result to `<headRefName>` with `--force-with-lease` only — never `--force`, never to `<base>`.
- Phase 6 merges only via `gh pr merge` with `<merge_method>` (default `squash`); never pass `--admin` or bypass branch protection or a required check — halt and escalate if the merge is rejected.
- Do not bypass Git hooks (`--no-verify`, `--no-gpg-sign`, etc.) without explicit user permission.
- Do not commit secrets, `.env` files, or generated artifacts that are not part of the change.
- Do not write commit messages in any language other than English.
- Do not post the `@codex` follow-up until the push has succeeded and the commit is visible on the remote.
- Do not invent validation results — if a check was not run, say so.
- Phase 7 autonomous cleanup runs only after Phase 6 confirms `state: MERGED`; it force-deletes only the merged head branch and its worktree/tmux session, never the main checkout or a protected branch (`main` / `master` / `<base>`).
- Create PRs only against `sbluemin/fleet-harness` with this skill.
