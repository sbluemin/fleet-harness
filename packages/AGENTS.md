# Packages Doctrine

`packages/` is the Fleet first-party workspace monorepo root, containing `fleet-infra` (host-agnostic runtime infrastructure), `fleet-mcp-server` (generic MCP server and tool registry leaf package), `fleet-admiral` (Admiral prompt and Fleet tool policy package), `fleet-carriers` (carrier persona catalog plus carrier runtime package), `fleet-tui` (Fleet TUI engine and shared brand-style hub, exposing `./core`, `./components`, `./layout`, `./primitives`, and `./style`), `fleet-cli` (primary CLI host), `fleet-wiki`, and `fleet-wiki-ui`.

## Architecture Philosophy

The Fleet codebase is built on **five core principles**. Every contribution and review must align with these — they take precedence over micro-optimizations or local convenience.

### 1. Domain Boundary as Law

The final Fleet graph is layered and enforced by build/grep gates:

- `fleet-cli` owns host assembly and consumes `@dotobokuri/fleet-admiral` for single-fleet Admiral policy.
- `fleet-cli` assembles `fleet-infra`, `fleet-carriers`, and `fleet-mcp-server` through direct leaf service calls.
- `fleet-cli` consumes `fleet-admiral`, `fleet-carriers`, `fleet-infra`, and `fleet-mcp-server` through public package surfaces only.
- Host UI, host event hooks, and any host-specific lifecycle dependency belong exclusively to the `fleet-cli` side.
- Mixed modules must keep host adapters in `fleet-cli` and domain policy in the owning Fleet package.

### 2. Executor Pattern Only

The Admiral agent domain exposes the closed-loop callback executor surface only:

| Pattern | Surface | Lifetime | Use Case |
|---------|---------|----------|----------|
| **Closed-loop callback** | `@dotobokuri/fleet-infra/agent` `executeWithPool` / `executeOneShot` with `ExecuteOptions.onMessageChunk/onThoughtChunk/onToolCall/...` (carrier-agnostic — caller maps `poolKey`: `carrier_dispatch` resolves `poolKey` from its `carrier_id` argument and automatically promotes to multi-backend Task Force execution when the target carrier has Task Force configured) | Single carrier turn, returns `ExecResult` synchronously | `carrier_dispatch` (sole carrier delegation surface) |

Host streaming is not part of the Fleet orchestration public agent surface. Carrier execution is routed through the executor callback path only.

### 3. Single Source of Truth (SSoT)

Several invariants are guarded by a **single owner** — duplication or shadowing is treated as a regression:

| Concept | Owner | Rationale |
|---------|-------|-----------|
| Carrier session reuse | `packages/fleet-infra/src/agent/internal/executor-engine.ts` | Live carrier session reuse is in-process executor pool state keyed by `poolKey`; it is not persisted through JSONL custom entries or host adapters. |
| Track status enum | `packages/fleet-infra/src/agent/types.ts:TrackStatus` | Six values cover both panel UI and executor lifecycle; `fleet-carriers` re-exports it for carrier job event compatibility. |
| MCP server URL + token routing | `packages/fleet-mcp-server` | Two independent HTTP servers (`fleet-carriers` and `fleet-wiki`), each with per-session Bearer tokens and FIFO routing isolated by token. |
| CLI provider catalog | `@dotobokuri/fleet-unified-agent`'s `CLI_BACKENDS` | All `TASKFORCE_CLI_TYPES`, display names, colors, and reasoning capabilities derive from this. |
| Fleet tool catalog | `packages/fleet-admiral/src/tools.ts` backed by `packages/fleet-mcp-server` registry and explicit use-site registration | Host queries metadata + invokes through the new package facades — never re-implements specs. |
| Executor MCP tool exposure | `packages/fleet-admiral/src/tools.ts:getExecutorMcpTools()` adapter over `packages/fleet-mcp-server` | Whitelist-only connect-time MCP exposure for `executeWithPool` / `executeOneShot`. |
| Executor runtime engine and builtin external MCP catalog | `packages/fleet-infra/src/agent/` | Host-agnostic runtime owns pool/session/model/external-MCP infrastructure; `fleet-cli` registers the two-method `ExecutorPort` at boot. |
| Default carrier persona catalog and carrier runtime | `packages/fleet-carriers` | Default carrier metadata, dispatch, detached job infrastructure, carrier jobs, store, stream events, runtime constants, and explicit default carrier registration live in the carrier package. |

### 4. Public Surface Discipline

Consumers use public package root barrels: `@dotobokuri/fleet-admiral` for Admiral prompt/tool policy, `@dotobokuri/fleet-carriers` for carrier runtime, `@dotobokuri/fleet-infra` for infrastructure, and `@dotobokuri/fleet-mcp-server` for generic MCP registry/server APIs. The implementation is re-exported from `@dotobokuri/fleet-infra/agent`; internal helpers under `packages/fleet-infra/src/agent/internal/` are never consumer imports.

### 5. DI Factory Discipline

Dependency injection is expressed only through pure factory functions with explicit dependency objects:

```ts
createThing(deps): ThingInterface
```

- Use the `create*(deps): Interface` pattern for new injectable domains and services.
- Keep factories pure: dependencies enter through `deps`, and the factory returns the declared interface without hidden host lookups or global registries.
- Do not introduce DI containers or DI frameworks, including Inversify, tsyringe, or equivalent service-locator frameworks.
- Preserve this pattern for injectable services without recreating deleted compatibility packages.

### Forbidden Patterns

- `globalThis.<anything>` or module-level mutable singletons for shared runtime state — use explicit service instances returned by `create*(deps)` factories instead.
- Push-style "ports" passed into tool execution. Tools depend on explicit Fleet service APIs directly.
- `on*` callback parameters threaded through Fleet public APIs, except executor callback options owned by `executeWithPool` / `executeOneShot`.
- Builder functions injected by hosts. Prompt assembly is `@dotobokuri/fleet-admiral` responsibility; host adapters pass raw `userRequest` + optional `history`.
- `fleet-carriers` importing upper-layer packages; dependencies flow one way from `fleet-cli` down to `fleet-infra`.
- DI containers, decorator-based injection, and service-locator frameworks are forbidden; use explicit `create*(deps): Interface` factories instead.

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
