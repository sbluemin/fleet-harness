# Stable Release execution and ref synchronization

### Phase 5 — Fast-forward main (this is the release)

Do not enter this phase for a synchronization-only request. Run commands from `<canary-path>`. Record the successfully verified Phase 4 SHA as `VERIFIED_CANARY_HEAD`.

1. `git fetch origin canary main`.
2. Confirm `git merge-base --is-ancestor origin/main origin/canary`.
3. Confirm canary is clean, matches `origin/canary`, and has the exact `VERIFIED_CANARY_HEAD` SHA. If the remote advanced, return to Phase 2 to synchronize and verify the new tip; never include unverified commits in the release.
4. `git push origin origin/canary:main`.

That push must be a fast-forward. If GitHub rejects it, stop. Never `--force`, never `--force-with-lease` to `main`, never merge on `main`, never push a topic SHA.

Stable Release starts only when the pusher is not `github-actions[bot]` and the changed paths are not all ignored. The first job commit message is the canary tip subject, not `chore(release):`.

### Phase 6 — Watch Stable Release to completion

1. Resolve the run whose `headSha` is the SHA just pushed to `main`:

   ```
   gh run list --repo sbluemin/fleet-harness --branch main --workflow "Stable Release" \
     --json databaseId,headSha,status,conclusion,url,displayTitle --limit 10
   ```

2. Watch that run until it reaches a terminal conclusion (`gh run watch <id> --exit-status`, or poll). Typical wall-clock is several minutes (verify + npm). Do not declare success from a still-running `release` job.

3. Success means all of:

   - Run `conclusion: success`.
   - `resolve`, `verify / verify`, `release`, `console / publish`, and `publish-release` succeeded.
   - Exactly one of `desktop-build` or `desktop-carry` succeeded (the other is skipped).
   - `git fetch origin main --tags` shows `origin/main` as `chore(release): vX.Y.Z`.
   - `gh release view vX.Y.Z --json isDraft,publishedAt,tagName,url` is not a draft.
   - `npm view @dotobokuri/fleet-console version` equals `X.Y.Z`.

4. On failure: stop. Report the run URL and the failed job. Do not locally craft a `chore(release):` commit, tag, or npm publish to "finish" it. Re-running the failed GitHub jobs is allowed; pushing a new empty commit to `main` is not, unless the user explicitly directs a recovery.

### Phase 7 — Fast-forward canary to the release commit

Stable Release does **not** move `canary`. After Phase 6 success:

```
git fetch origin main canary --tags
```

Then:

- If `origin/canary` is still an ancestor of `origin/main` (no concurrent canary landings): `git -C <canary-path> merge --ff-only origin/main`, then `git -C <canary-path> push origin HEAD:canary`.
- If `origin/canary` advanced while CI ran (`git rev-list --left-right --count origin/main...origin/canary` shows both sides ahead): first `git -C <canary-path> merge --ff-only origin/canary` so the checkout matches the advanced tip, then `git -C <canary-path> merge --no-edit origin/main` with the same changelog/version conflict rule as Phase 2, then `git -C <canary-path> push origin HEAD:canary`. Do not force-push. Stop if that merge is still diverged after the push.

If local `main` exists and is not checked out in another worktree, fast-forward that ref too (`git fetch origin main:main`). Confirm `origin/main` is the `vX.Y.Z` release commit and that `origin/canary` contains it. When no concurrent work landed, `canary` = `origin/canary` = `origin/main` = `vX.Y.Z`. When concurrent work landed, report that canary contains the release commit and is ahead of `origin/main`.

### Phase 8 — Report in Korean

- Canary checkout path and that HEAD was `canary`.
- synchronization: old canary SHA → SHA after fetch/FF/merge, and whether `origin/main` had to be merged in.
- Commits shipped (`origin/main` before the push → canary tip pushed).
- Pending fragments consumed vs commits with no fragment.
- Local `pnpm build` / `typecheck` / `test` / fragment `--check` pass or fail; any canary fix commit SHAs.
- Whether `release-tip-guard` reported release-affecting or ignorable.
- Main push SHA and the Stable Release run URL.
- Published version, tag, GitHub Release URL, npm version, desktop built vs carried.
- Final refs: equality of `canary` / `origin/canary` / `origin/main` / the version tag, or that canary contains the release commit and is ahead, or that synchronization found nothing to ship.
