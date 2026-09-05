---
name: release-version-update
description: Run a user-requested fleet-harness canary synchronization and Stable Release, or continue watching that release run. Not for ordinary PR merges or editing local version numbers.
---

# Release Version Update

Execute the requested release lifecycle. That request includes direct canary work and a validated fast-forward push from `origin/canary` to `main`. Reading this document or automatic skill selection alone does not authorize deployment.

`.github/workflows/stable-release.yml` owns version calculation, workspace version synchronization, changelogs, release commit/tag, GitHub Release, npm, and app assets. Do not edit local versions/generated changelogs or substitute local tags/npm publishing for CI.

## Inputs and routes

No required inputs. If the user requests synchronization only, stop before deployment. To resume a named run, verify its identity/SHA and enter the watch phase. A version number is not an input; resolve requests conflicting with CI version calculation through the user.

| Phase | Read before execution |
|---|---|
| Canary checkout, fetch/synchronization, release inputs, full local checks | [Prepare](references/prepare.md) |
| Main FF, exact Stable Release run, canary synchronization/report | [Publish and sync](references/publish-and-sync.md) |

## Execution contract

1. Start from the absolute path of the actual `canary` checkout. Preserve user changes and stop on a dirty tree. Never send a topic worktree's HEAD to `main`.
2. Fetch `origin/canary`, `origin/main`, and tags. Fast-forward local canary. If public canary and main diverge, merge main into canary; never rebase/force-push. Preserve release-owned history/version and canary's unconsumed fragments/unique product work.
3. For an empty range, verify the published tag/Release/npm and finish. For docs-only/ignored ranges, confirm with `release-tip-guard` and report that deployment will not trigger. Do not manufacture a release with dummy files or empty commits.
4. For real release inputs, run **full** `pnpm build`, `pnpm typecheck`, `pnpm test`, and fragment `--check --allow-empty` from canary. Full verification is a release gate. Fix failures narrowly on canary, commit/push, then repeat all four checks. Do not waive local verification because CI also runs.
5. Recheck that current canary matches the verified SHA. If canary advanced, synchronize and verify the new tip. Push `origin/canary:main` only when clean, remote-matching, validated, and descended from main.
6. Watch the Stable Release run matching the pushed SHA to completion. On failure, report job/run URL and stop. Failed-job retries are allowed; local tags/publishing or a new empty main commit are not substitutes.
7. Incorporate the successful release commit into canary by FF or a merge preserving concurrent canary work. Never force-push.

## Completion and reporting

Deployment is complete only after run success, required publish jobs, exactly one successful desktop build/carry path, release commit/tag, non-draft GitHub Release, and matching npm version. Verify canary contains that release commit too. Running jobs are not success.

Report canary path, old/new SHAs, shipped range, consumed fragments/fragmentless commits, validation/fix SHAs, trigger gate, main pushed SHA/run URL, version/tag/Release URL/npm/desktop outcome, and final ref relationships. Distinguish synchronization-only, nothing-to-ship, and failure from deployment success. The host synthesizes directly from verified git/CI evidence.
