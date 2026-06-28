# Fleet

> **A Multi-LLM Orchestration Kit**
>
> A standalone multi-LLM orchestration kit.
> The core purpose is to operate 8 carriers — Claude Code, Codex CLI, OpenCode Go, and Cursor Agent — through a single unified interface.

## Structure

| Path | Description |
|------|-------------|
| `docs/` | **Developer Reference** — `fleet-development-reference.md` and `fleet-lightweight-followup.md`; **Operational Doctrine** — `admiral-workflow-reference.md`; **Admiral-only prompt/runtime architecture note** — `admiral-prompt-architecture.md`; plus the static landing page (`index.html`, `app.jsx`) |
| `packages/` | First-party workspace packages: `core-agent` (`@dotobokuri/core-agent`), `core-unified-agent` (`@dotobokuri/core-unified-agent`), `fleet-admiral`, `fleet-carriers`, `fleet-infra`, and `fleet-wiki` |
| `runtime/` | Runtime workspace packages: `fleet-cli` (CLI host and entry point — `runtime/fleet-cli/bin/fleet`, or `pnpm fleet` from the repo root), `fleet-console` (Console plus Codex/Fleet Wiki web surface), and `fleet-plugins/*` (built-in console plugins such as `terminal`) |
| `scripts/` | Repo maintenance scripts: core/agent boundary guards, publish helpers, and the node-pty postinstall fix |

> See each directory's `AGENTS.md` for detailed maps: `runtime/fleet-cli/AGENTS.md`, `runtime/fleet-console/AGENTS.md`, `packages/core-agent/AGENTS.md`, `packages/core-unified-agent/AGENTS.md`, `packages/fleet-admiral/AGENTS.md`, `packages/fleet-carriers/AGENTS.md`, `packages/fleet-infra/AGENTS.md`, and `packages/fleet-wiki/AGENTS.md`.

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
- **Versioning:** Each release maps to a git tag (e.g., `## [0.1.1] - YYYY-MM-DD`). The `[Unreleased]` section stays present but empty; do not manually add unreleased entries to `CHANGELOG.md`.
- **Fragment SSoT:** Unreleased notes live in one unique `.changelog.d/*.md` fragment per PR. Do not add `.changelog.d/README.md`; only `.gitkeep` and fragment files belong there.
- **Fragment Format:** Each fragment uses frontmatter with exactly one `section: Added|Changed|Fixed|Removed|Breaking Changes`, followed by one or more English bullet lines.
- **Package Prefixes:** Fragment bullets must begin with one or more package tags from this vocabulary only: `[core-agent]`, `[core-unified-agent]`, `[fleet-infra]`, `[fleet-admiral]`, `[fleet-carriers]`, `[fleet-wiki]`, `[fleet-console]`, `[fleet-cli]`. The retired tag names `core`, `wiki`, `wiki-web`, `agent-core`, `unified-agent`, `mcp-server`, `agent`, and `carriers` must not be used as bracketed changelog prefixes. Do not include `@dotobokuri/` scopes in changelog tags.
- **Entry Granularity:** Each entry is a single-line summary of the change. Describe the user-/operator-visible behavior change in plain English; do **not** reference source files, function names, line numbers, or implementation details. Implementation specifics belong in the commit message, not in `CHANGELOG.md`.
