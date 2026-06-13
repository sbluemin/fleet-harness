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
The Fleet system prompt is injected at CLI launch time via temporary prompt files for Claude and a dedicated Codex profile, while provider-shared skill files and Claude subagent definitions are generated inside the plugin bundle from packaged assets. Built-in skills include Fleet Wiki usage plus the four protocol-mode skills used by the Admiral protocol gate: `protocol-baseline`, `protocol-midline`, `protocol-redline`, and `protocol-frontline`.
The carrier and wiki MCP servers are not rendered into the plugin bundle; they are injected at spawn time as launch arguments (`--mcp-config` for Claude and `-c mcp_servers.*` for Codex).

Claude launches with `--plugin-dir ~/.fleet/marketplace/plugins/fleet` and discovers enabled carrier agents from plugin `agents/*.md`.
Claude-family sessions also receive a Fleet-managed `SessionStart` hook that bootstraps through the current Fleet entry by absolute path (`node <entry> hook subagents-context`, or `node --import <tsx-loader> <entry> hook subagents-context` for development TypeScript entries), so the hook does not depend on `fleet` being present on `PATH`; Codex and Cursor do not receive this hook.
Fleet also writes provider marketplace metadata at `~/.fleet/marketplace/.agents/plugins/marketplace.json` for Codex and `~/.fleet/marketplace/.claude-plugin/marketplace.json` for Claude. Both marketplace files point at the same installable bundle under `./plugins/fleet`, so Codex and Claude share manifests, skills, and agents without provider-specific duplication.
Codex uses the official `codex plugin marketplace add ~/.fleet/marketplace` and `codex plugin add fleet -m fleet` commands, with plugin features enabled at launch and the Fleet profile selected automatically.
Codex role files are no longer created.

See the main repository for full documentation, usage, and contribution guidelines:

**https://github.com/sbluemin/fleet-harness**
