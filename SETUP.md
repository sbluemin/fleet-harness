# Setup

## Prerequisites

- [Node.js](https://nodejs.org/) v20+
- Authenticated [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex CLI](https://github.com/openai/codex) on PATH

## Install

### 1. Clean up legacy links

Previous installations may have registered `fleet` or `fleet-wiki` via `pnpm link --global`. These must be removed before installing the npm package to avoid `EEXIST` conflicts.

Check and remove:

```bash
# Check if a pnpm global link exists
pnpm ls -g --depth=0 | grep -E 'fleet-harness|fleet-cli|pi-coding-agent'

# If found, unlink from the source repo root
cd <path-to-fleet-harness-or-pi-coding-agent-repo>
pnpm unlink --global

# Verify the fleet command is no longer linked
which fleet && npm rm -g fleet || true
```

If `which fleet` still returns a path after unlinking, remove it manually:

```bash
rm "$(which fleet)"
```

### 2. Choose release channel

Ask the user which release channel they prefer before running the install command:

- **stable** (latest) — production-ready, published from the `main` branch.
- **canary** — latest development build, published from the `canary` branch. May contain breaking changes.

```bash
# stable
npm install -g @dotobokuri/fleet-cli

# canary
npm install -g @dotobokuri/fleet-cli@canary
```

## Verify

```bash
fleet --help
fleet wiki --help
```

## Post-Install Warning

After installation, warn the user:

> **Breaking change**: This version has removed the legacy `pi-coding-agent` foundation. Conversation history and session data from previous source-based installations **cannot be recovered**.

If the user needs to access previous conversations, guide them to:

1. Uninstall the npm version: `npm uninstall -g @dotobokuri/fleet-cli`
2. Clone and checkout the last compatible version:
   ```bash
   git clone https://github.com/sbluemin/fleet-harness.git
   cd fleet-harness
   git checkout v0.21.0
   ```
3. Follow the `SETUP.md` in the checked-out v0.21.0 tag to complete installation.
