# Remove a Worktree

## Before removal

1. Identify `<path>`, `<parent-repo-root>`, and `<branch>` using the active target's `git rev-parse --show-toplevel`, `git worktree list --porcelain`, and `git branch --show-current`. Use absolute paths.
2. **Before any removal command**, stop for the main checkout or a `main`/`master`/`canary` checkout. Also report and stop for an empty branch or detached `HEAD`; this is a branch lifecycle.
3. Inspect `git -C <path> status --short --branch`, upstream counts with `git -C <path> rev-list --left-right --count '@{upstream}...HEAD'` when available, and merge state. Disclose dirty/untracked files and unpushed/unmerged commits. Never clean another session's resources.
4. Apply the user's current-worktree removal request or authorized post-merge cleanup scope. Default `<force>=yes` permits force cleanup after disclosing inspected local state. Explicit `<force>=no` prohibits force commands. A general task request or reading this file does not authorize deletion.

## Execution

Leave the worktree first:

```bash
cd <parent-repo-root>
git worktree remove <path>
```

Use `git worktree remove --force <path>` only when ordinary removal is blocked by dirty/untracked artifacts and force is authorized. Do not bypass locks or ownership failures with additional force. If removal fails, do not proceed to branch deletion.

```bash
git worktree prune
git branch -d <branch>
```

If `-d` rejects the branch as unmerged and force is authorized, use `git branch -D <branch>`; squash-merged branches commonly need this. Recheck protected names and never delete them.

Delete the remote only for explicit `<delete-remote>=yes`, using `git push origin --delete <branch>`. Otherwise preserve it. Verify actual results through `git worktree list --porcelain` and branch lookup.

## Report

Include removed path/branch, prior local changes/unpublished commits, force usage, safe/forced deletion or preservation reason, remote outcome, and prune result. Disclose failed steps and remaining resources.
