# Detached Baseline

Use this route only for read-only source comparison, regression diagnosis, or bisect at the task's chosen revision. Builds and isolated execution are allowed; source edits and new commits belong in a separate branch worktree. The lifecycle below does not authorize removing pre-existing baselines.

A checkout nested under the main checkout, including `<repo-root>/.fleet/worktrees/<worktree-name>`, also loads the ancestor checkout's `CLAUDE.md` and `.claude/` instructions; the harness walks upward from the working directory and does not stop at the checkout boundary. When the comparison must not inherit them, put `<path>` outside the repository and outside every ancestor that holds those files, then create it with the same recorded `worktree add --detach` command. User and managed-policy instructions still load. Use an outside path only for that isolation.

## Create

1. Identify the repository and main checkout with `git rev-parse --show-toplevel` and `git worktree list --porcelain`. Apply the entrypoint's name/path rules and relevant `CLAUDE.md` instructions. The default absolute `<path>` is `<repo-root>/.fleet/worktrees/<worktree-name>`. Use the outside path from the opening only when the comparison must not inherit ancestor instructions; it need not be one path segment. Reject an existing path (including a dangling symlink) or worktree registration. Before creating directories or a checkout, resolve the canonical repository root and the target's existing ancestors. For the default path, stop if symlink traversal places the target outside that root, and confirm the created checkout's canonical path remains within it. For the outside path, stop unless its canonical path is outside that root and outside every ancestor that holds the instructions being avoided. Do not create a branch.
2. Resolve the task's revision to a commit, quoting it as data. If it is unavailable locally, fetch only the intended ref from the known remote and resolve again; do not guess another revision. Record the full result as `<baseline-sha>` and use that SHA thereafter, even if the ref moves.

```bash
git -C <working-checkout> rev-parse --verify --end-of-options '<revision>^{commit}'
git -C <working-checkout> -c core.logAllRefUpdates=true worktree add --detach <path> <baseline-sha>
```

3. Before installation or execution, record ownership in `<git-dir>/fleet-baseline`, where `<git-dir>` is this new worktree's absolute `git rev-parse --absolute-git-dir` result, not the shared Git common directory. This keeps the record outside the checkout and scoped to its Git registration. Stop on an existing record or any failed command; do not overwrite/adopt a record. `<owner-id>` is the current session's stable ID, established independently of this file. Save the same owner, canonical main/worktree paths, baseline SHA, and successful creation in the session's report. A record alone is not proof of ownership.

```bash
git -C <path> rev-parse --absolute-git-dir
git -C <path> symbolic-ref -q HEAD
git -C <path> rev-parse --verify HEAD
git -C <path> reflog show --format='%H %gs' HEAD
```

The symbolic-ref command must return 1 (detached), HEAD must equal `<baseline-sha>`, and the fresh HEAD reflog must contain only that creation entry. Record these results; other failures or unexpected history stop creation.

```bash
git config --file <git-dir>/fleet-baseline baseline.owner '<owner-id>'
git config --file <git-dir>/fleet-baseline baseline.root '<canonical-repo-root>'
git config --file <git-dir>/fleet-baseline baseline.path '<canonical-path>'
git config --file <git-dir>/fleet-baseline baseline.commit '<baseline-sha>'
```

4. Before installation or comparison, inspect `git -C <path> status --porcelain=v1 --untracked-files=all` and `git -C <path> status --short --ignored`, applying the clean-state and ignored-output rules in Remove below. Checkout hooks can change source without moving HEAD; a dirty checkout is not a ready baseline. Report whether this baseline is to be retained or explicitly disposable under the task's authorization. Do not infer deletion permission just from creating it. If installation/build is needed, run it wholly inside this checkout using the target revision's supported commands and isolated data paths. For Fleet's pnpm baseline, use `pnpm install --frozen-lockfile`; never symlink main-checkout content. Reading source alone needs no install. Repeat these status checks after preparation and before each comparison, including after bisect checkouts. Installation failure or changed source leaves a recorded checkout, not a ready runtime; report it and stop without cleaning it to pass.
5. Keep all baseline execution rooted at its absolute path. Preserve the creation record and HEAD reflog; do not expire/rewrite that reflog or change the baseline SHA in the record to make cleanup pass. During bisect, record visited existing commits in the session evidence and enable reflog recording for each checkout (`git -c core.logAllRefUpdates=true …`). Do not commit, amend, or rebase in this checkout. A checkout is only operationally read-only, not filesystem-enforced.

## Remove

Apply these gates **before any removal command**. If evidence is absent, incomplete, or inconsistent, preserve the checkout and report the blocker; never backfill an ownership record for an old checkout.

1. Re-identify the canonical main/target paths, worktree registration, worktree-specific Git directory, and branch. Stop for the main checkout, a locked/prunable/unavailable worktree, or any attached branch (including protected branches). Stop for a target outside the recorded repository unless the creation record's path is the outside checkout and still matches it. A switched branch does not turn a baseline into the ordinary force-removal route.
2. Read the record with `git config --file <git-dir>/fleet-baseline --get-regexp '^baseline\.'`. Require exactly one value for each recorded field and match all four to this session's independent creation evidence. Another session's ID, unknown provenance, or missing evidence stops cleanup, even if the checkout is clean. Confirm a targeted removal request or its previously authorized disposable scope. Stop only this task's known processes using the baseline; if another process/session may still be using it, stop cleanup instead.
3. Inspect and disclose the working tree and history:

```bash
git -C <path> status --porcelain=v1 --untracked-files=all
git -C <path> status --short --ignored
git -C <path> rev-parse --verify HEAD
git -C <path> reflog show --format='%H %gs' HEAD
git -C <path> rev-list HEAD --not <baseline-sha>
```

   - Any tracked change, staged change, untracked file, or submodule change stops removal, regardless of `<force>`. Do not clean/reset/stash changes to manufacture a passing gate.
   - Ignored files are not proof of a clean disposable checkout. Disclose them and allow only known disposable install/build outputs generated by this task. Unknown ignored files, retained evidence, or local user data block removal until separately resolved under appropriate authority. Retain comparison results outside the checkout before removal.
   - Require a complete HEAD reflog back to the recorded creation entry. Inspect **every** reflog entry and the `rev-list` result, not just current HEAD: a commit/amend/rebase or an unexplained commit ID stops cleanup even if HEAD later returned to the baseline. Other SHAs are allowed only when the session's bisect/comparison evidence proves they were pre-existing revisions, not work created here. Missing/truncated history or ambiguous entries stop cleanup. Any Git inspection error is a blocker, never an empty successful result.
   - If bisect/comparison ended on another proven pre-existing revision, first finish the inspection above. Only when ownership, clean state, complete history, and no new commits are proven may you end bisect and return to the recorded SHA using ordinary non-force checkout. Re-run all gates afterward. Immediately before removal, HEAD must equal the recorded SHA and `rev-list HEAD --not <baseline-sha>` must be empty. Never move HEAD back to hide new work.
4. Recheck registration, ownership, HEAD/history, and clean state immediately before removal. Leave the target for a surviving owned checkout. After the recheck, stop the target's fsmonitor daemon (`not running` or `not supported on this platform` is a pass), then use ordinary removal only:

```bash
git -C <path> fsmonitor--daemon stop
git -C <surviving-checkout> worktree remove <path>
git -C <surviving-checkout> worktree list --porcelain
```

Do not use `--force`, delete branches/remotes, run repository-wide prune, or manually delete the Git directory. Successful removal also removes this worktree's record with its Git directory. Verify the target path, registration, and recorded Git directory are all gone; otherwise report exactly what remains. Ordinary removal rejecting ignored outputs or a submodule is a blocker, not permission to force.

## Report

Include target path, owner, baseline SHA, authorization, preparation/verification outcome, prior changes and ignored outputs, HEAD/reflog evidence, and removal or preservation result. Branches and remotes are unchanged by this route. Preserve the creation/removal evidence in the session even after the Git record is gone.
