---
name: release-version-update
description: 릴리스 버전을 업데이트하고 CHANGELOG.md를 정리하는 절차를 정의합니다.
---

# Release Version Update

Use this prompt when preparing a fleet-harness release version update and release notes.

## Goal

Update the root `fleet-harness` version and document the changes since `main` in `CHANGELOG.md`.

## Required Workflow

1. Confirm the current environment before running repository commands:
   - `pwd`
   - OS information
   - shell type
2. Read the applicable `AGENTS.md` files before planning or editing:
   - Always read the repository root `AGENTS.md`.
   - If touching a subdirectory, check whether that subdirectory has its own `AGENTS.md`.
3. Inspect the current branch and working tree:
   - `git status --short --branch`
   - `git branch --show-current`
   - Verify the local `main` ref exists before comparing against it.
4. Compare the current branch with `main`:
   - Use `git log --oneline --decorate --no-merges main..HEAD`.
   - Use `git diff --stat main...HEAD`.
   - Use `git diff --name-status main...HEAD`.
   - Summarize the release-impacting changes before editing.
5. Decide the target version:
   - Prefer an explicit user-provided version if one exists.
   - If the branch name clearly encodes the release version, such as `release/v0-1-2`, infer `0.1.2` and state that inference.
   - If the target version is ambiguous, ask before editing.
6. Update version metadata:
   - Update root `package.json`.
   - Update matching root entries in `pnpm-lock.yaml` (the `importers."."` block).
   - Prefer `pnpm version <version> --no-git-tag-version` so the package metadata stays consistent without creating a tag.
7. Update `CHANGELOG.md`:
   - Keep `[Unreleased]` present and empty.
   - Add `## [<version>] - YYYY-MM-DD` below `[Unreleased]`.
   - Write all changelog prose in English.
   - Follow Keep a Changelog sections: `Added`, `Changed`, `Fixed`, `Removed`, and `Breaking Changes` only when applicable.
   - Base entries on the actual `main..HEAD` commits and diff, not speculation.
   - Keep entries concise and user-facing, while naming important modules or files when useful.
8. Validate:
   - Confirm `package.json` and `pnpm-lock.yaml` report the same version.
   - Run `git diff --check`.
   - Review the final diff for `package.json`, `pnpm-lock.yaml`, and `CHANGELOG.md`.
   - Run tests only if code changed as part of the release work, or if the user explicitly requests test execution.
9. Report the result in Korean:
   - Current branch.
   - Target version.
   - Files changed.
   - Validation performed.
   - Whether tests were run or intentionally skipped.

## Chronicle Delegation Guidance

Chronicle is useful when release notes need independent synthesis. Delegate to Chronicle when one or more of these are true:

- The branch contains many commits across multiple domains.
- The diff includes behavior changes that are hard to classify.
- Release-note tone, audience, or wording needs separate review.
- The changelog must summarize work from multiple agents or external reports.

Direct handling is acceptable when the changes are small, the commit messages and diff stat are clear, and the changelog can be derived confidently from local Git evidence.

## Safety Rules

- Do not invent release items that are not supported by the diff or commit history.
- Do not rewrite unrelated changelog history.
- Do not create a git tag unless the user explicitly asks.
- Do not commit unless the user explicitly asks.
- Preserve Conventional Commit expectations if a commit is requested later, and write commit messages in English.
