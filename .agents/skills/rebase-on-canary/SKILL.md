---
name: rebase-on-canary
description: 별도 워크트리 또는 현재 체크아웃된 브랜치의 토픽 브랜치를 canary 기준으로 리베이스하는 절차를 정의합니다. 기본적으로 충돌은 양측(both-sides) 의도를 통합해 스스로 해결하고 사후 검증하며, 해결 불가하거나 검증 실패 시에만 에스컬레이션합니다.
---

# Rebase on Canary

Use this skill to rebase a topic branch onto the latest `canary`. The target branch may live in a separate `git worktree` (the default, safest case — the main worktree driving this Admiral session is left intact) or be the branch **currently checked out** in the worktree this skill is invoked from. When the Admiral of the Navy explicitly targets the current branch (no separate worktree given, or `<worktree_path>` resolves to the current worktree), the skill rebases that checked-out branch in place — rewriting the current worktree's HEAD is then the intended action, not a safety violation. Topic-branch commit SHAs are rewritten by the rebase — this is intentional and the report must flag it so the Admiral of the Navy can decide whether a force-push is needed.

**Conflict default — self-resolve, do not stop-and-report.** By default (`<conflict_mode>` = `auto-resolve`) the skill resolves rebase conflicts itself by **integrating both sides** (the incoming `<base>` change and the topic's change) rather than dropping either or blindly picking one side, then continues the rebase and validates the rewritten tip. It escalates to the Admiral of the Navy **only** when a conflict is genuinely ambiguous/unsafe to reconcile or when post-rebase validation fails. Set `<conflict_mode>` = `stop` to restore the legacy stop-on-first-conflict behavior.

## Inputs

Replace each `<placeholder>` before running. Optional inputs may be left blank — defaults will be inferred.

- `<worktree_path>` — Absolute path to the target worktree. Optional. When omitted (or set to the path of the worktree this skill runs in), the skill targets the branch **currently checked out** in the current worktree (current-branch mode). Provide an explicit separate-worktree path to rebase another branch without disturbing the current one.
- `<base>` — Base branch name. Optional. Default `canary`. `main` / `master` are rejected unless the Admiral of the Navy explicitly overrides.
- `<remote>` — Remote name. Optional. Default `origin`.
- `<sync_local_base>` — `yes` | `no`. Optional. Default `yes`. When `yes`, fast-forward the local `<base>` to `<remote>/<base>` before rebasing.
- `<conflict_mode>` — `auto-resolve` | `stop`. Optional. Default `auto-resolve`. `auto-resolve`: reconcile each conflict by integrating both sides, `git add` the resolution, `git rebase --continue`, then validate the rewritten tip (escalate only on a genuinely unresolvable/unsafe conflict or a validation failure). `stop`: halt on the first conflict and report (legacy behavior).

> **Target resolution**: With `<worktree_path>` set to a *separate* worktree, that worktree's HEAD is rewritten and the main worktree stays untouched (default). With `<worktree_path>` omitted or pointing at the *current* worktree, the skill rebases the current branch in place — apply every precondition (clean tree, and the same conflict-handling policy selected by `<conflict_mode>`) to the current worktree just the same. If the local `<base>` branch is not checked out anywhere, skip the local-base mirror (step 6) and rebase directly onto `<remote>/<base>`.

## Goal

Rebase the topic branch in `<worktree_path>` onto `<remote>/<base>` (mirrored into local `<base>` when allowed), with a clean-tree precondition, a conflict-aware preview, default self-resolution of conflicts by integrating both sides, a post-rebase validation gate, and a verification report.

## Required Workflow

1. **Environment check** — Run in parallel via the `Bash` tool:
   - `pwd`
   - `git --version`
   - `git -C <worktree_path> rev-parse --is-inside-work-tree` (must print `true`)
   - `git -C <worktree_path> rev-parse --abbrev-ref HEAD` (record as `<topic>`)
   - `git worktree list` (record which worktree holds `<base>`)

2. **AGENTS.md check** — Read the repository root `AGENTS.md` once. No subdirectory rules apply because the rebase does not modify file content beyond the target worktree's branch.

3. **Working tree inspection** (target worktree):
   - `git -C <worktree_path> status --short --branch`
   - If the output is non-empty, stop and report the uncommitted changes. Do not stash, auto-commit, or `git checkout --` to make it clean.

4. **Base branch verification**:
   - Reject `<base>` when it equals `main` or `master` unless the Admiral of the Navy explicitly overrides.
   - Reject when `<base>` equals `<topic>`.

5. **Fetch the remote base**:
   - `git fetch <remote> <base>` (this updates `<remote>/<base>` only).

6. **Local base sync** (only when `<sync_local_base>` is `yes`):
   - `git rev-list --left-right --count <base>...<remote>/<base>` — read as `<local_ahead>	<remote_ahead>`.
   - If `<local_ahead> == 0` and `<remote_ahead> >= 1`, fast-forward the local ref:
     - Locate the worktree that holds `<base>` from step 1's `git worktree list`.
     - In that worktree: `git -C <base_worktree> status --short`. If non-empty, stop and report — do not attempt a non-FF or auto-stash.
     - Then: `git -C <base_worktree> merge --ff-only <remote>/<base>`.
   - If `<local_ahead> >= 1`, stop and report the divergence; the Admiral of the Navy must decide.
   - If both counts are `0`, the local base is already synchronized — proceed.

7. **Conflict preview** — Compute file overlap before rebasing:
   - `<merge_base>` = `git -C <worktree_path> merge-base <base> HEAD`.
   - Files changed in `<base>` since the merge base: `git -C <worktree_path> diff --name-only <merge_base>..<base>`.
   - Files changed in the topic since the merge base: `git -C <worktree_path> diff --name-only <merge_base>..HEAD`.
   - Print the intersection. Empty intersection ⇒ clean rebase highly likely. Non-empty ⇒ flag the files; proceed unless the Admiral of the Navy redirects.

8. **Run the rebase**:
   - `git -C <worktree_path> rebase <base>` (plain rebase — do not pass `-X ours`/`-X theirs`; a one-sided strategy would drop a side, which defeats the both-sides reconciliation in step 9).
   - On success (no conflict), continue to step 11.
   - On conflict, follow step 9.

9. **Conflict handling** (when step 8 reports a conflict):
   - In `<conflict_mode>` = `stop` (legacy): enumerate the conflicted hunks (`git -C <worktree_path> status`; `git -C <worktree_path> diff --diff-filter=U`), **stop and report** to the Admiral of the Navy, and await direction — do not edit markers or run `--continue` / `--abort` / `--skip`.
   - In `<conflict_mode>` = `auto-resolve` (default): resolve the rebase yourself without stopping —
     1. Enumerate conflicts: `git -C <worktree_path> status --short`; `git -C <worktree_path> diff --diff-filter=U`.
     2. For each conflicted file, read every hunk and **reconcile both sides** — keep the incoming `<base>` change *and* the topic's change, integrating their intent. Do not blindly delete or pick one side: for non-overlapping edits keep both; for overlapping edits combine them so neither change is lost. Remove all conflict markers.
     3. **Generated/derived files are an exception — never hand-merge them.** For Fleet Wiki knowledge artifacts under `.fleet/knowledge/**` (and any other generated index/count file), do not edit conflict markers: take one whole coherent side (`git -C <worktree_path> checkout --theirs|--ours <file>`) and regenerate via the owning tooling afterward; if regeneration is not possible here, escalate that file. Hand-merging generated counts corrupts them (see the wiki rebase doctrine).
     4. Stage the resolutions: `git -C <worktree_path> add <resolved files>`, then confirm none remain: `git -C <worktree_path> diff --diff-filter=U --name-only` is empty.
     5. Continue: `GIT_EDITOR=true git -C <worktree_path> rebase --continue` (so it does not open an editor).
     6. Repeat 1–5 for every subsequent conflicted commit until the rebase completes.
   - **Escalate (stop) only** when a hunk is genuinely ambiguous or unsafe to reconcile — a true semantic conflict where integrating both sides would be incorrect. Report that hunk and await direction instead of guessing. Do not run `git rebase --abort` without explicit instruction.

10. **Post-rebase validation** (whenever any conflict was auto-resolved):
    - Run the available checks for the affected workspace(s) on the rewritten tip — typecheck, build, and test (e.g. `pnpm --filter <pkg> typecheck && pnpm --filter <pkg> build && pnpm --filter <pkg> test`). State explicitly if a script is absent.
    - If validation **fails**, the auto-resolution is suspect: report the failure and the resolved hunks to the Admiral of the Navy and await direction — do not present a broken rewrite as done, and do not let a downstream caller force-push it.
    - A fully clean rebase (no conflicts touched) may skip to step 11.

11. **Verify the rebase result**:
    - `git -C <worktree_path> status --short` (must be empty).
    - `git -C <worktree_path> log --oneline <base>..HEAD` (must list only the rewritten topic commits resting on the new base tip).
    - `git -C <worktree_path> rev-list --left-right --count <base>...HEAD` (HEAD ahead = topic commit count, base ahead = `0`).
    - `git worktree list` (target worktree HEAD moved to the new tip).

12. **Report in Korean**:
    - Target worktree path and topic branch.
    - Old base tip → new base tip (the synchronized `<remote>/<base>` SHA).
    - Old topic tip → new topic tip, and the count of rewritten commits.
    - Conflict summary: none, or the list of conflicted files and **how each was auto-resolved** (the both-sides integration applied; any generated file taken whole + regenerated; any hunk escalated).
    - Post-rebase validation commands and pass/fail (or "not run" with reason).
    - Ahead/behind counts versus `<base>` after the rebase.
    - Follow-up actions the Admiral of the Navy must decide on, especially whether the topic branch was previously pushed (if yes, a force-push is required to publish the rewritten history — this skill does not perform that push).

## Safety Rules

- Do not run the rebase when the target worktree has uncommitted changes — stop and ask.
- Do not stash, auto-commit, or `git checkout --` to make a worktree clean.
- Do not pass `--rebase=merges`, `--autosquash`, or `--interactive` unless the Admiral of the Navy explicitly requests it.
- In the default `auto-resolve` mode, resolve conflicts yourself by integrating **both** sides, then validate (step 10) — escalate (stop) only a genuinely ambiguous/unsafe semantic conflict or a validation failure. Never blindly pick or delete one side for a semantic conflict, and never hand-merge generated `.fleet/knowledge/**` artifacts. In `stop` mode, never auto-resolve — halt on the first conflict and await direction.
- Do not run `git rebase --abort` or `--skip` without explicit instruction. `git rebase --continue` is allowed in `auto-resolve` mode after a reconciled resolution is staged; in `stop` mode it still requires explicit direction.
- Do not force-push the topic branch as part of this skill. Force-push (when the branch was already pushed) is a separate, explicit instruction by the Admiral of the Navy.
- Do not fast-forward local `<base>` from a worktree that has uncommitted changes — stop and report.
- Do not accept `main` or `master` as `<base>` without explicit override.
- Do not bypass Git hooks (`--no-verify`, `--no-gpg-sign`, etc.).
- Do not modify the main worktree's working tree beyond a fast-forward `git merge --ff-only` of local `<base>` — **unless** the Admiral of the Navy explicitly invokes current-branch mode, in which case rebasing the currently checked-out branch in place (rewriting that worktree's HEAD) is the intended action.
- Korean for the final report prose; English for any commit messages the Admiral of the Navy may request afterwards.

## Delegation Guidance

- **Genesis** — only when conflict resolution requires non-trivial code edits across multiple files. Provide `<objective>`, `<scope>` (conflicted files only), `<constraints>`, and `<references>` (the conflict hunks). Do not sortie Genesis preemptively before a conflict materializes.
- **Sentinel** — only when the Admiral of the Navy requests a post-rebase code review (typically after a conflict-heavy rebase).
- Skip delegation entirely for clean rebases — the skill is pure git orchestration in that case.
