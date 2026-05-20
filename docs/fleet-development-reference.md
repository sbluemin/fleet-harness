# Fleet Development Reference Guide

This guide explains how Fleet development is organized.

## 1. Architectural Split

Fleet development follows a hard split:

- `packages/fleet-core` — host-agnostic Fleet product core
- `packages/fleet-agent` — primary Fleet CLI host (fleet)
- `packages/unified-agent` — core execution engine

## 2. Where New Work Goes

### 2.1 `packages/fleet-core`

Put code here when it is:
- pure orchestration or domain logic
- prompt composition
- state/store logic
- runtime contracts, ports, pure controllers, or public APIs

### 2.2 `packages/fleet-agent`

Put code here when it requires:
- terminal rendering or TUI components (`fleet-tui`)
- CLI process lifecycle management
- host-specific input routing

## 3. Domain Layout Map

| Home / Entrypoint | Responsibility |
|-------------------|----------------|
| `packages/fleet-agent/src/runtime/` | Host runtime assembly and lifecycle |
| `packages/fleet-agent/src/dedicated-cli/` | Dedicated CLI process management |
| `packages/fleet-agent/src/carrier-status/` | Carrier status and Job Bar TUI |
| `packages/fleet-core/admiral/` | Agent orchestration, tools, and protocols |
| `packages/fleet-wiki/` | Knowledge base, ingest, and patching |

## 4. Import Rules

- Host packages (`fleet-agent`) consume `fleet-core` through public exports.
- `fleet-core` must not import host-specific packages.
- `@sbluemin/fleet-unified-agent` is the primary engine dependency.
- Do not deep-import `src/**` or `internal/**` across package boundaries.

## 5. State Synchronization

Fleet supports multiple concurrent instances sharing the same `states.json` file via a `_generation` token and `fs.watch`. Developers must avoid in-memory caches for state-derived values and use pull-based resolvers.
