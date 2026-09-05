---
name: git-worktree
description: Create a canary-based worktree for Fleet repository changes or clean up the current dedicated worktree. Use rebase-on-canary to refresh an existing branch; read-only investigation needs no new worktree.
---

# Git Worktree

Interpret the request as exactly `create` or `remove`. A repository change requiring a dedicated checkout means create. Ask only if both modes are plausible. Never adopt another session's worktree or overwrite an existing path.

## Inputs

- `<worktree-name>`: create directory and default branch name. Infer a task-specific name when absent.
- `<new-branch>`: optional; defaults to `<worktree-name>`.
- `<base-branch>`: defaults to `canary`. Reject `main`/`master`; ask before using any other base.
- `<delete-remote>`: remove only; defaults to `no`. Set `yes` only for explicit remote-cleanup requests.
- `<force>`: local removal defaults to `yes`. With explicit `no`, do not force-remove the worktree or force-delete its branch; report the blocked state.

Trim names and replace internal spaces with `-`, preserving deliberate capitalization. Reject characters outside `[A-Za-z0-9._-]+`, `/`, `..`, leading `.`, path separators, and shell metacharacters. Neither a new nor deleted branch may be `main`/`master`/`canary`.

## Safety boundaries

- Never remove the main checkout. Stop **before removal commands** for protected-branch worktrees too.
- Never create or preserve a new-worktree symlink targeting main-checkout content. pnpm links within the new worktree or to an external package store are allowed.
- Never replace colliding paths/branches automatically. Do not use `reset --hard`, forced file restoration, or hook bypasses to clean up.
- Removal requires a request targeting the current dedicated worktree or authorized post-merge cleanup. Inspect and disclose dirty/unpushed/unmerged state first; force cleanup stays within that authority. Reading this skill as a reference does not authorize deletion.

## Execution routes

| Mode | Read before execution | Completion condition |
|---|---|---|
| create | [Create](references/create.md) | New checkout from remote base, successful internal `pnpm install --frozen-lockfile`, subsequent commands fixed to its path |
| remove | [Remove](references/remove.md) | Verified removal/prune, local-branch outcome, remote preservation/deletion reported |

Do not skip path, ownership, or branch-protection checks. Execute this lifecycle directly through Bash rather than creating temporary helper scripts. Stop immediately on create-mode installation failure; do not call the worktree ready. On removal failure, report exactly what remains.

After creation, every edit/command uses the absolute worktree path. Set the execution root for background commands too; a green check in the main checkout is not evidence. Reading main-checkout status to detect leaked edits is an explicit read-only exception.
