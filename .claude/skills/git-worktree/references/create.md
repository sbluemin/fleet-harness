# Create a Worktree

1. Use `pwd`, `git --version`, `git rev-parse --show-toplevel`, and `git worktree list --porcelain` to identify the current path, repository, and worktrees. Check OS/shell when command selection depends on them. Read applicable `CLAUDE.md` instructions not already loaded.
2. Identify `<repo-root>` from the first porcelain worktree entry. Confirm `.fleet/worktrees/<worktree-name>` is a new path within it. Stop if the directory or branch already exists.
3. Apply the entrypoint's name, base, and protected-branch rules. Replace every placeholder below with a validated value.

```bash
git -C <repo-root> fetch origin canary
git -C <repo-root> worktree add -b <new-branch> <repo-root>/.fleet/worktrees/<worktree-name> origin/canary
cd <repo-root>/.fleet/worktrees/<worktree-name> && pnpm install --frozen-lockfile
```

Change both fetch and `origin/canary` only for a user-confirmed nonstandard base. Install dependencies inside the new worktree; never borrow main-checkout files through symlinks.

4. Stop immediately if installation fails. Distinguish an existing new checkout from a ready environment, report the failed command, and do not proceed to edits.
5. On success, report absolute worktree path, branch/base, successful installation, and the fixed command context. Use `cd <absolute-worktree> && …` or `git -C <absolute-worktree> …` in every independent Bash call.
6. After edits, check `git -C <repo-root> status --short` for leaked main-checkout changes. Preserve any user changes that existed initially.
