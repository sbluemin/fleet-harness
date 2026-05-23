# Fleet

> **A Multi-LLM Orchestration Kit**
>
> A standalone multi-LLM orchestration kit.
> The core purpose is to operate 8 carriers — Claude Code, Codex CLI, and Gemini CLI — through a single unified interface.

## Structure

| Path | Description |
|------|-------------|
| `bin/` | Fleet dev and main entry scripts |
| `docs/` | **Main Developer Guide** — Comprehensive reference for SDK, extensions, TUI, themes, and RPC; **Operational Doctrine** — High-level architecture, naval hierarchy, and delegation workflows |
| `packages/` | First-party workspace packages: `fleet-admiral` (single-fleet orchestration), `fleet-admiralty` (multi-fleet coordination), `fleet-mcp-server`, `fleet-carriers`, `fleet-infra`, `fleet-wiki`, `fleet-wiki-web`, `fleet-tui`, `fleet-agent` (embedded CLI TUI), and `unified-agent` (`@sbluemin/fleet-unified-agent`) |

> See each directory's `AGENTS.md` for detailed maps: `packages/fleet-admiral/AGENTS.md`, `packages/fleet-admiralty/AGENTS.md`, `packages/fleet-agent/AGENTS.md`, `packages/fleet-infra/AGENTS.md`, `packages/fleet-wiki/AGENTS.md`, `packages/fleet-wiki-web/AGENTS.md`, and `packages/unified-agent/AGENTS.md`.

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
- **Package Prefixes:** Starting with `[Unreleased]`, prefix entries with package tags from this vocabulary only: `[core]`, `[mcp-server]`, `[wiki]`, `[wiki-web]`, `[agent-core]`, `[unified-agent]`. Drop the historical `fleet-` prefix in tags. For exactly two affected packages, combine tags (e.g., `[core][unified-agent]`). For cross-cutting changes affecting three or more packages, omit the prefix as fleet-wide. Do **not** use `[tui]`; `tui` maintains a separate changelog. Do **not** link these prefixes to Conventional Commits scopes.
- **Entry Granularity:** Each entry is a single-line summary of the change. Describe the user-/operator-visible behavior change in plain English; do **not** reference source files, function names, line numbers, or implementation details. Implementation specifics belong in the commit message, not in `CHANGELOG.md`.
