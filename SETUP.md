# Setup

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/). The repo pins a version via the `packageManager` field; enable [Corepack](https://nodejs.org/api/corepack.html) once (`corepack enable`) and it will be selected automatically. Otherwise install pnpm globally with `npm install -g pnpm`.
- Authenticated [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), and [Gemini CLI](https://github.com/google-gemini/gemini-cli) on PATH.

## 1. Clone

```bash
git clone https://github.com/sbluemin/fleet-harness.git
cd fleet-harness
```

## 2. Install

```bash
# One-time per machine: configure pnpm's global bin directory and add it to PATH.
# Skip if PNPM_HOME is already set.
pnpm setup

# Install workspace dependencies. The root postinstall runs `pnpm -r build`
# topologically across the workspace (unified-agent, fleet-core, fleet-tui,
# fleet-wiki, fleet-wiki-web, fleet-agent).
pnpm install

# One-time per machine: approve native postinstall scripts. Required by
# node-pty, esbuild, koffi, protobufjs, and @google/genai. The decision is
# persisted in `pnpm-workspace.yaml` under `allowBuilds`.
pnpm approve-builds --all

# Register the global commands `fleet` and `fleet-wiki` from this checkout.
pnpm link --global

# Register `ait`, the unified-agent CLI used for provider diagnostics.
pnpm --filter @sbluemin/fleet-unified-agent link --global
```

## 3. Verify

```bash
fleet --help
ait --help
```

Launch the TUI with `fleet`. The window is a permanent two-pane layout: a dedicated CLI on top, the Fleet PTY on the bottom.

Key bindings:

- `Ctrl+T` — toggle between **MIRROR** (Fleet PTY mirrors keystrokes to the dedicated CLI) and **DEDICATED** (dedicated CLI takes exclusive focus).
- `Alt+O` — open the Carrier Status overlay (configure CLI backends, models, effort, Task Force).
- `Ctrl+C` — exit.

`fleet` flags:

- `-h, --help` — print usage and exit.
- `-c, --cli <claude|codex>` — select the embedded CLI. Default `claude`; env override `FLEET_DEDICATED_CLI`.
- `-n, --native` — run the dedicated CLI without injecting the Fleet system prompt; the Fleet Action Protocol label is hidden in the Fleet PTY (the divider line is preserved).

## Troubleshooting

- **Blocked native build scripts** — rerun `pnpm approve-builds --all`, then `pnpm install`.
- **`ERR_PNPM_OUTDATED_LOCKFILE` in CI** — `pnpm install --no-frozen-lockfile` locally, commit the updated `pnpm-lock.yaml`, rerun CI.
- **`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`** — rerun with `CI=true pnpm install`.
- **Workspace package not resolved during build** — confirm the consumer lists it as `workspace:*` in `dependencies`, then `pnpm install` again.

## Fleet Wiki (optional)

The Fleet Wiki web UI browses the `.fleet/knowledge/` store of the current working directory.

```bash
cd <workspace-with-.fleet/knowledge>
fleet-wiki   # opens http://127.0.0.1:<port> in the system browser
```

If the directory has no `.fleet/knowledge/`, the CLI exits with a Korean message (`.fleet/knowledge 디렉토리를 찾을 수 없습니다.`); run from a workspace that has the store, or from this repo's root, which ships built-in guides (Fleet overview, Carrier Status usage, fleet-wiki usage).
