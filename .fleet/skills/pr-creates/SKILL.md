---
name: pr-creates
description: gh CLI를 통해 사용자 계정으로 PR을 생성하는 절차를 정의합니다.
---

# PR Creates

Use this skill to publish a pull request on `sbluemin/fleet-harness` using `gh pr create`. The PR author is the authenticated user account.

## Inputs

Replace each `<placeholder>` before running. Optional inputs may be left blank — defaults will be inferred.

- `<title>` — Conventional Commits PR title (≤ 70 chars). Optional. If omitted, derive from the dominant change in `git log <base>..HEAD`.
- `<body>` — Markdown PR body. Optional. If omitted, auto-build a Summary + Test plan from the diff, following `.github/PULL_REQUEST_TEMPLATE.md` style.
- `<base>` — Base branch. Optional. Default `canary`. `main` / `master` are rejected.
- `<head>` — Head branch. Optional. Default = current branch.
- `<draft>` — `true` | `false`. Optional. Default `false`.

## Goal

Publish a PR authored by the authenticated user's GitHub account via `gh pr create`.

## Required Workflow

1. **Environment check** — Run in parallel via the `Bash` tool:
   - `pwd`
   - `uname -a` (OS info) and `echo "SHELL=$SHELL"`
   - `gh auth status`
   - `gh repo view --json nameWithOwner` (must equal `sbluemin/fleet-harness`)

2. **AGENTS.md check** — Read the repository root `AGENTS.md`. For any subdirectory the PR touches, read its `AGENTS.md` too. Child rules override parent rules within their scope.

3. **Working tree inspection**:
   - `git status --short --branch`
   - `git branch --show-current`
   - Confirm the working tree is clean. If not, stop and ask the Admiral of the Navy how to handle pre-existing changes.

4. **Resolve head and base**:
   - `<head>` defaults to `git branch --show-current`.
   - `<base>` defaults to `canary`. Reject `main` / `master` unless the user explicitly overrides.
   - If `<head>` equals `<base>`, stop and ask.

5. **Push head branch** to origin:
   - `git push -u origin <head>`
   - Verify `git status --short --branch` reports up-to-date with the remote.

6. **Build PR metadata**:
   - If `<title>` is empty:
     - Read `git log <base>..HEAD --oneline` and derive a single Conventional Commits subject covering the dominant change.
     - Keep ≤ 70 chars.
   - If `<body>` is empty:
     - Auto-build from `.github/PULL_REQUEST_TEMPLATE.md` skeleton:
       - `## Summary` — 1–3 bullets describing the user-/operator-visible change.
       - `## Test Plan` — bulleted Markdown checklist of validation steps.
     - Korean prose is fine for body content; PR title remains in English Conventional Commits.

7. **Confirm with the Admiral of the Navy** — Print the final title, body, base, head, and draft flag. Ask for go/no-go unless the Admiral of the Navy explicitly pre-authorized.

8. **Create PR**:
   ```bash
   gh pr create \
     --repo sbluemin/fleet-harness \
     --base "$base" \
     --head "$head" \
     --title "$title" \
     --body "$body" \
     $( [ "$draft" = "true" ] && echo "--draft" )
   ```
   Use a HEREDOC for `--body` if the body is multi-line:
   ```bash
   gh pr create \
     --repo sbluemin/fleet-harness \
     --base "$base" \
     --head "$head" \
     --title "$title" \
     --body "$(cat <<'EOF'
   ## Summary
   ...

   ## Test Plan
   ...
   EOF
   )" $( [ "$draft" = "true" ] && echo "--draft" )
   ```

9. **Report in Korean**:
   - PR URL, number, title, base/head, draft flag.
   - Any notes about validation that was *not* run.

## Safety Rules

- Do not push to `main` / `master`.
- Do not bypass Git hooks (`--no-verify`, `--no-gpg-sign`, etc.).
- Do not commit secrets or `.env` files.
- Do not amend commits or force-push.
- Do not create PRs against repositories other than `sbluemin/fleet-harness` with this skill.
- Korean for new code comments and report prose; English for commit messages per repo doctrine.

## Carrier Delegation

Skip — this skill is a thin orchestration around `gh` calls. No carrier dispatch needed.
