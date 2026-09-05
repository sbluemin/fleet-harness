# Commit and PR publication

## Changelog Fragment (autonomous)

Decide autonomously whether the change is a product-visible feature-level delta a user would notice in a shipped runtime. The PR template does not force a changelog checklist, and CI does not require a `no-changelog` declaration when you omit a fragment. See `.changelog.d/CLAUDE.md` for the inclusion criterion and authoring contract.

When a fragment is warranted, use one of two mutually exclusive paths. A new feature-level change adds exactly one fragment named after its own branch. A correction to behavior whose fragment is still unreleased in `.changelog.d/` rewrites that existing fragment instead, applies the `changelog-amend` label, and adds one exact `Changelog-Amend: <file-name>.md` line to the PR body per rewritten fragment; it adds no branch fragment. Inspect pending fragments and the public release baseline before choosing the path. The branch already exists when the work starts, so a new fragment is staged and committed **together with the change it describes** — there is no second commit and nothing to wait for. Read a new fragment's filename from `node scripts/compile-changelog-fragments.mjs --name-for-branch`; never derive it by hand.

Only when authoring, read `.changelog.d/CLAUDE.md` for the current filename, frontmatter, bilingual syntax, and runtime/section contract. Do not duplicate that syntax here. Validate with `node scripts/compile-changelog-fragments.mjs --check`; never use `canary.md` for a PR.

When the change is not a feature-level product delta — refactors, boundary gates, doctrine and prompt edits, test repairs, release tooling, and similar — write no fragment and do not invent a `no-changelog` ceremony.

### Phase 0 — Environment & doctrine (always first)

1. Confirm the absolute worktree path/current branch, acting account through `gh auth status`, and `sbluemin/fleet-harness` through `gh repo view --json nameWithOwner`. Query OS/shell only when needed for command selection.
2. Read applicable root/child `CLAUDE.md` instructions not already loaded. Do not preload unrelated documents.
3. Decide autonomously whether a feature-level changelog fragment is warranted. If yes, classify it as a new release note or an amendment to an existing unreleased note, and record which runtimes a user notices it in. Inspect `.changelog.d/` and the public release baseline: a correction to still-unreleased behavior amends its pending fragment rather than adding a standalone `Fixed` or `Changed` entry. If no, omit the fragment with no declaration.

### Phase 1 — Commit

1. Inspect: `git status --short --branch`; `git branch --show-current`.
2. When warranted, write the branch-named fragment now. For a correction to still-unreleased behavior, rewrite the existing pending fragment instead and record its filename for the Phase 2 `changelog-amend` declaration. Author either path per `.changelog.d/CLAUDE.md` and validate the set with `node scripts/compile-changelog-fragments.mjs --check`. Otherwise write no fragment.
3. Stage only the files belonging to this change, including any new or amended fragment: `git add <file> [<file> ...]`. Do not use `git add -A` / `git add .` unless every pending change belongs to this commit.
4. Write the commit message in English using Conventional Commits (allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`). Subject `<commit_subject>` or inferred; body `<commit_body>` or addressed-change bullets.
5. Pre-commit self-check: re-read `git diff --cached` once and confirm the subject/body match what is staged — nothing more, nothing less.
6. Commit via HEREDOC. Do NOT use `--amend`, `--no-verify`, `--no-gpg-sign`, or any hook bypass. If a pre-commit hook fails, fix the cause and create a new commit (never amend).

### Phase 2 — Open the PR

1. Resolve `<head>` (default current branch) and `<base>` (default `canary`; reject `main`/`master` unless overridden). If `<head>` equals `<base>`, stop and ask.
2. `git push -u origin <head>` and verify `git status --short --branch` reports up-to-date with the remote.
3. Build PR metadata: derive `<title>` (≤ 70 chars, Conventional Commits) and `<body>` (`## Summary` 1–3 bullets + `## Test Plan` checklist) if not provided. Do not add a Changelog checklist to the PR body.
   - When a new release note was committed, the fragment itself is the record; no PR-body ceremony is required.
   - For an amendment, apply the `changelog-amend` label after creating the PR and add one `Changelog-Amend: <file-name>.md` line per amended fragment to the body; do not add a branch fragment.
   - When no fragment was warranted, leave the PR body without changelog declarations.
4. Show the final title/body/base/head/draft. Create without another confirmation when the user requested this PR lifecycle or authorized publication. Automatic skill invocation or file reading alone grants no publishing authority. Ask when authority is missing, metadata is genuinely ambiguous, or a safety guard trips. Declare shell variables within the same call that uses them.
   ```bash
   gh pr create --repo sbluemin/fleet-harness --base "$base" --head "$head" \
     --title "$title" --body "$(cat <<'EOF'
   ## Summary
   ...
   ## Test Plan
   ...
   EOF
   )" $( [ "$draft" = "true" ] && echo "--draft" )
   ```
5. Record the PR identity for the rest of the workflow: `<pr_number>` (number), `<repo>`, the PR URL, and `<headRefName>` (= `<head>`, the only branch Phases 4–6 push to). These are the target for Phases 3–7.
