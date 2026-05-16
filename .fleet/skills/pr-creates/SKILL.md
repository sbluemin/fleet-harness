---
name: pr-creates
description: Admiral GitHub App을 통해 PR을 생성하는 워크플로 절차를 정의합니다.
---

# PR Creates (as Admiral)

Use this skill to publish a pull request on `sbluemin/fleet-harness` as the **Admiral GitHub App**, so the PR author shows as `Fleet Admiral[bot]` (or whatever slug the App was registered with). The skill itself only triggers the `Admiral · Create PR` workflow — the GitHub App private key never touches the local machine.

## Inputs

Replace each `<placeholder>` before running. Optional inputs may be left blank — defaults will be inferred.

- `<title>` — Conventional Commits PR title (≤ 70 chars). Optional. If omitted, derive from the dominant change in `git log <base>..HEAD`.
- `<body>` — Markdown PR body. Optional. If omitted, auto-build a Summary + Test plan from the diff, following `.github/PULL_REQUEST_TEMPLATE.md` style.
- `<base>` — Base branch. Optional. Default `canary`. `main` / `master` are rejected (the workflow also enforces this).
- `<head>` — Head branch. Optional. Default = current branch.
- `<draft>` — `true` | `false`. Optional. Default `false`.

## Goal

Publish a PR whose **author is the Admiral GitHub App bot**, without exposing the App's private key locally. Local commits remain authored by the user (this is intentional and expected).

## Prerequisites (one-time, by the Admiral of the Navy)

1. Register a GitHub App on `sbluemin/fleet-harness` using the permissions in `.github/admiral-app/manifest.json` (no webhook for now).
2. Install the App on `sbluemin/fleet-harness`.
3. Add the following repository secrets:
   - `ADMIRAL_APP_ID` — numeric App ID
   - `ADMIRAL_PRIVATE_KEY` — full PEM content of the generated private key
4. Confirm `gh auth status` is logged in as a user with `repo` + `workflow` scope on `sbluemin/fleet-harness`.

If any of these are missing, stop at step 4 below and report the missing piece — do not attempt to mint tokens locally.

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

4. **Secrets verification**:
   - `gh secret list --repo sbluemin/fleet-harness` and confirm both `ADMIRAL_APP_ID` and `ADMIRAL_PRIVATE_KEY` are present.
   - If either is missing, stop and report the exact missing secret name. Do not proceed.

5. **Resolve head and base**:
   - `<head>` defaults to `git branch --show-current`.
   - `<base>` defaults to `canary`. Reject `main` / `master` unless the user explicitly overrides.
   - If `<head>` equals `<base>`, stop and ask.

6. **Push head branch** to origin (user's PAT — local commit authorship is preserved):
   - `git push -u origin <head>`
   - Verify `git status --short --branch` reports up-to-date with the remote.

7. **Build PR metadata**:
   - If `<title>` is empty:
     - Read `git log <base>..HEAD --oneline` and derive a single Conventional Commits subject covering the dominant change.
     - Keep ≤ 70 chars.
   - If `<body>` is empty:
     - Auto-build from `.github/PULL_REQUEST_TEMPLATE.md` skeleton:
       - `## Summary` — 1–3 bullets describing the user-/operator-visible change.
       - `## Test Plan` — bulleted Markdown checklist of validation steps (the actual commands run, or the ones a reviewer should run).
     - Korean prose is fine for body content; PR title remains in English Conventional Commits.

8. **Confirm with the Admiral of the Navy** — Print the final title, body, base, head, and draft flag. Ask for go/no-go unless the Admiral of the Navy explicitly pre-authorized.

9. **Dispatch the Admiral workflow**:
   - `gh workflow run admiral-create-pr.yml --repo sbluemin/fleet-harness -f title="$title" -f body="$body" -f base="$base" -f head="$head" -f draft="$draft"`
   - The body is multi-line; pass it via `--field body=@<tempfile>` if `-f` truncates, OR pipe through stdin: `gh workflow run admiral-create-pr.yml ... --field body="$body"`. Always prefer `--field` over `-f` for fields that may contain commas.

10. **Locate the dispatched run**:
    - `gh run list --workflow=admiral-create-pr.yml --branch <head> --limit 1 --json databaseId,status,conclusion,url`
    - If the list is empty, wait up to 10s and retry once. Then stop and report.

11. **Wait for completion** (cap at 180s):
    - `gh run watch <databaseId> --repo sbluemin/fleet-harness --exit-status`
    - If `conclusion` is not `success`, fetch logs: `gh run view <databaseId> --log-failed --repo sbluemin/fleet-harness` — report the failing step and stop.

12. **Verify Admiral authorship**:
    - `gh pr list --repo sbluemin/fleet-harness --head <head> --state open --json number,url,title,author --limit 1`
    - Confirm `author.login` ends with `[bot]` and matches the registered Admiral App slug. If author is the user account, something is wrong — report and stop.

13. **Report in Korean**:
    - PR URL, number, title, base/head, draft flag.
    - `author.login` (must be `<admiral-slug>[bot]`).
    - Workflow run URL.
    - Any notes about validation that was *not* run.

## Safety Rules

- Do not push to `main` / `master`.
- Do not bypass Git hooks (`--no-verify`, `--no-gpg-sign`, etc.).
- Do not commit secrets or `.env` files.
- Do not amend commits or force-push.
- Do not attempt to mint App tokens locally — always go through the workflow.
- Do not create PRs against repositories other than `sbluemin/fleet-harness` with this skill.
- Korean for new code comments and report prose; English for commit messages per repo doctrine.
- If `gh workflow run` fails because the workflow file is not on the default branch yet (newly added), report the cause and ask the Admiral of the Navy to merge `.github/workflows/admiral-create-pr.yml` to the default branch first.

## Carrier Delegation

Skip — this skill is a thin orchestration around `gh` calls. No carrier dispatch needed.
