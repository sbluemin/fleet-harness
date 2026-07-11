# Fleet

> **A Multi-LLM Orchestration Kit**
>
> A standalone multi-LLM orchestration kit.
> The core purpose is to operate 8 carriers — Claude Code, Codex CLI, OpenCode Go, and Cursor Agent — through a single unified interface.

## Structure

| Path | Description |
|------|-------------|
| `docs/` | **Developer Reference** — `fleet-development-reference.md` and `fleet-lightweight-followup.md`; **Operational Doctrine** — `admiral-workflow-reference.md`; **Admiral-only prompt/runtime architecture note** — `admiral-prompt-architecture.md`; plus the static landing page (`index.html`, `app.jsx`) |
| `packages/` | First-party workspace packages: `core-process` (`@dotobokuri/core-process`), `core-agent` (`@dotobokuri/core-agent`), `core-unified-agent` (`@dotobokuri/core-unified-agent`), `fleet-admiral`, `fleet-carriers`, `core-infra`, and `fleet-wiki` |
| `runtime/` | Runtime workspace packages: `fleet-cli` (CLI host and entry point — `runtime/fleet-cli/bin/fleet`, or `pnpm cli` from the repo root), `fleet-console` (the sole Console HTTP/REST/SSE/WebSocket/PTY/provider/plugin/state/UI owner), `fleet-desktop` (thin Electron native shell and standard-Node sidecar supervisor), and `fleet-plugins/*` (built-in console plugins such as `terminal`) |
| `scripts/` | Repo maintenance scripts: core/agent boundary guards, publish helpers, and the node-pty postinstall fix |

> See each directory's `AGENTS.md` for detailed maps: `runtime/fleet-cli/AGENTS.md`, `runtime/fleet-console/AGENTS.md`, `runtime/fleet-desktop/AGENTS.md`, `packages/core-agent/AGENTS.md`, `packages/core-unified-agent/AGENTS.md`, `packages/fleet-admiral/AGENTS.md`, `packages/fleet-carriers/AGENTS.md`, `packages/core-infra/AGENTS.md`, and `packages/fleet-wiki/AGENTS.md`.

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

- **Compiler-owned outputs:** `CHANGELOG.md` and `CHANGELOG.ko.md` are compiler-managed outputs. Keep both `[Unreleased]` sections present and empty; do not manually add or edit release entries in either file.
- **Format:** Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions (`Added`, `Changed`, `Fixed`, `Removed`, `Breaking Changes` subsections).
- **Versioning:** Each release maps to a git tag (e.g., `## [0.1.1] - YYYY-MM-DD`). `CHANGELOG.ko.md` preserves the English H1, prose, blank lines, version/date headings, English section headings, package tags, and `Release v...` stubs byte-for-byte; only bullet summaries are Korean.
- **Fragment SSoT:** Unreleased notes live in one unique `.changelog.d/*.md` fragment per PR. Do not add `.changelog.d/README.md`; only `.gitkeep` and fragment files belong there.
- **Fragment Format:** Each fragment uses frontmatter with exactly one `section: Added|Changed|Fixed|Removed|Breaking Changes`. Every `- [tag] English summary.` line must be immediately followed by exactly one `  ko: 한글 요약.` line (two leading spaces): English summaries are ASCII-only, Korean summaries are non-empty and contain Hangul, and blank, orphaned, duplicate, or differently indented Korean lines are invalid.
- **Package Prefixes:** Fragment bullets must begin with one or more package tags from this vocabulary only: `[core-process]`, `[core-agent]`, `[core-unified-agent]`, `[core-infra]`, `[fleet-admiral]`, `[fleet-carriers]`, `[fleet-wiki]`, `[fleet-console]`, `[fleet-cli]`. The retired tag names `core`, `wiki`, `wiki-web`, `agent-core`, `unified-agent`, `mcp-server`, `agent`, `carriers`, and `fleet-infra` must not be used as bracketed changelog prefixes. Do not include `@dotobokuri/` scopes in changelog tags.
- **Entry Granularity:** Each locale summary is one physical line describing the user-/operator-visible change; do **not** reference source files, function names, line numbers, or implementation details. English remains plain ASCII English and Korean is a natural Korean translation.
- **Korean terminology and protected tokens:** Use 캐리어, 워크트리, 패널, 플러그인, 런타임, 세션, 캐시, 폴백, 릴리스, and 명령 팔레트. Preserve Fleet, Fleet Console, Admiral, Theater, Operation, provider/carrier/product names, API, CLI, ACP, MCP, SSE, and the exact text and multiplicity of backtick spans, URLs, CLI flags/options, version strings, environment variables, identifiers, file paths, route paths, and literal protocol/status values.
