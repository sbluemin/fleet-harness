# Packages Doctrine

`packages/` is the Fleet first-party workspace monorepo root, containing `core-agent`, `core-unified-agent`, `fleet-infra`, `fleet-admiral`, `fleet-carriers`, and `fleet-wiki`. The `fleet-cli` and `fleet-console` workspaces live under `runtime/`.

## Architecture Philosophy

The Fleet codebase is built on **five core principles**. Every contribution and review must align with these — they take precedence over micro-optimizations or local convenience.

### 1. Domain Boundary as Law

The final Fleet graph is layered and enforced by build/grep gates:

- `fleet-cli` owns host assembly and consumes `@dotobokuri/fleet-admiral` for single-fleet Admiral policy.
- `fleet-cli` assembles `core-agent`, `fleet-infra`, and `fleet-carriers` through direct leaf service calls.
- `fleet-cli` consumes `fleet-admiral`, `fleet-carriers`, `core-agent`, and `fleet-infra` through public package surfaces only.
- Host UI, host event hooks, and any host-specific lifecycle dependency belong exclusively to the `fleet-cli` side.
- The embedded TUI engine under `src/tui/` is owned exclusively by `fleet-cli`.
- Mixed modules must keep host adapters in `fleet-cli` and domain policy in the owning Fleet package.

### 2. Executor Pattern Only

The Admiral agent domain exposes the closed-loop callback executor surface only:

| Pattern | Surface | Lifetime | Use Case |
|---------|---------|----------|----------|
| **Closed-loop callback** | `@dotobokuri/core-agent` `executeWithPool` / `executeOneShot` with `ExecuteOptions.onMessageChunk/onThoughtChunk/onToolCall/...` (carrier-agnostic — caller maps `poolKey`: `carrier_dispatch` resolves `poolKey` from its `carrier_id` argument and automatically promotes to multi-backend Task Force execution when the target carrier has Task Force configured) | Single carrier turn, returns `ExecResult` synchronously | `carrier_dispatch` (sole carrier delegation surface) |

Host streaming is not part of the Fleet orchestration public agent surface. Carrier execution is routed through the executor callback path only.

### 3. Single Source of Truth (SSoT)

Several invariants are guarded by a **single owner** — duplication or shadowing is treated as a regression:

| Concept | Owner | Rationale |
|---------|-------|-----------|
| Carrier session reuse | `packages/core-agent/src/internal/executor-engine.ts` | Live carrier session reuse is in-process executor pool state keyed by `poolKey`; it is not persisted through JSONL custom entries or host adapters. |
| Track status enum | `packages/core-agent/src/types.ts:TrackStatus` | Six values cover both panel UI and executor lifecycle; `fleet-carriers` re-exports it for carrier job event compatibility. |
| In-process MCP server primitives + register data contract | `packages/core-agent/src/` | Core-agent owns generic loopback HTTP/JSON-RPC MCP primitives, executor session management, and CLI register/event data shapes. Fleet callers own server assembly, IDs, lifecycle policy, and any browser-facing token exposure. |
| CLI provider catalog | `@dotobokuri/core-unified-agent`'s `CLI_BACKENDS` | All `TASKFORCE_CLI_TYPES`, display names, and reasoning capabilities derive from this; host presentation colors live in `runtime/fleet-cli/src/styles/`. |
| Fleet tool catalog | `packages/fleet-admiral/src/tools.ts` backed by `packages/core-agent` registry and explicit use-site registration | Host queries metadata + invokes through the new package facades — never re-implements specs. |
| Executor MCP tool exposure | `packages/fleet-admiral/src/tools.ts:getExecutorMcpTools()` adapter over `packages/core-agent` | Whitelist-only connect-time MCP exposure for `executeWithPool` / `executeOneShot`. |
| Executor runtime engine and builtin external MCP catalog | `packages/core-agent/src/` | Host-agnostic runtime owns pool/session/model/external-MCP infrastructure; `fleet-cli` registers the two-method `ExecutorPort` at boot. |
| Durable filesystem I/O primitive | `packages/fleet-infra/src/fs-store/` | Atomic writes, advisory directory locks with quarantine-based stale recovery, and secure filesystem guards. Consumed by preset, auth, and carriers storage through explicit DI factories. |
| Default carrier persona catalog and carrier runtime | `packages/fleet-carriers` | Default carrier metadata, dispatch, detached job infrastructure, carrier jobs, store, stream events, runtime constants, and explicit default carrier registration live in the carrier package. |

### 4. Public Surface Discipline

Consumers use public package root barrels: `@dotobokuri/fleet-admiral` for Admiral prompt/tool policy, `@dotobokuri/fleet-carriers` for carrier runtime, `@dotobokuri/fleet-infra` for infrastructure, and `@dotobokuri/core-agent` for generic agent executor and tool registry APIs. Internal helpers under `packages/core-agent/src/internal/` are never consumer imports.

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

### Core Package Doctrine

- `core-*` means Fleet-domain-agnostic.
- `core-* -> fleet-*` dependencies are forbidden in runtime, dev, test, and manifest dependencies.
- `core-* -> core-*` dependencies are allowed.
- `fleet-* -> core-*` dependencies are allowed.
- Package names use `@dotobokuri/core-<domain>`.
- Core packages expose a single root barrel unless an explicit plan approves otherwise.
- `pnpm check:core-boundary` is the CI/local grep gate for core package manifests.

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
