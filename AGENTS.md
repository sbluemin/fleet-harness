# Fleet

> **A Multi-LLM Orchestration Kit**
>
> A standalone multi-LLM orchestration kit.
> The core purpose is to operate 8 carriers — Claude Code, Codex CLI, and Cursor Agent — through a single unified interface.

## Structure

| Path | Description |
|------|-------------|
| `bin/` | Fleet dev and main entry scripts |
| `docs/` | **Main Developer Guide** — Comprehensive reference for SDK, extensions, TUI, themes, and RPC; **Operational Doctrine** — High-level architecture, naval hierarchy, and delegation workflows |
| `packages/` | First-party workspace packages: `core-agent` (`@dotobokuri/core-agent`), `core-mcp-server` (`@dotobokuri/core-mcp-server`), `core-unified-agent` (`@dotobokuri/core-unified-agent`), `fleet-carriers`, `fleet-infra`, `fleet-wiki`, and `fleet-wiki-ui` |

> See each directory's `AGENTS.md` for detailed maps: `runtime/fleet-cli/AGENTS.md`, `packages/core-agent/AGENTS.md`, `packages/core-mcp-server/AGENTS.md`, `packages/core-unified-agent/AGENTS.md`, `packages/fleet-infra/AGENTS.md`, `packages/fleet-wiki/AGENTS.md`, and `runtime/fleet-wiki-ui/AGENTS.md`.

## TypeScript File Structure

All `.ts` source files must follow this top-to-bottom declaration order:

```
imports → types/interfaces → constants → functions
```

- **Imports** — external packages first, then internal modules.
- **Types / Interfaces** — `interface` and `type` declarations only; no logic.
- **Constants** — `const` declarations. Module-private constants are `const` (unexported); public ones are `export const`.
- **Functions** — exported functions first, then internal helpers at the bottom.

Do **not** interleave constants and functions, or declare types mid-file.

## Git Guidelines

- **Commit Message Format:** Strictly adhere to the [Conventional Commits](https://www.conventionalcommits.org/) specification.
  - Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **Language:** All commit messages **MUST be written in English**.

## Changelog Guidelines

- **Language:** `CHANGELOG.md` **MUST be written entirely in English** — entries, descriptions, and all prose.
- **Format:** Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions (`Added`, `Changed`, `Fixed`, `Removed`, `Breaking Changes` subsections).
- **Versioning:** Each release maps to a git tag (e.g., `## [0.1.1] - YYYY-MM-DD`). The `[Unreleased]` section stays empty until the next release is cut.
- **Package Prefixes:** Starting with `[Unreleased]`, prefix entries with package tags from this vocabulary only: `[core]` (Fleet-domain host and runtime — `fleet-cli`, `fleet-admiral`, `fleet-carriers`, `fleet-infra`), `[core-agent]`, `[core-mcp-server]`, `[core-unified-agent]`, `[wiki]`, `[wiki-web]`. The `core-*` tags map one-to-one to the Fleet-domain-agnostic `@dotobokuri/core-*` packages; the historical `[mcp-server]`, `[unified-agent]`, and `[agent-core]` tags are retired in their favor. Drop the historical `fleet-` prefix in tags. For exactly two affected packages, combine tags (e.g., `[core][core-unified-agent]`). For cross-cutting changes affecting three or more packages, omit the prefix as fleet-wide. Do **not** use `[tui]`; `tui` maintains a separate changelog. Do **not** link these prefixes to Conventional Commits scopes.
- **Entry Granularity:** Each entry is a single-line summary of the change. Describe the user-/operator-visible behavior change in plain English; do **not** reference source files, function names, line numbers, or implementation details. Implementation specifics belong in the commit message, not in `CHANGELOG.md`.
