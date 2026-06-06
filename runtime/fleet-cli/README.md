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

Dedicated Claude and Codex sessions receive Fleet context through generated plugin assets rendered under `~/.fleet/plugins`.
The SessionStart hook injects Fleet doctrine from an inline hook payload, `.mcp.json` reads bearer tokens from child-only environment variables, and `skills/fleet-usage/SKILL.md` is generated for both providers.

Claude launches with `--plugin-dir ~/.fleet/plugins` and discovers enabled carrier agents from plugin `agents/*.md`.
Codex treats the same flat directory as both the local marketplace and plugin root: `.codex-plugin`, `.claude-plugin`, hooks, skills, `.mcp.json`, and `.agents/plugins/marketplace.json` coexist under `~/.fleet/plugins`.
Because Codex does not discover a plugin when `marketplace.json` points directly at `"."`, Fleet also renders a contained compatibility symlink at `~/.fleet/plugins/plugins/fleet -> ..` and points the marketplace entry at `./plugins/fleet`.
Codex uses the official `codex plugin marketplace add ~/.fleet/plugins` and `codex plugin add fleet -m fleet` commands, with plugin features enabled at launch and hook trust bypass for the vetted Fleet plugin.
Codex role files are no longer created.

See the main repository for full documentation, usage, and contribution guidelines:

**https://github.com/sbluemin/fleet-harness**
