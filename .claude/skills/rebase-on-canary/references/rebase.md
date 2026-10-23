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
git -C <worktree_path> merge-base --is-ancestor <upstream> HEAD
```

Exit 0 means the topic already contains the remote base: do not run `rebase`, keep HEAD and its merge commits as they are, and skip to the closing status/ancestry/count block at the end of Verification (entrypoint step 5); nothing was rewritten, so the checks before it do not apply. Plain rebase does not stop there when the topic holds a merge commit; it drops the merge and replays the topic commits, so conflicts the merge resolved come back. Exit 1 continues below; any other code is an error to report.

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

Refresh workspace dependencies before the first check whenever the rebase pulled in commits that touched another package. The linked copies in `node_modules` still hold the pre-rebase build, so `typecheck` reports a burst of `has no exported member` and missing-property errors in packages you never edited — which reads as pre-existing base breakage and invites reporting a green base as red.

Run available checks for resolved workspaces using their real script names:

```bash
cd <worktree_path> && pnpm install --frozen-lockfile
cd <worktree_path> && pnpm --filter <pkg> typecheck && pnpm --filter <pkg> build && pnpm --filter <pkg> test
```

Disclose absent scripts. A failed check makes the resolution suspect; do not publish the rewritten tip. Before attributing the failure, run the same check alternately on a `git-worktree` baseline at `<upstream>` and on the rebased HEAD, at least three runs each, and report the pass/fail counts: a failure only on HEAD points at the rebase, one on both sides is pre-existing or intermittent. The counts do not lift the publishing block by themselves. For clean rebases, choose scoped checks and record why they suffice.

When the branch contained a change that has since been merged into the base on its own — a stacked PR rebased after its lower PR landed — a file can merge without conflict and still hold both the base's copy of a block and the branch's revised copy. Compare every touched path, conflicted or not, against the pre-rebase tip: `git -C <worktree_path> diff <pre-rebase-tip> HEAD -- <path>` should show only the base's own later changes, never a duplicated declaration or block.

```bash
git -C <worktree_path> status --short
git -C <worktree_path> merge-base --is-ancestor <upstream> HEAD
git -C <worktree_path> log --oneline <upstream>..HEAD
git -C <worktree_path> rev-list --left-right --count <upstream>...HEAD
```

Completion requires a clean tree, successful ancestry check, and left=0. Report old/new SHAs, checks, and conflict-integration evidence. Do not push.
