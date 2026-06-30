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

## 6. Console Self-Update Operations

The Fleet Console can update both `fleet-cli` and `fleet-console` globally through its own UI. Operators and contributors should keep the following behavioral facts in mind:

- **Local builds are rejected.** The `POST /update/apply` route returns `403` for unpublished/local builds (for example `pnpm fleet-console` or `tsx` runs). Self-update only works against globally installed npm packages.
- **Update applies immediately.** The update route accepts the request regardless of active terminal sessions; the running PTY sessions are not terminated before the update proceeds.
- **Preflight before stop.** A writable global `npm`/`pnpm` install that owns the current package is resolved *before* anything is torn down — first server-side (the `POST /update/apply` route returns `503` and never spawns a worker when no usable, writable global manager is found) and again inside the detached worker. A preflight failure leaves the running console untouched, so the operator can install by hand; the server-side rejection surfaces as the `503` response rather than a worker file. Only failures that occur after preflight — for example a `node-pty` native rebuild during the install step, which runs once the old server has begun stopping — produce the worker status/log files described below.
- **Failure recovery is file-based.** The detached worker writes a JSON status file and a plain-text log file under the console data directory. If the worker fails before the new server starts, inspect those files; do not rely on browser state.
- **New server, new random port.** After a successful install the worker stops the old server and starts a fresh one on a new OS-assigned loopback port, then opens that URL in a browser. The previous tab is intentionally not reused or auto-reloaded.
- **Version parity risk.** `fleet-cli` and `fleet-console` are updated as a matched pair from the same latest release. A partial update (for example a global `fleet-cli` install without the matching `fleet-console`) can leave cross-package interfaces out of sync; always update both packages together.
