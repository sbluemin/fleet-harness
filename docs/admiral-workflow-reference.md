# Admiral Workflow Reference

This document is the operational doctrine for Admiral and Carrier agents working inside this repository.

## 1. Architecture State

- `runtime/fleet-cli` owns the CLI host and Composition Root, consumes single-fleet Admiral policy from `@dotobokuri/fleet-admiral`, and owns one in-process MCP HTTP/JSON-RPC server per CLI process plus the console register publisher.
- `packages/fleet-carriers` owns carrier personas, dispatch, carrier jobs (including detached jobs), store, and carrier runtime state.
- `packages/core-agent` owns the host-agnostic executor/session/model runtime engine (`executeWithPool` / `executeOneShot`), the builtin external MCP catalog, Fleet-domain-agnostic in-process MCP server primitives, and the shared register data contract.
- `packages/core-unified-agent` owns the unified ACP CLI backend client engine and the `CLI_BACKENDS` provider catalog.
- `packages/fleet-infra` owns host-agnostic auth, data-dir resolution, global options, and the durable `fs-store` I/O primitives.
- `runtime/fleet-console` owns the standalone loopback HTTP backend for CLI register ingest, observer SSE, terminal WebSocket, and static console serving for a single workspace.

## 2. Ownership Model

`fleet-cli` owns:
- CLI lifecycle registration and agent CLI launch.
- TUI rendering, overlays, widgets, and host input routing.
- Host adapters that consume Admiral prompt/protocol/tool policy from `@dotobokuri/fleet-admiral`.
- Concrete runtime assembly in `src/runtime/runtime.ts`.

`fleet-cli` must not own carrier persona catalogs, host-agnostic infrastructure internals, or generic MCP transport internals.

## 3. Allowed Dependency Direction

```text
fleet-cli
  -> fleet-admiral
  -> fleet-carriers
  -> core-agent
  -> fleet-infra
  -> fleet-console
  -> fleet-wiki / fleet-console Codex surface

core-agent / fleet-carriers / fleet-infra
  -> core-unified-agent
```

Forbidden patterns:
- Lower packages importing `fleet-cli`.
- Recreating deleted compatibility packages or namespace facades.
- Deep-importing package `src/**` or `internal/**` across package boundaries.

## 4. Operational Guidance For Agents

1. Ask whether the behavior belongs to host assembly, carrier runtime, generic infrastructure, or generic MCP transport.
2. Put Admiral prompt/protocol/tool policy in `packages/fleet-admiral/src/**`.
3. Put carrier persona/runtime behavior in `packages/fleet-carriers`.
4. Keep runtime boot order explicit in `runtime/fleet-cli/src/runtime/runtime.ts`.
5. For operational work, let the protocol gate select exactly one protocol skill: trivial, standard, high-risk, or multi-agent.
6. Follow the active protocol's declared checkpoints. Trivial has none and uses Mission Anchor Compact Mode.
7. Use the reduced protocol cadence: emit `brief: <...>` after readiness checks and `status: executing` when execution begins.
8. Apply Context Confidence at the active protocol's planning boundary: standard requires sufficient confidence; high-risk and multi-agent require complete confidence.
9. Let Result Integrity route verification loops: received results get relevance/completeness/conflict checks, mutating finalized jobs run the Artifact Inspection Gate, speculation goes to Deep Dive, and contradictions with verified facts re-enter Context Confidence.
10. For mutating carrier jobs, inspect actual artifacts before acceptance: use the `carrier_jobs` summary manifest, direct git diff, and changed files against the dispatch intent and Mission Objective. Read-only jobs skip this gate and route claims through Deep Dive.
11. Run `pnpm check:protocol-sync` after changing protocol gate text, protocol skill assets, or report-token grammar.

## 5. Compatibility Invariants

Preserve:
- Slash command names.
- Carrier completion push semantics.
- Detached-job acceptance vs completion-push distinction.
- MCP/provider FIFO and archive behavior.
- Multi-instance state integrity for shared `carriers.json`.
