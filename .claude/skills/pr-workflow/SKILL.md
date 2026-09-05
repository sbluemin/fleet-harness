---
name: pr-workflow
description: Deliver a fleet-harness change through commit, PR publication, Codex review adjudication, and merge, or resume an existing PR review loop. Do not start publication for local-only edits or a standalone code review.
---

# PR Workflow

Deliver an authorized change as a PR on `sbluemin/fleet-harness`. Start new changes at commit/publication, open PRs at review, and review-complete PRs at final audit. Do not repeat completed phases ceremonially.

## Scope and authority

Run when the user requests this PR lifecycle or explicitly authorizes publication/merge. Automatic skill loading does not authorize commit, push, PR creation, or merge. Do not ask again between ordinary steps within an authorized full lifecycle.

Defaults: base `canary`, merge `squash`, `auto_merge=true`. A `main`/`master` base requires explicit override; reject head=base. With `auto_merge=false`, stop at review completion and preserve branch/worktree. Read [Inputs](references/inputs.md) when options need resolving.

## Phase-specific loading

| Current task | Read before starting |
|---|---|
| New commit, push, PR creation, changelog classification | [Publishing](references/publishing.md) |
| Review start/resume, feedback application, final audit | [Judgment](references/judgment.md) |
| Codex activation and signal wait | [Review wait](references/review-wait.md) |
| Final audit, base integration, merge, cleanup | [Merge and cleanup](references/merge-and-cleanup.md) |

## Core contracts

- Confirm head worktree/branch/PR identity and stage only relevant files. Use English Conventional Commits without amend or hook bypass. Run checks for affected workspaces and disclose unavailable/unrun scripts.
- Write changelogs only for feature-level product changes. `.changelog.d/CLAUDE.md` owns the authoring contract. A new branch fragment and amendment of an existing unreleased fragment are mutually exclusive. Do not add unnecessary fragments or no-changelog declarations for docs/prompts.
- Before the first review fix, freeze the **Product Context Record** and pushed `REVIEW_BASE_HEAD`: request, acceptance criteria, exclusions, trade-offs, supported behavior, decision evidence. If these cannot be reconstructed on resume, stop edits/merge.
- Review is a hypothesis, not authority. **FIX** requires a reproduced supported path, original scope alignment, preserved supported functionality, and proportional value. Do not make unreproduced defensive fixes. Post evidence-backed **DECLINE / DEFER** dispositions too; ask only when product intent is genuinely unresolved.
- After every pass and before merge, audit the cumulative review-fix diff against frozen context. Revert only review-induced drift while preserving later user-directed changes. The reviewer cannot expand product scope.

## Waiting and termination

For initial Codex silence, explicitly request activation and check for a default 60 seconds. Continued silence becomes `codex_activation_timeout` and may proceed through normal merge gates, but is not approval and never bypasses required checks.

Use signal-driven background waiting. Do not treat stale `+1`, `eyes`, or re-anchored inline comments as fresh approval/feedback. End the review loop on a pass with no FIX findings, with a default maximum of 3 passes. Continuing requires a named reproduced defect. Disclose timeouts, omissions, and failures.

## Merge and delivery

Record `FINAL_AUDIT_BASE`; check base advancement and PR-file overlap again immediately before merging. Conflicts or overlapping advancement require head integration through `rebase-on-canary`, validation, and **head-only** `--force-with-lease`, then repeated audit/remote checks. Do not rewrite history in the ordinary path.

Merge only through `gh pr merge`. Never use `--admin`, protected-branch direct pushes, or required-check bypasses. Confirm actual `MERGED` state before cleaning the owned head worktree through `git-worktree`. Preserve draft/blocked/unmerged work.

Report PR URL/head/base, frozen SHAs/final audit, FIX/DECLINE/DEFER, commits/push targets, validation, review termination basis, merge SHA or unmerged reason, stopped waits, and cleanup. The host owns title/body/changelog/final-report synthesis.
