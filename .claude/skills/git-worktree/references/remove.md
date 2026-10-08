# Remove a Worktree

## Before removal

1. Identify `<path>`, `<parent-repo-root>`, and `<branch>` using the active target's `git rev-parse --show-toplevel`, `git worktree list --porcelain`, and `git branch --show-current`. Use absolute paths.
2. **Before any removal command**, stop for the main checkout or a `main`/`master`/`canary` checkout. If `HEAD` is detached or the worktree-specific Git directory contains `fleet-baseline`, use only the removal section of [Baseline](baseline.md), then stop this branch flow. An empty branch without a confirmed detached `HEAD` is an error; report and stop. Never treat a missing baseline record as permission to remove an unowned detached checkout.
3. Inspect `git -C <path> status --short --branch`, upstream counts with `git -C <path> rev-list --left-right --count '@{upstream}...HEAD'` when available, and merge state. Disclose dirty/untracked files and unpushed/unmerged commits. Never clean another session's resources.
   This skill decides who removes a checkout. The session that created a detached baseline removes it under [Baseline](baseline.md)'s gates, which require that session's own creation evidence; another session, including an Objective's Commander, cannot pass them. The session that merges an ordinary branch removes its worktree and branch after the merge. In an Objective, the Commander's pre-hand-off cleanup removes any that remain: the ordinary branch worktrees and branches members created for that Objective, shown by their report or the objective record, plus verified isolated processes launched from them, once no session still uses them; step 4 still governs authorization. The console-e2e wrapper refuses a run directory owned by another session, so ask the member that launched an isolated Console to stop it. Before removing an Objective member's worktree, whether after its merge or in that pre-hand-off cleanup, copy into `evidence_dir` as text and seal only the member drafts a retrospective or handoff will cite and no merge, pull request, or other record keeps, and have the Commander attach them to a mission result; do not seal every draft.
   Resources of other sessions or objectives, or of uncertain ownership, stay protected.
4. Apply the user's current-worktree removal request or authorized post-merge cleanup scope. Default `<force>=yes` permits force cleanup after disclosing inspected local state. Explicit `<force>=no` prohibits force commands. A general task request or reading this file does not authorize deletion.

## Execution

Leave the worktree first, and stop only this session's own processes, such as a leftover background or timed-out `rg`, whose cwd is under `<path>`: `lsof -a -u "$(id -u)" -d cwd -Fpcn` lists every process of this user, so keep only entries whose `n` line is `<path>` or below it, and leave another session's process running. Stop the target's fsmonitor daemon after its last inspection, because any later Git command in `<path>` restarts it. `not running` and `not supported on this platform` (Git without a built-in daemon, such as on Linux) are a pass.

```bash
cd <parent-repo-root>
git -C <path> fsmonitor--daemon stop
git worktree remove <path>
```

Use `git worktree remove --force <path>` only when ordinary removal is blocked by dirty/untracked artifacts and force is authorized. Do not bypass locks or ownership failures with additional force. If removal fails, do not proceed to branch deletion.

```bash
git branch -d <branch>
```

If `-d` rejects the branch as unmerged and force is authorized, use `git branch -D <branch>`; squash-merged branches commonly need this. Recheck protected names and never delete them.

Removal already deletes this worktree's registration. Never run repository-wide pruning (`git worktree prune`, `git remote prune`, `git fetch --prune`): it also deletes other sessions' registrations and tracking refs.

Delete the remote only for explicit `<delete-remote>=yes`, using `git push origin --delete <branch>`; success also removes `refs/remotes/origin/<branch>`. Otherwise preserve it. When `git ls-remote --exit-code origin refs/heads/<branch>` exits 2 (the remote branch is already gone, for example deleted on merge), delete only this branch's tracking ref with `git update-ref -d refs/remotes/origin/<branch>`; otherwise preserve the tracking ref. Verify actual results through `git worktree list --porcelain` and branch lookup.

## Report

Include removed path/branch, prior local changes/unpublished commits, force usage, safe/forced deletion or preservation reason, and remote and tracking-ref outcome. Disclose failed steps and remaining resources.
