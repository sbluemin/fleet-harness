---
name: sync-agents-symlinks
description: AGENTS.md 파일이 있는 모든 디렉토리에 CLAUDE.md 심볼릭 링크를 생성하는 절차를 정의합니다.
---

# Sync AGENTS.md Symlinks

Use this prompt to ensure every directory that contains an `AGENTS.md` file also has a `CLAUDE.md` symlink pointing to it. This keeps Claude Code and pi-coding-agent reading the same doctrinal file without duplication.

## Inputs

- `<commit>` — Optional. Set to `yes` to stage and commit the newly created symlinks after creation. If omitted, defaults to `no` (create symlinks but do not commit).
- `<commit_scope>` — Optional Conventional Commit scope (e.g., `docs`, `chore`). Defaults to no scope if omitted.

## Goal

Find every `AGENTS.md` in the repository. For each one, ensure a `CLAUDE.md` symlink exists in the same directory pointing to `AGENTS.md`. Skip directories where the symlink already exists and is correct. Optionally commit only the newly created symlinks.

## Required Workflow

1. Confirm the working directory is the repository root:
   - `pwd`

2. Discover all `AGENTS.md` files:
   - Use a glob or `find` search to locate every `AGENTS.md` recursively from the repo root.
   - Record the absolute path and the containing directory for each match.

3. For each discovered directory, check the `CLAUDE.md` status:
   - If `CLAUDE.md` does not exist → create a symlink: `ln -s AGENTS.md <dir>/CLAUDE.md`.
   - If `CLAUDE.md` exists and is a symlink pointing to `AGENTS.md` → skip (already correct, note it).
   - If `CLAUDE.md` exists but is a regular file or points to something other than `AGENTS.md` → **stop and report to the user** without modifying it.

4. Report the outcome:
   - List every directory and its status: **created**, **already correct**, or **conflict — requires manual resolution**.
   - Summarize counts (created / skipped / conflicts).

5. If `<commit>` is `yes`:
   - Stage only the newly created symlink files: `git add <file> [<file> ...]`. Do not use `git add -A` or `git add .`.
   - Write an English Conventional Commit message. Use `chore` type unless `<commit_scope>` suggests otherwise.
     - Subject: `chore: add CLAUDE.md symlinks for missing AGENTS.md directories`
     - Body: list the directories where symlinks were created, one per line.
   - Use a HEREDOC to pass the commit message:
     ```
     git commit -m "$(cat <<'EOF'
     chore: add CLAUDE.md symlinks for missing AGENTS.md directories

     - <dir1>
     - <dir2>
     EOF
     )"
     ```
   - Do NOT use `--amend`, `--no-verify`, or any hook bypass.

6. Report the result in Korean:
   - Total `AGENTS.md` files found.
   - Symlinks created (path list).
   - Symlinks already correct (path list).
   - Conflicts requiring manual resolution (path list, reason).
   - Commit SHA if a commit was made; otherwise state that no commit was made.

## Safety Rules

- Do not overwrite or delete a `CLAUDE.md` that is a regular file or points to a target other than `AGENTS.md`. Report it as a conflict instead.
- Do not modify any `AGENTS.md` file.
- Do not stage files other than the newly created symlinks.
- Do not create a symlink if the `AGENTS.md` file in that directory does not exist (i.e., do not create dangling symlinks).
- Do not commit unless `<commit>` is explicitly `yes`.
- Write commit messages in English only.
