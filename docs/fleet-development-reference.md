# Fleet Development Reference Guide

This guide explains how Fleet development is organized.

## 1. Architectural Split

Fleet development follows a hard one-way dependency graph:

- `packages/fleet-agent` — sole CLI Composition Root and host adapter
- `packages/fleet-admiralty` — multi-fleet coordination
- `packages/fleet-admiral` — single-fleet orchestration, prompts, tools, and protocols
- `packages/fleet-carriers` — carrier runtime, personas, jobs, and carrier state
- `packages/fleet-infra` — host-agnostic infrastructure and I/O gateways
- `packages/unified-agent` — independent execution engine client package

## 2. Where New Work Goes

### 2.1 `packages/fleet-agent`

Put code here when it requires terminal rendering, CLI process lifecycle management, host input routing, or concrete service assembly.

### 2.2 `packages/fleet-admiralty`

Put code here when it coordinates multiple Fleet runtimes or owns Grand Fleet status/reporting policy.

### 2.3 `packages/fleet-admiral`

Put code here when it owns single-fleet orchestration, prompt composition, MCP tool policy, or operational protocols.

### 2.4 `packages/fleet-carriers`

Put code here when it owns carrier persona metadata, carrier dispatch, carrier job surfaces, or carrier state persistence.

### 2.5 `packages/fleet-infra`

Put code here when it owns generic auth, data-dir, executor, log, settings, detached-job, or runtime I/O primitives.

## 3. Import Rules

- `fleet-agent` assembles concrete services through explicit `create*(deps)` factory calls.
- Lower packages must not import `fleet-agent` or any package above them in the dependency graph.
- Consumers use public package exports only.
- Do not deep-import `src/**` or `internal/**` across package boundaries.

## 4. State Synchronization

Fleet supports multiple concurrent instances sharing the same `states.json` file via a `_generation` token and file locks. Developers must avoid hidden process-global state and use explicit service instances plus pull-based resolvers.
