# Admiral Domain Doctrine

`packages/fleet-core/src/admiral/` is the Admiral-owned compatibility facade and policy module home. Carrier dispatch, Task Force runtime, jobs, store, events, and carrier runtime constants are implemented in `packages/fleet-carriers` and consumed through fleet-core facades.

## Fleet Architecture

This project is an **Agent Harness** that centrally commands and orchestrates powerful CLI tools (Claude Code, Codex, Gemini, etc.), each of which possesses its own internal sub-agent system.

Beyond simple parallel API calls, the system uses clear role boundaries to separate responsibilities across the architecture.

### Core Entities

| Layer | Entity | Definition |
|-------|--------|------------|
| 1 | **User** | Sets ultimate strategy and final objectives. |
| 2 | **Admiralty** | Internalized domain in `fleet-core` for multi-fleet orchestration. *Does not exist in single-fleet mode; the user communicates directly with the Admiral.* |
| 3 | **Admiral** | A single workspace PI instance. Plans operations and dispatches Carriers within its operational zone. |
| 4 | **Carrier Persona** | The role profile for a Carrier agent. |

> **Note on Persona & Tone**: Carrier role data is managed through carrier metadata and prompt assets within the `admiral` domain.

#### Carrier vs Captain Separation
- **Carrier**: The **system entity** (ID: `genesis`, `sentinel`, etc.). Represents the execution instance, process, and configuration.
- **Captain**: The **commander persona** of that Carrier. Represents the "voice" and "character" (e.g., Chief Engineer, Scout Specialist) that communicates with the Admiral.

## Architecture — Agent Workflow

PI is the **host agent** (orchestrator). Registered Carriers are **sub-agents** that execute independently via ACP protocol.

### Speakers

| Speaker | Role |
|---------|------|
| **PI** (host) | Orchestrator — routes requests, invokes tools, synthesizes cross-reports |
| **Nimitz** (sub) | CVN-09 Strategic Command & Judgment — read-only (Claude Code CLI via ACP) |
| **Kirov** (sub) | CVN-02 Operational Planning Bridge (Claude Code CLI via ACP) |
| **Genesis** (sub) | CVN-01 Chief Engineer — single-shot implementation under Admiral direction (Codex CLI via ACP) |
| **Ohio** (sub) | CVN-10 Multi-Wave Strike Execution — receives `plan_file` from Kirov; sole plan-driven executor (Codex CLI via ACP) |
| **Sentinel** (sub) | CVN-04 The Inquisitor / QA & Security Lead (Codex CLI via ACP) |
| **Vanguard** (sub) | CVN-06 Scout Specialist (Codex CLI via ACP) |
| **Tempest** (sub) | CVN-07 Forward External Intelligence Strike (Gemini CLI via ACP) |
| **Chronicle** (sub) | CVN-08 Chief Knowledge Officer — documentation, change-impact summaries, and release communication (Gemini CLI via ACP) |

> **Persona Metadata Emphasis Ladder**: All 8 carrier personas share a three-tier emphasis ladder applied uniformly across `description` / `usageGuidelines` / `guardrails`:
> - **L1 `CRITICAL: ...`** — safety invariants
> - **L2 `MUST ... / MUST NOT ...`** — binding obligations
> - **L3** — plain prose for guidance
>
> Self-name repetition has been removed (e.g., `Genesis MUST` → `MUST`). `whenToUse` / `whenNotToUse` entries are binding contracts at the spec level and **cannot** use emphasis markers.

### Execution Modes

| Mode | Trigger | Flow |
|------|---------|------|
| **Fleet Action** | Alt+1 (Active Protocol) | PI handles directly (no sub-agents) — Standard workflow |
| **Tool delegation** | PI's own judgment | PI → tool_call(any carrier) → sub-agent result → PI synthesizes |
| **Bridge (single)** | Alt+T | User → single sub-agent shell (PI acts as router only, no synthesis) |

### Task Force Backend Whitelist

Task Force execution is an internal mode selected by `carrier_dispatch` auto-promotion when a carrier has configured backends. The configured backend whitelist is derived from every CLI provider registered in `CLI_BACKENDS` (Single Source of Truth). The current whitelist contains **6 backends**:

| CLI Type | Display Name | Notes |
|----------|--------------|-------|
| `claude` | Claude Code | Anthropic-hosted Claude (default) |
| `claude-zai` | Claude Code with Z.AI GLM | Claude bridge with Z.AI base URL |
| `claude-kimi` | Claude Code with Moonshot Kimi | Claude bridge with Moonshot base URL |
| `codex` | Codex | OpenAI Codex (`codex-app-server`) |
| `gemini` | Gemini | Google Gemini CLI |
| `opencode-go` | OpenCode | OpenCode Go CLI |

- `TaskForceCliType` is an alias of `CliType`; `TASKFORCE_CLI_TYPES` is auto-derived via `Object.keys(CLI_BACKENDS) as CliType[]` in `packages/fleet-carriers/src/dispatch/types.ts`.
- Dispatch/configuration copy (`TASKFORCE_CONFIGURE_HINT`, `[carrier:result]` backend label examples) and overlay colors (`CARRIER_COLORS`) are derived from `CLI_BACKENDS × CLI_DISPLAY_NAMES`. Adding a new entry to `CLI_BACKENDS` automatically extends Task Force without touching prompts or the overlay.
- **Persona × CLI compatibility is allowed**: any registered carrier persona may pair with any of the six CLI backends. Configure pairings via Carrier Status (Alt+O → T) per carrier.
- Providers without supported reasoning effort follow the existing Gemini pattern (`effort.supported = false`) and surface no effort/budget controls in the configuration overlay.

## Fleet Architecture (Sub-agent Workflow)

- **Sub-agents are fully independent** — PI provides only background, objectives, and constraints. Never prescribe implementation details.
- **Sub-agents are unaware of each other** — Cross-analysis is performed solely by PI after all responses are collected.
- **Communication layer**: Pi consumers invoke `executeWithPool()` / `executeOneShot()` from the `@sbluemin/fleet-core` root barrel (callback-pattern executor). Host streaming adapters are no longer part of the fleet-core agent surface.
- **Carrier runtime layer**: `carrier_dispatch` remains the sole public carrier delegation tool; Task Force remains an internal auto-promotion path implemented by `fleet-carriers`. `doctrine/protocols` remain in fleet-core and are excluded from carrier runtime migration.

## Builtin External MCP Integration

Admiral 도메인은 각 Carrier가 사용하는 MCP(Model Context Protocol) 서버를 관리하며, 내부 도구 모음인 `fleet-tools`와 외부 등록형 `builtin external MCP` 서버를 명확히 구분하여 처리합니다. Builtin external MCP catalog 소유권은 `packages/fleet-infra/src/agent/external-mcp.ts`에 있습니다.

### Layer Separation: Tool ID vs Server ID

- **`allowedExecutorTools` (Tool Layer)**: `fleet-tools` 세션에 노출할 개별 도구 ID(예: `carrier_jobs`) 목록입니다.
- **`allowedBuiltinExternalMcpServers` (Server Layer)**: 에이전트에 통째로 노출할 외부 builtin MCP 서버 ID(예: `grep_app`) 목록입니다. 두 개념은 서로 다른 계층(Layer)에 존재하므로 도구 ID와 서버 ID를 혼용해서는 안 됩니다.

### Invariants & Limitations

1. **HTTP/HTTPS Transports Only**: Builtin external MCP catalog(`packages/fleet-infra/src/agent/external-mcp.ts`)는 오직 HTTP/HTTPS 전송 프로토콜만 허용합니다.
2. **`strictMcp:true` Preservation**: 모든 외부 MCP 서버 연결 시에도 엄격한 도구 해상도 검증(`strictMcp`) 정책을 계속 유지합니다.
3. **`fleet-tools` Bearer Isolation**: 내부 `fleet-tools`용 세션 Bearer 토큰이 외부 MCP 서버로 유출되지 않도록 엄격하게 격리(assertFleetToolsTokenNotShared)합니다.
4. **No Workspace Configuration**: 사용자 workspace 레벨의 `.fleet/external-mcp.json` 파일 기반 동적 구성은 지원하지 않으며, 소스 레벨 catalog(`packages/fleet-infra/src/agent/external-mcp.ts`)의 정적 설정으로만 작동합니다. 이 파일은 internal helper로서 public root barrel에 노출되지 않습니다.

### Session Lifecycle, Drift Detection & Empty Allowlist Policy

- **ACP mcpServers Immutability & Drift Detection**: ACP 프로토콜의 `mcpServers` 속성은 `session/new` 연결 시점의 스냅샷으로 불변(Immutable) 상태를 유지합니다. 만약 도중에 `allowedBuiltinExternalMcpServers` 구성이 변경되면 signature가 변경되어 session pool key(`{poolKey}#builtinExternalMcp={signature}`)의 drift를 감지합니다. 이 경우 기존 세션을 안전하게 연결 해제(disconnect)하고 새 세션을 생성하여 재연결(reconnect)을 수행합니다.
- **Empty Allowlist Conservation**: allowlist가 비어 있거나 선언되지 않은 경우, 별도의 signature를 부여하지 않고 기존 `poolKey`를 그대로 유지하여 불필요한 세션 폐기를 방지합니다.
