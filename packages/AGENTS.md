# Packages Doctrine

`packages/` is the Fleet first-party workspace monorepo root, containing `fleet-core` (host-agnostic domain core), `fleet-infra` (host-agnostic runtime infrastructure), `fleet-mcp-server` (generic MCP server and tool registry leaf package), `fleet-carriers` (carrier persona catalog and self-registration leaf package), `fleet-tui` (generic TUI engine), `fleet-agent` (primary CLI host), `fleet-wiki`, and `fleet-wiki-web`.

## Architecture Philosophy

The Fleet codebase is built on **four core principles**. Every contribution and review must align with these — they take precedence over micro-optimizations or local convenience.

### 1. Domain Boundary as Law

The split between `fleet-core` (host-agnostic Fleet domain) and `fleet-agent` (CLI host) is **not a guideline; it is enforced by build/grep gates**:

- `fleet-core` MUST NOT import any engine package or external agent package. The single Fleet-AI gateway lives in `fleet-agent/src/provider.ts`, which re-exports the AI surface for the rest of the host.
- `fleet-core` and `fleet-agent` may depend directly on `@sbluemin/fleet-infra` for host-agnostic auth, data-dir, job, log, and settings infrastructure.
- `fleet-agent` consumes `fleet-core` only through the **public root barrel** or documented public subpaths. Deep imports into `src/**` are forbidden.
- Host UI, host event hooks, and any host-specific lifecycle dependency belong exclusively to the `fleet-agent` side.
- When splitting a mixed module, the pure/domain half moves into `fleet-core` and only the host adapter half stays in `fleet-agent`.

### 2. Executor Pattern Only

The Admiral agent domain exposes the closed-loop callback executor surface only:

| Pattern | Surface | Lifetime | Use Case |
|---------|---------|----------|----------|
| **Closed-loop callback** | `admiral.executor.{executeWithPool, executeOneShot}` with `ExecuteOptions.onMessageChunk/onThoughtChunk/onToolCall/...` (carrier-agnostic — caller maps `poolKey`: `carrier_dispatch` resolves `poolKey` from its `carrier_id` argument and automatically promotes to multi-backend Task Force execution when the target carrier has Task Force configured) | Single carrier turn, returns `ExecResult` synchronously | `carrier_dispatch` (sole carrier delegation surface) |

Host streaming is no longer part of the `fleet-core` public agent surface. Carrier execution is routed through the executor callback path only.

### 3. Single Source of Truth (SSoT)

Several invariants are guarded by a **single owner** — duplication or shadowing is treated as a regression:

| Concept | Owner | Rationale |
|---------|-------|-----------|
| Session persistence (carrier → ACP sessionId mappings as JSONL custom entries) | `admiral/agent/internal/session-runtime.ts` | Resume/restore semantics backed by JSONL custom entries with the `fleet/carrier-session` customType. |
| Track status enum | `admiral/_shared/carrier-job-events.ts:TrackStatus` | Six values cover both panel UI and executor lifecycle. |
| MCP server URL + token routing | `packages/fleet-mcp-server` | One HTTP server, per-session Bearer tokens, FIFO routing isolated by token. |
| CLI provider catalog | `@sbluemin/fleet-unified-agent`'s `CLI_BACKENDS` | All `TASKFORCE_CLI_TYPES`, display names, colors, and reasoning capabilities derive from this. |
| Fleet tool catalog | `admiral.agent.tools.list()` backed by `packages/fleet-mcp-server` registry and explicit use-site registration | Host queries metadata + invokes through the fleet-core facade — never re-implements specs. |
| Executor MCP tool exposure | `admiral/agent/tools.ts:getExecutorMcpTools()` adapter over `packages/fleet-mcp-server` | Whitelist-only connect-time MCP exposure for `executeWithPool` / `executeOneShot`. |
| Default carrier persona catalog | `packages/fleet-carriers` | Default carrier metadata, default slots/models/efforts, persona-only constants, and module-load carrier self-registration live in the leaf package. |

### 4. Public Surface Discipline

The **only consumer-facing entry point** is the package root barrel of `@sbluemin/fleet-core`. Consumers reach `executeWithPool`, `executeOneShot`, `cleanIdle`, `disconnect`, `disconnectAll`, and `getSessionIdFor` exclusively through that barrel. Internal helpers under `admiral/agent/internal/` are never re-exported.

### Forbidden Patterns

- `globalThis.<anything>` for shared state — use module-level singletons instead.
- Push-style "ports" passed into tool execution. Tools depend on `fleet-core` services directly.
- `on*` callback parameters threaded through `fleet-core` public APIs, except executor callback options owned by `executeWithPool` / `executeOneShot`.
- Builder functions injected by hosts. Prompt assembly is fleet-core's responsibility; host adapters pass raw `userRequest` + optional `history`.

## Domain Boundary Rules

> Refer to `package AGENTS.md files` for the full cross-layer dependency rules, layer hierarchy, and verification table.

## Slash Command Naming

All slash commands registered by extensions must follow this naming convention.

### Format

```
fleet:<domain>:<feature>
```

- **All lowercase** — No uppercase letters, no underscores.
- **`:` as separator** — Use `:` between segments. Do not use `-`, `_`, or `/`.
- **Exactly 3 segments** — `fleet` prefix + domain + feature. Do not nest further.

### Domain Assignment

| Feature Area | Domain | Rationale |
|-----------|--------|-----------|
| `fleet` agent orchestration surfaces | `agent` | Sub-agent orchestration features |
| `fleet-wiki` surfaces | `wiki` | Fleet Wiki store, patch queue, ingest |
| Admiral protocol and doctrine surfaces | `admiral` | Host-agent prompt policy, protocols, and operational doctrine |
| Detached carrier job surfaces | `jobs` | Detached carrier job rendering and verbose toggle |
| Carrier registration surfaces | `carrier` | Individual carrier registration and configuration |
| HUD display surfaces | `hud` | HUD / editor display features |

### Feature Naming

- Use a **verb or noun** that describes the action or target — e.g., `status`, `editor`, `models`, `settings`.
- Prefer short, unambiguous words. Avoid abbreviations (`settings` not `cfg`, `status` not `stat`).
- `settings` — reserved for commands that open a configuration UI for that domain.
- `run` — reserved for manual re-trigger of an automated behavior.

### Conflict Prevention

- The `fleet:` prefix is **reserved for this project**. Never register commands without it.
- Domain names are shared across extensions — coordinate to avoid feature name collisions within a domain.
