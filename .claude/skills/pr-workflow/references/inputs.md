# PR inputs and defaults

## Inputs

Replace each `<placeholder>` before running. Optional inputs may be left blank — defaults will be inferred.

- `<commit_subject>` — Conventional Commits subject for the initial commit. Optional. If omitted, derive from the dominant change in the staged/working diff.
- `<commit_body>` — Optional commit body. If omitted, summarize the change as bullets.
- `<title>` — Conventional Commits PR title (≤ 70 chars). Optional. If omitted, derive from `git log <base>..HEAD`.
- `<body>` — Markdown PR body. Optional. If omitted, auto-build a Summary + Test Plan from the diff, following `.github/PULL_REQUEST_TEMPLATE.md` style (Korean prose is fine; the PR title stays English Conventional Commits).
- `<base>` — Base branch. Optional. Default `canary`. `main` / `master` are rejected unless explicitly overridden.
- `<head>` — Head branch. Optional. Default = current branch. Must not equal `<base>`.
- `<draft>` — `true` | `false`. Optional. Default `false`.
- `<scope_hint>` — Optional. Free-form note restricting review-fix scope (e.g., "only Codex P1/P2"). If omitted, default to "every actionable, unresolved review comment on the PR".
- `<review_poll_interval>` — Optional. Poll cadence for the Phase 3 background wait loop (e.g., `30s`). If omitted, default ~`30s` for the background poll (or `1m` for the cron fallback).
- `<review_activation_timeout>` — Optional. Bounded wait after an explicit `@codex` review request for Codex to acknowledge it. Default `60s`. If no Codex reaction, review, or comment appears, treat automated review as unavailable and proceed to merge.
- `<repo>` — `owner/name` slug. Optional. If omitted, infer from `gh repo view --json nameWithOwner` (must be `sbluemin/fleet-harness`).
- `<merge_method>` — `squash` | `merge` | `rebase`. Optional. Default `squash` (the repo convention — squash-merge titles read `type(scope): summary (#N)`). Used by Phase 6 auto-merge.
- `<auto_merge>` — `true` | `false`. Optional. Default `true`. When `true`, Phase 6 merges the PR after approval (rebasing the head onto `<base>` and force-pushing first when it conflicts or a post-audit base advance overlaps the PR files). When `false`, stop at approval and report the PR as approved-but-unmerged (the legacy behavior).
- `<pr_number>` — Target PR number. When entering at Phase 1 it is produced by Phase 2 (PR creation). When **resuming** at Phase 3/4/5/6 for an already-open PR it is **required** — if absent, resolve it from the current branch via `gh pr view --json number,headRefName` before polling. `<headRefName>` (the PR head branch) is recorded alongside it and is the only branch Phases 4–6 push to.
