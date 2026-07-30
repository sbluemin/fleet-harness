---
name: git-worktree
description: git worktree 생성과 제거 라이프사이클을 하나의 절차로 통합해 실행하는 스킬입니다.
---

# Git Worktree

Use this skill to route a user request into exactly one git worktree lifecycle mode: **create** a new `.fleet/worktrees/<worktree-name>` checkout from `origin/canary`, or **remove** the currently active non-main worktree after safety checks. The user's free-form request may refine arguments, but it must stay inside one of these two workflows.

## Inputs

Replace each `<placeholder>` before running. The LLM must infer whether the request is create-mode or remove-mode from the user's extra text, then apply only that mode's inputs.

- `<mode>` — `create` | `remove`. Required by interpretation. Route phrases like "make/create/new worktree" to `create`; route phrases like "remove/delete/cleanup current worktree" to `remove`.
- `<worktree-name>` — Required for `create`. Use as the directory name under `.fleet/worktrees/` and as the default branch name. Sanitize by trimming whitespace, lowercasing only when the user did not provide a deliberate case-sensitive token, replacing spaces with `-`, and rejecting values containing `/`, `..`, leading `.`, shell metacharacters, or path separators. Allowed safe shape: `[A-Za-z0-9._-]+`.
- `<new-branch>` — Optional for `create`. Default `<worktree-name>`. Apply the same safety rejection as `<worktree-name>`; branch names must not be `main` or `master`.
- `<base-branch>` — Optional for `create`. Default `canary`. Reject `main` and `master`. Non-standard bases require Nimitz judgment before proceeding.
- `<force>` — Optional for `remove`. Default `yes` (autonomous cleanup). The remove flow self-applies `git worktree remove --force` and `git branch -D` as needed — including a squash-merged branch that `-d` rejects as unmerged — after reporting any dirty/unpushed/unmerged state. It never pauses for confirmation; the only hard stops are the main checkout and protected branches.
- `<delete-remote>` — Optional for `remove`. Default `no`. Delete the remote tracking branch (`git push origin --delete <branch>`) only when the user's request explicitly asks for remote cleanup.

## Goal

Create or remove a Fleet git worktree safely, without mutating unrelated files, without deleting the main checkout, and with the agent's subsequent command context fixed to the active worktree path when a new worktree is created. On removal, autonomously clean up the associated local branch — force-deleting it when needed (e.g. a squash-merged branch) — without pausing for confirmation, while never touching the main checkout or a protected branch (`main`/`master`/`canary`).

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
   - Validate `<worktree-name>` and `<new-branch>` using the sanitization rules from Inputs.
   - Reject `<base-branch>` when it is `main` or `master`.
   - Unless Nimitz has approved a non-standard base, use `canary`.

5. **Fetch the base**:
   - `git fetch origin canary`
   - For a Nimitz-approved non-standard `<base-branch>`, use `git fetch origin <base-branch>` instead.

6. **Create the worktree**:
   - `abs_worktree_path="$repo_root/.fleet/worktrees/<worktree-name>"`
   - `git worktree add -b <new-branch> .fleet/worktrees/<worktree-name> origin/canary`
   - For a Nimitz-approved non-standard `<base-branch>`, replace `origin/canary` with `origin/<base-branch>`.

7. **Fix the active command context**:
   - Run `cd <abs-worktree-path>`.
   - Treat `<abs-worktree-path>` as the required cwd for all subsequent commands in the task.
   - Do not continue issuing repository commands from the parent checkout unless the user explicitly redirects.

8. **Complete mandatory project setup inside the worktree**:
   - From `<abs-worktree-path>`, always run `pnpm install --frozen-lockfile` before reporting create-mode completion.
   - If installation fails, stop immediately and report the command failure. Do not report the worktree as ready and do not proceed to Carrier dispatch.

9. **Report in Korean**:
   - Worktree path.
   - Branch name and base branch.
   - Confirmation that cwd is now fixed to the worktree absolute path.
   - Confirmation that `pnpm install --frozen-lockfile` completed successfully inside the worktree.
   - Suggested next steps.

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
   - Record `<path>` as `current_top`, `<worktree-name>` as `basename "$current_top"`, and `<branch>` as the output of `git -C <path> branch --show-current`.

4. **Inspect local risk before removal**:
   - `git -C <path> status --short --branch`
   - `git -C <path> branch --show-current`
   - `git -C <path> rev-list --left-right --count @{upstream}...HEAD` when an upstream exists.
   - If there are uncommitted changes or unpushed commits, report them clearly.

5. **Proceed autonomously**:
   - Do not stop to ask for confirmation. After the risk inspection (step 4), continue the removal autonomously.
   - If the worktree is dirty or has unpushed commits, surface that state in the final report, then proceed with the force removal anyway — the only hard stops are the main checkout (step 3) and protected branches (step 8).

6. **Leave the worktree directory**:
   - Move out of the worktree before removal: `cd <parent-repo-root>`.
   - `<parent-repo-root>` is the main checkout path from `git worktree list --porcelain`.

7. **Remove and prune**:
   - Remove the worktree, self-applying `--force` as needed: `git worktree remove --force <path>` (untracked build artifacts such as `node_modules` otherwise block a plain removal).
   - `git worktree prune`

8. **Delete the branch**:
   - Refuse to delete protected branches: if `<branch>` is `main`, `master`, or `canary`, skip deletion and report the protection. This is a hard safety stop, not an escalation.
   - Refuse if `<branch>` is empty or `HEAD` (detached).
   - Delete the local branch autonomously: try `git branch -d <branch>` first, and when git reports it is not fully merged (the normal case after a squash merge), run `git branch -D <branch>`. Report that the branch was force-deleted, but do not pause for authorization.
   - Remote tracking branch deletion: only when `<delete-remote>` is set, run `git push origin --delete <branch>`. Otherwise leave the remote branch in place (GitHub usually auto-deletes a merged PR head).

9. **Report in Korean**:
    - Removed worktree path.
    - Branch name.
    - Whether local changes or unpushed commits were present.
    - Whether `--force` was used for the worktree removal.
    - Branch deletion result: deleted (safe), force-deleted, skipped (protected), skipped (unmerged, no force), or skipped (HEAD/detached).
    - Whether the remote tracking branch was deleted.
    - `git worktree prune` result.

## Safety Rules

- Do not force the base to `main` or `master`; reject those bases by default.
- Do not remove the main checkout under any circumstance.
- Never create or preserve a symlink inside the new worktree when its resolved target is any file or directory inside the main checkout. This prohibition applies to all main-checkout content, not only `node_modules`; pnpm-managed links that remain inside the new worktree or target a package store outside the main checkout are allowed. Install dependencies inside the active worktree with `pnpm install --frozen-lockfile`.
- Do not create helper scripts; execute commands directly through the `Bash` tool.
- Do not silently route free-form extra text outside the two lifecycle modes. Interpret it into `create` or `remove`, then allow changes only within that mode's workflow.
- Do not overwrite an existing worktree path or branch. If the path or branch already exists, stop and report.
- Do not delete protected branches (`main`, `master`, `canary`) under any circumstance.
- Do not delete the remote tracking branch (`git push origin --delete`) unless the user explicitly requests remote cleanup.
- Do not use destructive git commands such as `git reset --hard` or `git checkout --` to clean a worktree.
- Do not bypass hooks or hide command failures.

## Carrier Delegation Guidance

- **Nimitz** — consult before proceeding with any non-standard `<base-branch>` request. This is especially important when the requested base changes branch policy or release flow.
- **Stop and report** — when a worktree path or branch is already present or in use. Do not resolve collisions autonomously.
- Skip carrier delegation for clean create/remove operations that follow the standard `origin/canary` path and have no conflict or policy issue.
- **Carrier edits inside the new worktree** — after `create`, when you delegate file edits to a carrier (`carrier_dispatch`), pass the **absolute worktree path** as the dispatch `cwd` argument so the carrier's CLI spawns inside this worktree and its repo-relative paths resolve here. If you omit `cwd`, the carrier's cwd defaults to the **main checkout** (not this worktree), so omitting it for worktree work risks editing the main checkout — always set `cwd` for worktree delegation. Before dispatch, confirm `pnpm install --frozen-lockfile` succeeded in this worktree, identify every target package, and run each package's declared `typecheck` and `build` scripts from this worktree. If either preflight script is absent or fails, stop and report instead of dispatching. After each return run `git -C <main-checkout> status --short` to confirm the main checkout stayed clean, and treat the carrier's reported `workspaceChanges` (window-approx) as unreliable — trust the real `git status`.
