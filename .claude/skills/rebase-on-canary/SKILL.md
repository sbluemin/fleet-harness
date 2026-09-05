---
name: rebase-on-canary
description: Rebase an existing topic branch onto the latest remote canary, preserving both sides of conflicts and validating resolutions. Not for worktree creation/removal or releasing public canary.
---

# Rebase on Canary

Replay the target topic's commits onto the latest remote base. Regardless of local-base synchronization, the fetched **`<remote>/<base>`** is the rebase and final-verification reference. This skill never pushes.

## Inputs

- `<worktree_path>`: absolute target; defaults to the topic in the current active worktree.
- `<base>` / `<remote>`: default `canary` / `origin`. A `main`/`master` base requires explicit override.
- `<sync_local_base>`: default `yes`. Mirror by fast-forward only when that base has a clean checked-out worktree; otherwise skip the mirror.
- `<conflict_mode>`: default `auto-resolve`. With `stop`, return control at the first conflict without editing or continuing.

## Boundaries

Verify target path and branch first. Reject topic=base or a protected topic (`main`/`master`/`canary`). Never stash, auto-commit, or force-restore a dirty target. Rebase a topic directly in the main checkout only when the user explicitly targets that current branch.

## Execution and completion

Read [Remote-base rebase procedure](references/rebase.md).

1. Verify target/remote base and a clean tree. Do not reread already loaded instructions, but apply child `CLAUDE.md` rules when editing conflicted files.
2. After fetch, record remote-base SHA and old topic SHA. Perform the optional safe local-base mirror and preview overlapping files against the remote base.
3. Run plain rebase. By default integrate incoming and topic intent; never discard a side wholesale with `-X ours`/`-X theirs`. Regenerate derived files with their owning tools and do not guess through semantic conflicts.
4. After resolving conflicts, run affected workspace tests/typecheck/build. Even a textually clean rebase may need relevant checks when overlapping changes interact. If validation fails, report the unresolved outcome and block downstream publishing.
5. Confirm a clean tree, remote base as an ancestor of HEAD, zero behind count, and the expected topic commit list.

Report old/new base/topic SHA, rewrite count, per-conflict integration, checks and skipped-check reasons, and ahead/behind counts. If the topic was published, disclose rewritten SHAs; force-push remains a separately authorized action.

Do not use `--abort`, `--skip`, interactive/autosquash/rebase-merges, or hook bypasses without explicit instruction. Preserve and report state on ambiguous conflicts, local-base divergence, or failed validation.
