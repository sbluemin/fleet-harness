---
name: rebase-on-canary
description: 별도 워크트리 또는 현재 체크아웃된 브랜치의 토픽 브랜치를 canary 기준으로 리베이스하는 절차를 정의합니다.
---

# Rebase on Canary

Use this skill to rebase a topic branch onto the latest `canary`. The target branch may live in a separate `git worktree` (the default, safest case — the main worktree driving this Admiral session is left intact) or be the branch **currently checked out** in the worktree this skill is invoked from. When the Admiral of the Navy explicitly targets the current branch (no separate worktree given, or `<worktree_path>` resolves to the current worktree), the skill rebases that checked-out branch in place — rewriting the current worktree's HEAD is then the intended action, not a safety violation. Topic-branch commit SHAs are rewritten by the rebase — this is intentional and the report must flag it so the Admiral of the Navy can decide whether a force-push is needed.

## Inputs

Replace each `<placeholder>` before running. Optional inputs may be left blank — defaults will be inferred.

- `<worktree_path>` — Absolute path to the target worktree. Optional. When omitted (or set to the path of the worktree this skill runs in), the skill targets the branch **currently checked out** in the current worktree (current-branch mode). Provide an explicit separate-worktree path to rebase another branch without disturbing the current one.
- `<base>` — Base branch name. Optional. Default `canary`. `main` / `master` are rejected unless the Admiral of the Navy explicitly overrides.
- `<remote>` — Remote name. Optional. Default `origin`.
- `<sync_local_base>` — `yes` | `no`. Optional. Default `yes`. When `yes`, fast-forward the local `<base>` to `<remote>/<base>` before rebasing.

> **Target resolution**: With `<worktree_path>` set to a *separate* worktree, that worktree's HEAD is rewritten and the main worktree stays untouched (default). With `<worktree_path>` omitted or pointing at the *current* worktree, the skill rebases the current branch in place — apply every precondition (clean tree, conflict-stop, no auto-resolve) to the current worktree just the same. If the local `<base>` branch is not checked out anywhere, skip the local-base mirror (step 6) and rebase directly onto `<remote>/<base>`.

## Goal

Rebase the topic branch in `<worktree_path>` onto `<remote>/<base>` (mirrored into local `<base>` when allowed), with a clean-tree precondition, conflict-aware preview, and a single-stop verification report.

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
   - `git -C <worktree_path> rebase <base>`.
   - On success, continue to step 10.
   - On conflict, follow step 9 — do not auto-resolve.

9. **Conflict handling** (only when step 8 reports a conflict):
   - Enumerate conflicted hunks:
     - `git -C <worktree_path> status`
     - `git -C <worktree_path> diff --diff-filter=U`
   - **Stop and report** the conflicted files and hunks to the Admiral of the Navy. Do not invoke `--skip`, `--abort`, or `--continue` without explicit instruction. Do not auto-edit conflict markers.
   - Await direction. Possible orders include manual resolution, sortieing Genesis with the conflict context, or `git rebase --abort`.
   - After the Admiral of the Navy resolves conflicts and approves continuation:
     - Verify each previously conflicted file is staged: `git -C <worktree_path> status --short`.
     - `git -C <worktree_path> rebase --continue`.
     - Repeat step 9 on every subsequent conflict.

10. **Verify the rebase result**:
    - `git -C <worktree_path> status --short` (must be empty).
    - `git -C <worktree_path> log --oneline <base>..HEAD` (must list only the rewritten topic commits resting on the new base tip).
    - `git -C <worktree_path> rev-list --left-right --count <base>...HEAD` (HEAD ahead = topic commit count, base ahead = `0`).
    - `git worktree list` (target worktree HEAD moved to the new tip).

11. **Report in Korean**:
    - Target worktree path and topic branch.
    - Old base tip → new base tip (the synchronized `<remote>/<base>` SHA).
    - Old topic tip → new topic tip, and the count of rewritten commits.
    - Conflict summary: none, or the list of conflicted files plus how each was resolved.
    - Ahead/behind counts versus `<base>` after the rebase.
    - Follow-up actions the Admiral of the Navy must decide on, especially:
      - Whether the topic branch was previously pushed (if yes, a force-push will be required to publish the rewritten history — this skill does not perform that push).
      - Re-running typecheck / build / tests on the rewritten tip.

## Safety Rules

- Do not run the rebase when the target worktree has uncommitted changes — stop and ask.
- Do not stash, auto-commit, or `git checkout --` to make a worktree clean.
- Do not pass `--rebase=merges`, `--autosquash`, or `--interactive` unless the Admiral of the Navy explicitly requests it.
- Do not auto-resolve conflicts. Conflicts always stop the workflow and require explicit direction.
- Do not run `git rebase --abort`, `--skip`, or `--continue` without explicit instruction.
- Do not force-push the topic branch as part of this skill. Force-push (when the branch was already pushed) is a separate, explicit instruction by the Admiral of the Navy.
- Do not fast-forward local `<base>` from a worktree that has uncommitted changes — stop and report.
- Do not accept `main` or `master` as `<base>` without explicit override.
- Do not bypass Git hooks (`--no-verify`, `--no-gpg-sign`, etc.).
- Do not modify the main worktree's working tree beyond a fast-forward `git merge --ff-only` of local `<base>` — **unless** the Admiral of the Navy explicitly invokes current-branch mode, in which case rebasing the currently checked-out branch in place (rewriting that worktree's HEAD) is the intended action.
- Korean for the final report prose; English for any commit messages the Admiral of the Navy may request afterwards.

## Carrier Delegation Guidance

- **Genesis** — only when conflict resolution requires non-trivial code edits across multiple files. Provide `<objective>`, `<scope>` (conflicted files only), `<constraints>`, and `<references>` (the conflict hunks). Do not sortie Genesis preemptively before a conflict materializes.
- **Sentinel** — only when the Admiral of the Navy requests a post-rebase code review (typically after a conflict-heavy rebase).
- Skip carrier delegation entirely for clean rebases — the skill is pure git orchestration in that case.
