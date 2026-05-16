---
name: git-worktree
description: git worktree 생성과 제거 라이프사이클을 하나의 절차로 통합해 실행하는 스킬입니다.
---

# Git Worktree

Use this skill to route a user request into exactly one git worktree lifecycle mode: **create** a new `.fleet/worktrees/<worktree-name>` checkout from `origin/canary`, or **remove** the currently active non-main worktree after safety checks. The user's free-form request may refine arguments, but it must stay inside one of these two workflows.

## Inputs

Replace each `<placeholder>` before running. The LLM must infer whether the request is create-mode or remove-mode from the user's extra text, then apply only that mode's inputs.

- `<mode>` — `create` | `remove`. Required by interpretation. Route phrases like "make/create/new worktree" to `create`; route phrases like "remove/delete/cleanup current worktree" to `remove`.
- `<worktree-name>` — Required for `create`. Use as the directory name under `.fleet/worktrees/` and as the default branch/session name. Sanitize by trimming whitespace, lowercasing only when the user did not provide a deliberate case-sensitive token, replacing spaces with `-`, and rejecting values containing `/`, `..`, leading `.`, shell metacharacters, or path separators. Allowed safe shape: `[A-Za-z0-9._-]+`.
- `<new-branch>` — Optional for `create`. Default `<worktree-name>`. Apply the same safety rejection as `<worktree-name>`; branch names must not be `main` or `master`.
- `<tmux-session-name>` — Optional for `create`. Default `<worktree-name>`. Apply the same safety rejection as `<worktree-name>`; this skill owns the tmux convention because the Fleet repository does not currently define one elsewhere.
- `<base-branch>` — Optional for `create`. Default `canary`. Reject `main` and `master`. Non-standard bases require Nimitz judgment before proceeding.
- `<session>` — Optional for `remove`. Default to the current worktree directory basename. Kill this tmux session only if it exists.
- `<force>` — Optional for `remove`. Default `no`. Use `git worktree remove --force` and `git branch -D` only when the user's request explicitly includes a force flag or equivalent instruction after dirty/unpushed/unmerged state has been reported.
- `<delete-remote>` — Optional for `remove`. Default `no`. Delete the remote tracking branch (`git push origin --delete <branch>`) only when the user's request explicitly asks for remote cleanup.

## Goal

Create or remove a Fleet git worktree safely, without mutating unrelated files, without deleting the main checkout, and with the agent's subsequent command context fixed to the active worktree path when a new worktree is created. On removal, also clean up the associated local branch when it is safe to do so, while leaving protected branches and unmerged work intact unless the user explicitly authorizes a force delete.

## Required Workflow

### Mode Routing

1. Parse the user's request and choose exactly one mode: `create` or `remove`.
2. If the request could reasonably mean both create and remove, stop and ask for clarification.
3. Do not invent a third mode. Additional free text may only fill placeholders or select allowed mode-specific options.

### Create Mode

1. **Environment check** — Run via the `Bash` tool:
   - `pwd`
   - `uname -a`
   - `echo "SHELL=$SHELL"`
   - `git --version`

2. **AGENTS.md check** — Read the repository root `AGENTS.md` before planning or work. If the workflow later references a subdirectory with its own `AGENTS.md`, read that file too and let child rules override parent rules within that scope.

3. **Repository root resolution**:
   - `repo_root="$(git rev-parse --show-toplevel)"`
   - `cd "$repo_root"`
   - Confirm `.fleet/worktrees/` is inside the repository root.

4. **Input validation**:
   - Validate `<worktree-name>`, `<new-branch>`, and `<tmux-session-name>` using the sanitization rules from Inputs.
   - Reject `<base-branch>` when it is `main` or `master`.
   - Unless Nimitz has approved a non-standard base, use `canary`.

5. **Fetch the base**:
   - `git fetch origin canary`
   - For a Nimitz-approved non-standard `<base-branch>`, use `git fetch origin <base-branch>` instead.

6. **Create the worktree**:
   - `abs_worktree_path="$repo_root/.fleet/worktrees/<worktree-name>"`
   - `git worktree add -b <new-branch> .fleet/worktrees/<worktree-name> origin/canary`
   - For a Nimitz-approved non-standard `<base-branch>`, replace `origin/canary` with `origin/<base-branch>`.

7. **Create or report the tmux session**:
   - Fleet has no repository-wide tmux convention documented elsewhere; this skill defines the convention as session name = `<tmux-session-name>`, cwd fixed with `-c <abs-worktree-path>`, and detached creation with `-d`.
   - First check for a duplicate session: `tmux has-session -t <tmux-session-name>`.
   - If the session exists, do not create another one. Report that the user can attach with `tmux attach -t <tmux-session-name>`.
   - If the session does not exist: `tmux new-session -d -s <tmux-session-name> -c <abs-worktree-path>`.

8. **Fix the active command context**:
   - Run `cd <abs-worktree-path>`.
   - Treat `<abs-worktree-path>` as the required cwd for all subsequent commands in the task.
   - Do not continue issuing repository commands from the parent checkout unless the user explicitly redirects.

9. **Report in Korean**:
   - Worktree path.
   - Branch name and base branch.
   - tmux session name and whether it was created or already existed.
   - Confirmation that cwd is now fixed to the worktree absolute path.
   - Suggested next steps.
   - Note that dependency installation (`pnpm install`) is intentionally not part of this skill; the user runs it manually if needed.

### Remove Mode

1. **Environment check** — Run via the `Bash` tool:
   - `pwd`
   - `uname -a`
   - `echo "SHELL=$SHELL"`
   - `git --version`

2. **AGENTS.md check** — Read the repository root `AGENTS.md` before planning or work. If the active worktree contains additional applicable `AGENTS.md` files for referenced paths, read them too.

3. **Determine the currently active worktree**:
   - `current_top="$(git rev-parse --show-toplevel)"`
   - `git worktree list --porcelain`
   - Identify the main checkout from the porcelain list's primary/root worktree entry.
   - If `current_top` is the main checkout repository root, immediately refuse. Never remove the main checkout.
   - Record `<path>` as `current_top`, `<worktree-name>` as `basename "$current_top"`, `<session>` as the provided session or `<worktree-name>`, and `<branch>` as the output of `git -C <path> branch --show-current`.

4. **Inspect local risk before removal**:
   - `git -C <path> status --short --branch`
   - `git -C <path> branch --show-current`
   - `git -C <path> rev-list --left-right --count @{upstream}...HEAD` when an upstream exists.
   - If there are uncommitted changes or unpushed commits, report them clearly.

5. **Confirm intent**:
   - Unless the user's additional request text includes an explicit force/confirm flag, stop and ask for confirmation before removing the worktree.
   - Dirty worktrees must never be force-removed without explicit user confirmation after the risk report.

6. **Leave the worktree directory**:
   - Move out of the worktree before removal: `cd <parent-repo-root>`.
   - `<parent-repo-root>` is the main checkout path from `git worktree list --porcelain`.

7. **Kill the matching tmux session only if present**:
   - `tmux has-session -t <session>`
   - If present: `tmux kill-session -t <session>`
   - If absent, continue without error.

8. **Remove and prune**:
   - Normal removal: `git worktree remove <path>`.
   - Forced removal: `git worktree remove --force <path>` only when `<force>` is explicitly authorized by the user.
   - `git worktree prune`

9. **Delete the branch**:
   - Refuse to delete protected branches: if `<branch>` is `main`, `master`, or `canary`, skip deletion and report the protection.
   - Refuse if `<branch>` is empty or `HEAD` (detached).
   - Attempt a safe delete first: `git branch -d <branch>`. If git reports the branch is not fully merged, do not retry automatically.
   - Forced delete: only when `<force>` is explicitly authorized by the user, run `git branch -D <branch>` after reporting the unmerged state.
   - Remote tracking branch deletion: only when `<delete-remote>` is explicitly authorized, run `git push origin --delete <branch>`. Otherwise leave the remote branch in place.

10. **Report in Korean**:
    - Removed worktree path.
    - Branch name.
    - Whether local changes or unpushed commits were present.
    - Whether tmux session `<session>` was killed or absent.
    - Whether `--force` was used for the worktree removal.
    - Branch deletion result: deleted (safe), force-deleted, skipped (protected), skipped (unmerged, no force), or skipped (HEAD/detached).
    - Whether the remote tracking branch was deleted.
    - `git worktree prune` result.

## Safety Rules

- Do not force the base to `main` or `master`; reject those bases by default.
- Do not remove the main checkout under any circumstance.
- Do not force-remove a dirty worktree without explicit user confirmation after reporting the dirty state.
- Do not run `pnpm install`, `npm install`, or any other dependency installer as part of this skill; dependency setup is out of scope.
- Do not create helper scripts; execute commands directly through the `Bash` tool.
- Do not silently route free-form extra text outside the two lifecycle modes. Interpret it into `create` or `remove`, then allow changes only within that mode's workflow.
- Do not overwrite an existing worktree path or branch. If the path or branch already exists, stop and report.
- Do not delete protected branches (`main`, `master`, `canary`) under any circumstance.
- Do not force-delete (`git branch -D`) an unmerged branch without explicit user authorization after reporting the unmerged state.
- Do not delete the remote tracking branch (`git push origin --delete`) unless the user explicitly requests remote cleanup.
- Do not use destructive git commands such as `git reset --hard` or `git checkout --` to clean a worktree.
- Do not bypass hooks or hide command failures.

## Carrier Delegation Guidance

- **Nimitz** — consult before proceeding with any non-standard `<base-branch>` request. This is especially important when the requested base changes branch policy or release flow.
- **Stop and report** — when a worktree path, branch, or tmux session is already present or in use. Do not resolve collisions autonomously.
- Skip carrier delegation for clean create/remove operations that follow the standard `origin/canary` path and have no conflict or policy issue.
