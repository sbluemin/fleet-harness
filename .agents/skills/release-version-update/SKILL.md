---
name: release-version-update
description: 릴리스 버전을 업데이트하고 changelog fragment를 컴파일하는 절차를 정의합니다.
---

# Release Version Update

Use this prompt when preparing a fleet-harness release version update and release notes from `.changelog.d/*.md` fragments.

## Goal

Update the root `fleet-harness` version and compile the release notes from repository-owned changelog fragments.

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
7. Compile changelog fragments:
   - Require operators to add or verify one or more `.changelog.d/*.md` fragments before release compilation, unless this is an intentional no-changelog release.
   - Keep `CHANGELOG.md` `[Unreleased]` present and empty; do not manually populate it.
   - Validate fragments with `node scripts/compile-changelog-fragments.mjs --check`.
   - Preview release notes with `node scripts/compile-changelog-fragments.mjs --dry-run --version <version> --date <YYYY-MM-DD>`.
   - Write the release section with `node scripts/compile-changelog-fragments.mjs --version <version> --date <YYYY-MM-DD>`, adding `--allow-empty` only for intentional no-changelog releases.
8. Validate:
   - Confirm `package.json` and `pnpm-lock.yaml` report the same version.
   - Run `git diff --check`.
   - Review the final diff for `package.json`, `pnpm-lock.yaml`, `CHANGELOG.md`, and `.changelog.d`.
   - Run tests only if code changed as part of the release work, or if the user explicitly requests test execution.
9. Report the result in Korean:
   - Current branch.
   - Target version.
   - Files changed.
   - Validation performed.
   - Whether tests were run or intentionally skipped.

## Host Synthesis

Release notes and changelog compilation are host-owned. Synthesize release items directly from the branch diff, commit history, and validated `.changelog.d/` fragments — never delegate release-note synthesis to a Carrier.

Scale the synthesis to the evidence: small changes may need only the validated fragments and a concise diff/commit review, while broad releases require a correspondingly wider host audit.

## Safety Rules

- Do not invent release items that are not supported by the diff or commit history.
- Do not rewrite unrelated changelog history.
- Do not create a git tag unless the user explicitly asks.
- Do not commit unless the user explicitly asks.
- Preserve Conventional Commit expectations if a commit is requested later, and write commit messages in English.
