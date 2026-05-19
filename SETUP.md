# Setup

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and authenticated

## 0. Install pnpm

```bash
# pnpm is the package manager for this repository.
npm install -g pnpm
```

> The canonical `fleet` CLI lives in this repository under `packages/fleet-agent` and is linked globally from the workspace in Step 2.

> The repository is pinned to a specific pnpm version via the `packageManager` field in `package.json`. If you have [Corepack](https://nodejs.org/api/corepack.html) enabled, run `corepack enable` once and Corepack will select that version automatically. Otherwise the globally installed pnpm is used as a fallback.

## 1. Clone the repository

Before cloning, ask the user whether it is okay to clone the repository under the current working directory. If not, ask for the desired parent directory and clone it there instead.

> The example below assumes the current directory has been approved by the user.

```bash
git clone https://github.com/sbluemin/fleet-harness.git
cd fleet-harness
```

## 2. Install dependencies and register global commands

```bash
# One-time per machine: configure the pnpm global bin directory and add it to PATH.
# Skip if `pnpm setup` was already run on this machine (PNPM_HOME is set).
pnpm setup

# After `pnpm setup`, open a new terminal so PNPM_HOME and PATH take effect, then cd back.
# (In the same terminal you can also `export PNPM_HOME="$LOCALAPPDATA/pnpm"` on Windows
# or `export PNPM_HOME="$HOME/Library/pnpm"` on macOS / `"$HOME/.local/share/pnpm"` on Linux,
# and `export PATH="$PNPM_HOME:$PATH"` to use it without restarting the shell.)

# Install all workspace dependencies. The root postinstall hook runs `pnpm -r build`,
# which builds the engine `unified-agent` package plus `fleet-core`, `fleet-wiki`,
# `fleet-wiki-web`, and `fleet-agent` in topological order.
pnpm install

# Approve native build scripts (one-time per machine).
# Required for node-pty, esbuild, koffi, protobufjs, and @google/genai.
# The result is saved to pnpm-workspace.yaml `allowBuilds` — subsequent installs
# run these scripts automatically without a warning.
pnpm approve-builds --all

# Register the Fleet wrapper commands globally.
pnpm link --global

# Register the Fleet unified-agent CLI used by provider diagnostics.
pnpm --filter @sbluemin/fleet-unified-agent link --global
```

> The repository uses pnpm workspaces (see `pnpm-workspace.yaml`); the root install is the single setup entry point. `pnpm install` writes a single `pnpm-lock.yaml` at the repo root and links each workspace package's local dependencies via symlinks. Cross-package deps are declared with the `workspace:*` protocol so pnpm orders builds topologically.
>
> `pnpm link --global` registers the global commands from this checkout:
>
- `fleet` — primary CLI host (via `packages/fleet-agent/fleetd`). Supports multi-carrier orchestration and Fleet Wiki integration. Grand Fleet mode is activated by setting `FLEET_GRAND_FLEET_ROLE=admiralty` before running `fleet` (no dedicated launcher needed). Source-level dev mode: `pnpm dev` (see below).
- `pnpm dev` — (Defined in `package.json`) sets `FLEET_DEV=1` then launches the agent. Use for development with live source changes.

> - `fleet-wiki` — launches the Fleet Wiki web UI for the current working directory's `.fleet/knowledge/` store. Spawns a detached local HTTP server bound to `127.0.0.1` (a per-user lock under `$TMPDIR/fleet-wiki-<uid>/` ensures a single server per workspace) and opens the system browser. Re-running the command while the server is alive only re-opens the browser. Independent of any external runtime.
>
> > `pnpm --filter @sbluemin/fleet-unified-agent link --global` registers `ait`, the local unified-agent CLI. Fleet uses the same workspace package internally, so linking it from the checkout keeps diagnostics and provider behavior aligned with the source tree.
>
> Fleet infrastructure, carriers, and Agent Panel modules now live under `packages/`; they do not require separate `pnpm install` commands.
>
> Fleet engine note:
> - `engines/` contains the core `unified-agent` engine package branded as `@sbluemin/fleet-unified-agent`.
> - All intra-repo links use `workspace:*`; do not replace them with published npm references.
> - The engine `unified-agent` package is developed in-tree alongside the other Fleet packages and is linked globally as `ait` from this workspace.

### Install troubleshooting

- If `pnpm install` reports blocked native build scripts, run `pnpm approve-builds --all`, then run `pnpm install` again.
- If a non-interactive shell reports `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, rerun with `CI=true pnpm install`.
- If CI reports `ERR_PNPM_OUTDATED_LOCKFILE`, the lockfile does not match a package manifest. Run `pnpm install --no-frozen-lockfile` locally, commit the updated `pnpm-lock.yaml`, then rerun CI.
- If `pnpm build` cannot resolve a workspace package, confirm the consuming package lists it in `dependencies` with `workspace:*` and rerun `pnpm install`.

## 3. Verify

Run the build and CLI checks from the repository root:

```bash
pnpm build
fleet --help
ait --help
ait --list-models

# Confirm the Fleet Wiki CLI is on PATH (registered by `pnpm link --global`)
which fleet-wiki
```

Then launch `fleet` and run `/reload`, then check:

- No extension load errors in the output
- `Alt+H` / `Alt+L` to move cursor between carrier slots
- `Ctrl+Enter` to activate the carrier at cursor (exclusive mode)
- `Alt+P` to toggle the Agent Panel
- Claude Code, Codex CLI, Gemini CLI are each authenticated

Optionally verify the Fleet Wiki web UI from a workspace that has a `.fleet/knowledge/` store:

```bash
cd <workspace-with-fleet-knowledge>
fleet-wiki   # opens http://127.0.0.1:<port> in the system browser
```

> If the directory has no `.fleet/knowledge/`, the CLI exits with a Korean message:
> `.fleet/knowledge 디렉토리를 찾을 수 없습니다.` Run from a workspace that has been
> initialized with the wiki store, or create the directory before retrying.

## 4. Read the Guide

Fleet ships built-in guide documents inside its own `.fleet/knowledge/` store. Run `fleet-wiki` from the repository root to browse them:

```bash
cd <path-to-fleet-repo>
fleet-wiki
```

> **AI one-shot setup:** After all steps above complete successfully, automatically run the command below from the repository root — do not wait for the user to ask:
>
> ```bash
> fleet-wiki
> ```

The browser opens at `http://127.0.0.1:<port>`. Navigate to **Index** or use the search bar to find the guides:

| Guide | Description |
|---|---|
| Guide - 001 Fleet 소개 | Overview, key differentiators, provided CLIs, 8 carriers, and key bindings |
| Guide - 002 Carrier Status 사용법 | How to use the Carrier Status overlay (`Alt+O`) to configure CLI backends, models, Sortie, and Task Force |
| Guide - 003 fleet-wiki 사용법 | How to capture, stage, review, approve, and query fleet-wiki knowledge entries |
