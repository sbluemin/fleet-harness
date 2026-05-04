# Setup

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and authenticated

## 0. Install pi-coding-agent and pnpm

```bash
# pi-coding-agent provides the `pi` runtime.
npm install -g @mariozechner/pi-coding-agent

# pnpm is the package manager for this repository.
npm install -g pnpm
```

> The repository is pinned to a specific pnpm version via the `packageManager` field in `package.json`. If you have [Corepack](https://nodejs.org/api/corepack.html) enabled, run `corepack enable` once and Corepack will select that version automatically. Otherwise the globally installed pnpm is used as a fallback.

## 1. Clone the repository

Before cloning, ask the user whether it is okay to clone the repository under the current working directory. If not, ask for the desired parent directory and clone it there instead.

> The example below assumes the current directory has been approved by the user.

```bash
git clone https://github.com/sbluemin/pi-fleet.git
cd pi-fleet
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
# which builds packages/unified-agent, packages/fleet-core, packages/fleet-wiki,
# packages/fleet-wiki-web, and packages/pi-fleet-extension in topological order.
pnpm install

# Approve native build scripts (one-time per machine).
# Required for node-pty, esbuild, koffi, protobufjs, and @google/genai.
# The result is saved to pnpm-workspace.yaml `allowBuilds` — subsequent installs
# run these scripts automatically without a warning.
pnpm approve-builds --all

# Register the Fleet wrapper commands globally.
pnpm link --global

# Register the unified-agent CLI used by Fleet provider diagnostics.
pnpm --filter @sbluemin/unified-agent link --global
```

> The repository uses pnpm workspaces (see `pnpm-workspace.yaml`); the root install is the single setup entry point. `pnpm install` writes a single `pnpm-lock.yaml` at the repo root and links each workspace package's local dependencies via symlinks. Cross-package deps are declared with the `workspace:*` protocol so pnpm orders builds topologically.
>
> `pnpm link --global` registers the global wrapper commands from this checkout:
>
> - `fleet` — launches `pi` with the standard Fleet mode.
> - `fleet-exp` — launches standard Fleet mode with `PI_EXPERIMENTAL=1` enabled for the child process.
> - `gfleet` — launches `pi` with Grand Fleet mode enabled for the child process.
> - `fleet-dev` — launches standard Fleet mode, enables `PI_EXPERIMENTAL=1`, and loads `packages/pi-fleet-extension/src/index.ts` directly from this checkout.
> - `gfleet-dev` — launches Grand Fleet mode, enables `PI_EXPERIMENTAL=1`, and loads `packages/pi-fleet-extension/src/index.ts` directly from this checkout.
> - `fleet-wiki` — launches the Fleet Wiki web UI for the current working directory's `.fleet/knowledge/` store. Spawns a detached local HTTP server bound to `127.0.0.1` (a per-user lock under `$TMPDIR/fleet-wiki-<uid>/` ensures a single server per workspace) and opens the system browser. Re-running the command while the server is alive only re-opens the browser. Independent of the `pi` runtime — does not require pi-coding-agent to be installed or pi extensions to be configured.
>
> `pnpm --filter @sbluemin/unified-agent link --global` registers `ait`, the local unified-agent CLI. Fleet uses the same workspace package internally, so linking it from the checkout keeps diagnostics and provider behavior aligned with the source tree.
>
> Fleet infrastructure, metaphor, carriers, and Agent Panel modules now live under `packages/pi-fleet-extension/src/`; they do not require separate `pnpm install` commands.

### Install troubleshooting

- If `pnpm install` reports blocked native build scripts, run `pnpm approve-builds --all`, then run `pnpm install` again.
- If a non-interactive shell reports `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, rerun with `CI=true pnpm install`.
- If CI reports `ERR_PNPM_OUTDATED_LOCKFILE`, the lockfile does not match a package manifest. Run `pnpm install --no-frozen-lockfile` locally, commit the updated `pnpm-lock.yaml`, then rerun CI.
- If `pnpm build` cannot resolve a workspace package, confirm the consuming package lists it in `dependencies` with `workspace:*` and rerun `pnpm install`.

## 3. Register extensions in pi settings

Add or update the `extensions` field in your pi settings file so it points to the Fleet PI extension entry in this checkout.

**Global** (`~/.pi/agent/settings.json`):

```json
{
  "extensions": [
    "<path-to-pi-fleet>/packages/pi-fleet-extension/src/index.ts"
  ]
}
```

> Replace `<path-to-pi-fleet>` with the actual path where you cloned the repository.
>
> **Update rules (for AI one-shot setup):**
>
> - **File or directory missing**: create `~/.pi/agent/` if needed, then write the JSON above.
> - **File exists without an `extensions` field**: add the field, preserving every other top-level field.
> - **`extensions` already contains a pi-fleet entry** (e.g. legacy `<path-to-pi-fleet>/extensions` from older checkouts, or any path under `<path-to-pi-fleet>/`): replace that entry with the path above. Do not append a duplicate.
> - **`extensions` references unrelated extensions**: keep them; only add or update the pi-fleet entry.
>
> **Entry options:**
>
> - Development entry: `packages/pi-fleet-extension/src/index.ts`
> - Built entry after `pnpm --filter @sbluemin/pi-fleet-extension build`: `packages/pi-fleet-extension/dist/index.js`
> - Product core: `packages/fleet-core/` contains Pi-agnostic runtime, public APIs, MCP/tool registry, job infrastructure, prompt policy, and metaphor logic.
> - PI extension adapter: `packages/pi-fleet-extension/src/` wires keybind, settings, log, welcome, HUD, shell, thinking-timer, provider guard, ACP provider modules, metaphor UI, carriers, Admiral/Bridge libraries, Agent Panel, and unified pipeline.
> - Fleet Wiki web surface: `packages/fleet-wiki-web/` provides the `fleet-wiki` CLI, a detached Node.js HTTP server, and a vanilla TypeScript SPA built with Vite. Reads `.fleet/knowledge/` from the current working directory and ships independently of the Pi runtime.
>
> PI settings accept TypeScript or JavaScript extension entries. Use the TypeScript entry for local development, or the built JavaScript entry after building the workspace package.

## 4. Verify

Run the build and CLI checks from the repository root:

```bash
pnpm build
fleet --help
ait --help
ait --list-models

# Confirm the Fleet Wiki CLI is on PATH (registered by `pnpm link --global`)
which fleet-wiki
```

Then launch `pi` and run `/reload`, then check:

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
