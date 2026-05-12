# AGENTS.md — @sbluemin/fleet-unified-agent

## Project Overview

A minimal-dependency TypeScript SDK that integrates Gemini CLI, Claude Code, and Codex CLI into a single interface.

## Tech Stack

- **Language**: TypeScript (ES2022, strict mode)
- **Build**: `tsc` (ESM-only output)
- **Test**: Vitest
- **Runtime Dependencies**: `@agentclientprotocol/sdk`, `zod`, `picocolors`
- **Node.js**: >= 18.0.0

## Project Structure

```
src/
├── index.ts                    # Public exports (SDK entry point)
├── cli.ts                      # CLI entry point (Mode branching: oneshot vs REPL)
├── cli-oneshot.ts              # Oneshot execution logic (CLI argument handling)
├── cli-repl.ts                 # REPL mode logic (Interactive interface)
├── cli-renderer.ts             # CLI result rendering (Pretty/JSON output)
├── service-status/
│   ├── index.ts                # Service status management exports
│   ├── types.ts                # ServiceSnapshot, HealthStatus, ProviderKey types
│   ├── callbacks.ts            # ServiceStatusCallbacks implementation
│   └── context.ts              # ServiceStatusContextPort implementation
├── types/
│   ├── common.ts               # JSON-RPC 2.0 base types
│   ├── acp.ts                  # ACP protocol types (Based on official schema)
│   └── config.ts               # CLI config/detection types
├── connection/
│   ├── BaseConnection.ts       # Abstract base (spawn + JSON-RPC stdio)
│   ├── AcpConnection.ts        # ACP protocol implementation (Wraps official SDK ClientSideConnection)
│   └── CodexAppServerConnection.ts # Codex app-server v2 native JSON-RPC implementation
├── client/
│   ├── IUnifiedAgentClient.ts  # Public API contract + UnifiedAgent builder
│   ├── UnifiedClaudeAgentClient.ts # Claude-specific client
│   ├── UnifiedGeminiAgentClient.ts # Gemini-specific client
│   ├── UnifiedCodexAgentClient.ts  # Codex-specific client
│   └── UnifiedOpenCodeAgentClient.ts # OpenCode-specific client
├── detector/
│   └── CliDetector.ts          # CLI auto-detection
├── models/
│   ├── schemas.ts              # Model registry Zod schemas + types
│   └── ModelRegistry.ts        # Static model registry (Based on models.json)
├── config/
│   └── CliConfigs.ts           # spawn settings per CLI
└── utils/
    ├── env.ts                  # Environment variable sanitization
    ├── process.ts              # Safe process termination
    └── npx.ts                  # npx path resolution

tests/
└── e2e/                        # E2E tests per CLI (Executing actual CLIs)
    ├── helpers.ts              # Shared helper functions
    ├── claude.test.ts           # Claude E2E
    ├── codex.test.ts            # Codex E2E
    └── gemini.test.ts           # Gemini E2E
```

## Core Commands

```bash
# Type check
pnpm lint

# E2E tests per CLI (Requires actual CLI, local only)
pnpm exec vitest run tests/e2e/claude.test.ts
pnpm exec vitest run tests/e2e/codex.test.ts
pnpm exec vitest run tests/e2e/gemini.test.ts

# Run all tests
pnpm test

# Build
pnpm build
```

## CLI (`ait`)

Binary name: `ait` (`bin` field in `package.json`)

```bash
# Oneshot mode — Executes immediately and exits if arguments are provided
ait "prompt"
ait -c claude -m opus "code review"
echo "error" | ait -c gemini

# REPL mode — Executes in TTY without arguments
ait
ait -c claude -m opus
```

### REPL Prompt
```
ait (model) (effort) ❯ {input}
ait (gemini) ❯ {input}           # Omitted if effort is not supported
```

### Slash Commands
| Command | Action |
|---------|--------|
| `/model <id>` | Change model (list if no argument) |
| `/effort <lv>` | Change reasoning effort |
| `/status` | Show current status |
| `/clear` | Clear screen |
| `/help` | Show help |
| `/exit` | Exit |

## Coding Rules

### Language
- All code comments **MUST be written in Korean**.
- JSDoc descriptions for `@param` and `@returns` are also written in Korean.

### TypeScript
- `strict: true` — No `any` or implicit `any`.
- `noUnusedLocals: true`, `noUnusedParameters: true` — No unused variables/parameters.
- Include `.js` extensions in imports (ESM compatibility).
- Use `as unknown as Record<string, unknown>` pattern for JSON-RPC params type casting.

### Protocol
- ACP types based on [Official ACP Schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/schema.json).
- `protocolVersion` is a number (uint16), currently `1`.
- `session/new` params: `{ cwd: string, mcpServers: [] }` (Required).
- `session/prompt` params: `{ sessionId, prompt: ContentBlock[] }`.
- `session/set_config_option` params: `{ sessionId, configId, value }`.

### Testing
- **E2E Tests** (`tests/e2e/`): Independent files per CLI and protocol. Spawn actual CLIs, so run only in authenticated local environments.
- Filename convention: `<cli>.test.ts` (e.g., `claude.test.ts`, `codex.test.ts`).
- Automatically skip uninstalled CLIs using `describe.skipIf(!isCliInstalled('xxx'))`.
- Test timeout: 180,000ms (3 mins), Session resume: 360,000ms (6 mins).

### Dependencies
- **Minimize Runtime Dependencies**: `@agentclientprotocol/sdk` (Official ACP SDK) + `zod` (Schema validation) + `picocolors` (CLI styling).
- Add only development tools to `devDependencies`: `typescript`, `vitest`, `@types/node`.

## Protocol Support Status per CLI

| CLI | Protocol | spawn Method | set_config_option | set_mode |
|-----|----------|--------------|-------------------|----------|
| Gemini | ACP | `gemini --acp` | ❌ | ❌ |
| Claude | ACP (npx bridge) | `npx --package=@agentclientprotocol/claude-agent-acp@0.33.1 claude-agent-acp` | ✅ | ✅ |
| Claude (ZAI) | ACP (npx bridge) | `npx --package=@agentclientprotocol/claude-agent-acp@0.33.1 claude-agent-acp --cli` | ✅ | ✅ |
| Claude (Kimi) | ACP (npx bridge) | `npx --package=@agentclientprotocol/claude-agent-acp@0.33.1 claude-agent-acp --cli` | ✅ | ✅ |
| Codex | `codex-acp` / `app-server` | (Toggle) `npx --yes --package=@zed-industries/codex-acp@0.14.0 codex-acp` / `codex app-server` | ✅ (ACP) / Pending (Legacy) | ✅ (ACP) / Pending (Legacy) |
| opencode-go | ACP | `opencode acp` | ✅ | ✅ |

## Architecture Decisions

1. **Specialized Clients per CLI**: The `UnifiedAgent` builder selects the provider client, and `UnifiedClaudeAgentClient` / `UnifiedGeminiAgentClient` / `UnifiedCodexAgentClient` / `UnifiedOpenCodeAgentClient` directly hold each CLI specialization.
2. **ACP SDK used for ACP-based CLIs**: Claude, Gemini, and OpenCode Go use the ACP SDK via `AcpConnection`. Codex handles both `AcpConnection` (npx bridge path) and `CodexAppServerConnection` (legacy stdio JSON-RPC path) depending on the validation toggle.
3. **Config-driven + provider seam**: Maintain common contracts while encapsulating CLI differences in `CliConfigs.ts` and internal connection seams.
4. **Event-driven Streaming**: Real-time response processing based on `EventEmitter` (`messageChunk`, `toolCall`, etc.).
5. **Graceful Process Management**: 2-stage termination (SIGTERM → SIGKILL), and environment sanitization to prevent child process interference.
6. **Service Status Management**: Provides a unified way to track and report the health and status of various services (Gemini, Claude, Codex) through `ServiceSnapshot` and `HealthStatus`. Managed via `ServiceStatusCallbacks` and `ServiceStatusContextPort`.
7. **System Prompt Injection (Provider-aware)**:
   - **Claude**: `AcpConnection` appends to the native system prompt via `_meta.systemPrompt.append` when calling `session/new`. The `claude-agent-acp` bridge handles this.
   - **Codex (Dual-path)**: 
     - **ACP path**: Passes `systemPrompt` via spawn args `-c developer_instructions="..."`.
     - **AppServer path**: Passes `systemPrompt` as `developerInstructions` when creating/resuming a thread.
   - **Gemini**: `UnifiedGeminiAgentClient` manages `firstPromptPending` state and prefixes the first `sendMessage()` after a new session with the system text `ContentBlock`. This is not a true system-role guarantee.
   - **OpenCode Go**: `UnifiedOpenCodeAgentClient` also manages `firstPromptPending` state (same approach as Gemini) since `_meta.systemPrompt.append` is unsupported. Session reset is handled via disconnect + reconnect.
   - **Session Persistence Contract**: Re-armed for new sessions after `resetSession()`. Codex resume/load paths via `sessionId` re-pass the current client's `systemPrompt`, policies (`approvalPolicy`/`sandbox`), and thread config to `thread/resume`. Claude/Gemini session resume follows a best-effort policy prioritizing conversation continuity; if intentional drift cleanup is needed, the caller must invoke `resetSession()`.

8. **CLI_BACKENDS Single Source of Truth**: `CLI_BACKENDS` in `src/config/CliConfigs.ts` is the sole configuration registry for all CLI providers. `CliType` is derived as `keyof typeof CLI_BACKENDS`. Each entry defines:
   - `id`, `cliCommand`, `protocol`, `authRequired`
   - `acpArgs`, `appServerArgs`, `npxPackage`, `usesNpxBridge` — spawn method configuration
   - `modes` — available agent mode definitions
   - `supportsSessionClose`, `supportsSessionLoad` — session capability flags
   - `requiresModelAtSpawn` — spawn behavior flags
   - `defaultMaxTokens` — resource limits
   - `colorRgb`, `bgColorRgb` — ANSI display colors
    - Display names are sourced from `models.json` via `providers.<cli>.name`

9. **Claude Effort via `_meta` Bridge Channel**: Claude reasoning effort is delivered through `_meta.claudeCode.options.effort` spread in `session/new` and `session/load` payloads (not via `session/set_config_option` RPC). This channel bypasses alias resolution issues on the bridge and ensures effort applies consistently across new sessions and session resumption.

10. **Validation-mode Dual-Path for Codex**: Codex currently supports two transport paths (ACP npx bridge and legacy AppServer) controlled by a `CODEX_USE_ACP` toggle. This is a temporary validation wave for protocol transition; a permanent switch will occur in a future wave, deprecating the legacy AppServer path and associated types.

## Adding a New CLI Provider

Adding a new CLI provider requires updating the provider registry first, then any provider-specific seams that do not derive automatically:

1. **`engines/packages/` tree의 `unified-agent/src/config/CliConfigs.ts`** — Add an entry to `CLI_BACKENDS` with the required spawn/protocol metadata.
2. **Claude-family alias additions** — If the new provider reuses `UnifiedClaudeAgentClient`, also update the `cliType` union in `src/client/UnifiedClaudeAgentClient.ts`, the Claude bridge allowlist in `src/connection/AcpConnection.ts#getClaudeSystemPrompt()`, the status fetcher registration in `src/service-status/store.ts`, and any provider-specific fallback URL/target switches in the same store.
3. **OpenCode-specific note** — The current OpenCode surface keeps only `opencode-go`. Adding another OpenCode variant requires reintroducing explicit routing in `src/client/IUnifiedAgentClient.ts`, the provider union in `src/client/UnifiedOpenCodeAgentClient.ts`, OpenCode entries in `src/service-status/store.ts`, the model registry in `models.json`, and E2E coverage in `tests/e2e/opencode.test.ts`.
4. **Non-derived provider seams** — Add or adjust any dedicated client routing, status fetcher, or fallback behavior that is not automatically derived from `CLI_BACKENDS`.

All downstream consumers (`fleet-core` constants: `CARRIER_COLORS`, `CARRIER_BG_COLORS`, `VALID_CLI_TYPES`, `CLI_PROVIDER_DISPLAY_NAMES`, `CLI_TYPE_DISPLAY_ORDER`) derive automatically from `CLI_BACKENDS`.
