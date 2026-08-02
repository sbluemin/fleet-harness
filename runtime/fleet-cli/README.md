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

Dedicated Claude sessions receive Fleet context through generated plugin assets rendered under `~/.fleet/marketplace/plugins/fleet`. Register the Kimi credential used by Fleet Console's AI Gateway with `fleet auth login kimi`.
The Fleet system prompt is injected at Claude Code launch time via a temporary prompt file, while provider-shared skill files are generated inside the plugin bundle from packaged assets. Built-in skills include Fleet Wiki usage plus the four protocol-mode skills used by the Admiral protocol gate: `protocol-baseline`, `protocol-midline`, `protocol-redline`, and `protocol-frontline`.
The carrier and wiki MCP servers are injected at spawn time through Claude Code `--mcp-config` launch arguments.
Fleet writes Claude marketplace metadata at `~/.fleet/marketplace/.claude-plugin/marketplace.json`, pointing at the installable bundle under `./plugins/fleet`.

Claude launches with `--plugin-dir ~/.fleet/marketplace/plugins/fleet`.

See the main repository for full documentation, usage, and contribution guidelines:

**https://github.com/sbluemin/fleet-harness**
