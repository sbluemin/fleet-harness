# @dotobokuri/fleet-cli

This package is part of the [**fleet-harness**](https://github.com/sbluemin/fleet-harness) monorepo.

## Installation

`fleet-cli` ships the `fleet` executable and must be installed **globally**:

```bash
npm install -g @dotobokuri/fleet-cli
```

Or with your preferred package manager:

```bash
pnpm add -g @dotobokuri/fleet-cli
# or
yarn global add @dotobokuri/fleet-cli
```

After installation, run `fleet` from any directory.

> Do not install this package as a local project dependency — it is a CLI tool intended for global use only.

## Documentation

## Session Plugins

Dedicated Claude and Codex sessions receive Fleet context through generated plugin assets rendered under `~/.fleet/marketplace/plugins/fleet`.
The SessionStart hook injects Fleet doctrine from an inline hook payload, `.mcp.json` reads bearer tokens from child-only environment variables, and provider-shared skill files are generated inside each bundle.

Claude launches with `--plugin-dir ~/.fleet/marketplace/plugins/fleet` and discovers enabled carrier agents from plugin `agents/*.md`.
Fleet also writes provider marketplace metadata at `~/.fleet/marketplace/.agents/plugins/marketplace.json` for Codex and `~/.fleet/marketplace/.claude-plugin/marketplace.json` for Claude. Both marketplace files point at the same installable bundle under `./plugins/fleet`, so carrier and wiki MCP wiring share Codex and Claude manifests, skills, agents, hooks, and MCP config without provider-specific duplication.
Codex uses the official `codex plugin marketplace add ~/.fleet/marketplace` and `codex plugin add fleet -m fleet` commands, with plugin features enabled at launch and hook trust bypass for the vetted Fleet plugin.
Codex role files are no longer created.

See the main repository for full documentation, usage, and contribution guidelines:

**https://github.com/sbluemin/fleet-harness**
