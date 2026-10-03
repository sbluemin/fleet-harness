---
name: git-worktree
description: Create a canary-based worktree for Fleet changes, create a detached baseline for revision comparison or bisect, or remove an owned dedicated checkout. Use rebase-on-canary to refresh an existing branch; ordinary read-only investigation needs no new worktree.
---

# Git Worktree

Interpret the request as `create` or `remove`. Creation defaults to a branch for repository changes; use the detached baseline route only when the task needs a separate historical revision for comparison or bisect. A baseline is read-only source, not an implementation checkout. Ask only when the intended action or revision is unclear. Never adopt another session's worktree or overwrite an existing path.

## Inputs

- `<worktree-name>`: the directory under `.fleet/worktrees/`. Infer a task-specific name when absent; when only a branch is given, use it with `/` replaced by `-`.
- `<new-branch>`: branch creation only; defaults to `<worktree-name>`. May carry one Conventional Commits type prefix (`fix/<name>`, `feat/<name>`), as on the remote; a flat name is equally valid.
- `<base-branch>`: branch creation only; defaults to `canary`. Reject `main`/`master`; ask before using any other base.
- `<revision>`: baseline creation only; the task's specific commit or ref, resolved once to a full commit SHA. No implicit `canary` fallback and no new branch.
- `<delete-remote>`: branch removal only; defaults to `no`. Set `yes` only for explicit remote-cleanup requests.
- `<force>`: branch removal defaults to `yes`. With explicit `no`, do not force-remove the worktree or force-delete its branch; report the blocked state. Baseline removal never uses force.

Trim names and replace internal spaces with `-`, preserving deliberate capitalization. A segment matches `[A-Za-z0-9._-]+` without `..`, a leading `.`, or a trailing `.lock`; reject everything else, including backslashes and shell metacharacters. The directory name is exactly one segment. A branch name is one segment or `<type>/<segment>` with `<type>` a lowercase Conventional Commits type (`fix`, `feat`, …); reject any other `/`. Neither a new nor deleted branch may be `main`/`master`/`canary`.

## Safety boundaries

- Never remove the main checkout. Stop **before removal commands** for protected-branch worktrees too.
- Never create or preserve a new-worktree symlink targeting main-checkout content. pnpm links within the new worktree or to an external package store are allowed.
- Never replace colliding paths/branches automatically. Do not use `reset --hard`, forced file restoration, or hook bypasses to clean up.
- Removal requires a request targeting the owned dedicated worktree, authorized post-merge cleanup, or an explicitly disposable baseline created for the current task. Inspect and disclose dirty/unpushed/unmerged state first; branch force cleanup stays within that authority. A general task request or reading this skill as a reference does not authorize deletion.

## Execution routes

| Mode | Read before execution | Completion condition |
|---|---|---|
| create branch | [Create](references/create.md) | New checkout from remote base, successful internal `pnpm install --frozen-lockfile`, subsequent commands fixed to its path |
| create baseline | [Baseline](references/baseline.md) | Detached checkout at the recorded commit, ownership evidence saved, required preparation completed |
| remove | [Remove](references/remove.md); it routes baselines separately | Verified removal, branch/remote outcome or baseline evidence reported |

Do not skip path, ownership, or branch-protection checks. Execute this lifecycle directly through Bash rather than creating temporary helper scripts. Stop immediately on installation failure in either creation route; do not call the worktree ready. On removal failure, report exactly what remains.

After creation, every edit/command uses the absolute worktree path. Set the execution root for background commands too; a green check in the main checkout is not evidence. Reading main-checkout status to detect leaked edits is an explicit read-only exception.
