# Rebase Against the Remote Base

Replace every placeholder and run repository commands against the absolute target path.

## Freeze target and base

```bash
git -C <worktree_path> rev-parse --is-inside-work-tree
git -C <worktree_path> branch --show-current
git -C <worktree_path> status --short
git -C <worktree_path> worktree list --porcelain
```

`status --short` must be empty. Do not mistake the branch header from `status --short --branch` for a dirty file. Apply the entrypoint's topic/base protection first.

```bash
git -C <worktree_path> rev-parse HEAD
git -C <worktree_path> fetch <remote> <base>
git -C <worktree_path> rev-parse <remote>/<base>
```

Record the previous local-base SHA when available, but `<upstream>` below always means `<remote>/<base>`. Specify the actual SHAs/branches needed in each independent call.

## Optional local-base mirror

Only when `<sync_local_base>=yes` and local base has a checked-out worktree:

```bash
git -C <worktree_path> rev-list --left-right --count <base>...<upstream>
```

- Local ahead ≥ 1: report divergence and stop.
- Remote ahead only: confirm `<base_worktree>` has empty `status --short`, then run `git -C <base_worktree> merge --ff-only <upstream>`.
- Equal tips or no base checkout: skip the mirror. `sync_local_base=no` also skips it, without changing the remote rebase target.

## Preview and rebase

```bash
git -C <worktree_path> merge-base <upstream> HEAD
git -C <worktree_path> diff --name-only <merge-base>..<upstream>
git -C <worktree_path> diff --name-only <merge-base>..HEAD
git -C <worktree_path> rebase <upstream>
```

The file-list intersection identifies verification candidates, not certain conflicts. Use plain rebase.

## Conflicts

In `stop` mode, report `status` and `diff --diff-filter=U`, then stop. In default `auto-resolve`, read each hunk and applicable child instructions, preserving incoming and topic intent together.

Never hand-merge counts/indexes in derived files such as `.fleet/knowledge/**`. Select one coherent whole side required by the owning tool and regenerate. Verify ours/theirs semantics during rebase before applying `git checkout --ours <file>` or `--theirs` to a specific generated file. If regeneration is unavailable, report the conflict and stop.

```bash
git -C <worktree_path> add <resolved-files>
git -C <worktree_path> diff --diff-filter=U --name-only
GIT_EDITOR=true git -C <worktree_path> rebase --continue
```

Continue only when the unmerged list is empty. Repeat for each conflicted commit. Do not force incompatible semantics together or abort/skip without user instruction.

## Verification

Run available checks for resolved workspaces using their real script names:

```bash
cd <worktree_path> && pnpm --filter <pkg> typecheck && pnpm --filter <pkg> build && pnpm --filter <pkg> test
```

Disclose absent scripts. A failed check makes the resolution suspect; do not publish the rewritten tip. For clean rebases, choose scoped checks and record why they suffice.

```bash
git -C <worktree_path> status --short
git -C <worktree_path> merge-base --is-ancestor <upstream> HEAD
git -C <worktree_path> log --oneline <upstream>..HEAD
git -C <worktree_path> rev-list --left-right --count <upstream>...HEAD
```

Completion requires a clean tree, successful ancestry check, and left=0. Report old/new SHAs, checks, and conflict-integration evidence. Do not push.
