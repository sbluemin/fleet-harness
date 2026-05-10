# Admiral Domain Doctrine

`packages/fleet-core/src/admiral/` is the Admiral-owned Fleet orchestration/runtime module home — carrier operations, agent session management, task force coordination, and protocol policy.

## Fleet Architecture (Metaphor)

This project is an **Agent Harness** that centrally commands and orchestrates powerful CLI tools (Claude Code, Codex, Gemini, etc.), each of which possesses its own internal sub-agent system.

Beyond simple parallel API calls, the system adopts a **naval fleet metaphor** to clearly separate roles and responsibilities across the architecture.

### Core Entities

| Layer | Entity | Metaphor | Definition |
|-------|--------|----------|------------|
| 1 | **Admiral of the Navy** (ATN) | 대원수 (User) | **The user** who wields the tool. Sets ultimate strategy and final objectives for the fleet. |
| 2 | **Fleet Admiral** | 사령관 (Grand Fleet) | The **Admiralty LLM persona** (internalized domain in `fleet-core`). Responsible for multi-fleet orchestration. *Does not exist in single-fleet mode; the user communicates directly with the Admiral.* |
| 3 | **Admiral** | 제독 (Host PI) | A single **workspace PI instance**. Plans operations and dispatches Carriers within its operational zone. |
| 4 | **Captain** | 함장 (Carrier Persona) | The **persona of a Carrier agent**. While a Carrier is the system entity, the Captain is its personified commander. |

> **Note on Persona & Tone**: The naming conventions, personified personas, and linguistic tone for all tiers are centrally managed by `packages/fleet-core/src/metaphor/`. The former `packages/fleet-harness-extension/src/metaphor/` legacy directory has been removed and must not be recreated as a Pi-side domain home.

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

`carrier_taskforce` accepts every CLI provider registered in `CLI_BACKENDS` (Single Source of Truth). The current whitelist contains **6 backends**:

| CLI Type | Display Name | Notes |
|----------|--------------|-------|
| `claude` | Claude Code | Anthropic-hosted Claude (default) |
| `claude-zai` | Claude Code with Z.AI GLM | Claude bridge with Z.AI base URL |
| `claude-kimi` | Claude Code with Moonshot Kimi | Claude bridge with Moonshot base URL |
| `codex` | Codex | OpenAI Codex (`codex-app-server`) |
| `gemini` | Gemini | Google Gemini CLI |
| `opencode-go` | OpenCode | OpenCode Go CLI |

- `TaskForceCliType` is an alias of `CliType`; `TASKFORCE_CLI_TYPES` is auto-derived via `Object.keys(CLI_BACKENDS) as CliType[]` in `packages/fleet-core/src/admiral/taskforce/types.ts`.
- Tool description copy (`TASKFORCE_CONFIGURE_HINT`, `[carrier:result]` backend label examples) and overlay colors (`CARRIER_COLORS`) are derived from `CLI_BACKENDS × CLI_DISPLAY_NAMES`. Adding a new entry to `CLI_BACKENDS` automatically extends Task Force without touching prompts or the overlay.
- **Persona × CLI compatibility is allowed**: any registered carrier persona may pair with any of the six CLI backends. Configure pairings via Carrier Status (Alt+O → T) per carrier.
- Providers without supported reasoning effort follow the existing Gemini pattern (`effort.supported = false`) and surface no effort/budget controls in the configuration overlay.

## Fleet Architecture (Sub-agent Workflow)

- **Sub-agents are fully independent** — PI provides only background, objectives, and constraints. Never prescribe implementation details.
- **Sub-agents are unaware of each other** — Cross-analysis is performed solely by PI after all responses are collected.
- **Communication layer**: Pi consumers invoke `executeWithPool()` / `executeOneShot()` from the `@sbluemin/fleet-core` root barrel (callback-pattern executor); the streaming `streamAcp` adapter consumes `admiral.session.*` + `admiral.events.*`. Both paths terminate at ACP stdio (all CLIs share the protocol).
