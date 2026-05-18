# Fleet

> **A Multi-LLM Orchestration Kit**
>
> A custom extension fleet based on [pi-coding-agent](https://github.com/badlogic/pi-mono).
> The core purpose is to operate 8 carriers — Claude Code, Codex CLI, and Gemini CLI — through a single unified interface.

## Structure

| Path | Description |
|------|-------------|
| `bin/` | Fleet dev and main entry scripts |
| `docs/` | **Main Developer Guide** — Comprehensive reference for PI SDK, extensions, TUI, themes, and RPC; **Operational Doctrine** — High-level architecture, naval hierarchy, and delegation workflows |
| `engines/` | Active Fleet engine workspace — `@sbluemin/fleet-*` packages (`tui`, `ai`, `agent`, `coding-agent`) linked through `workspace:*`, configured for `.fleet` config root, and maintained in-tree as the canonical engine collection. |
| `packages/` | First-party workspace packages: `fleet-core`, `fleet-mcp-server`, `fleet-wiki`, `fleet-wiki-web`, `fleet-harness` (Pi host adapter), and `fleet-dedicated-harness` (embedded CLI TUI PoC) |

> See each directory's `AGENTS.md` for detailed maps: `packages/fleet-core/AGENTS.md`, `packages/fleet-harness/AGENTS.md`, `packages/fleet-dedicated-harness/AGENTS.md`, `packages/fleet-wiki/AGENTS.md`, `packages/fleet-wiki-web/AGENTS.md`, and `engines/AGENTS.md`.

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
- **Package Prefixes:** Starting with `[Unreleased]`, prefix entries with package tags from this vocabulary only: `[core]`, `[mcp-server]`, `[wiki]`, `[wiki-web]`, `[harness]`, `[coding-agent]`, `[ai]`, `[agent-core]`, `[unified-agent]`. Drop the historical `fleet-` prefix in tags. For exactly two affected packages, combine tags (e.g., `[core][unified-agent]`). For cross-cutting changes affecting three or more packages, omit the prefix as fleet-wide. Do **not** use `[tui]`; `tui` maintains a separate changelog. Do **not** link these prefixes to Conventional Commits scopes.
- **Entry Granularity:** Each entry is a single-line summary of the change. Describe the user-/operator-visible behavior change in plain English; do **not** reference source files, function names, line numbers, or implementation details. Implementation specifics belong in the commit message, not in `CHANGELOG.md`.
