# Admiral Workflow Reference

This document is the operational doctrine for agents working inside this repository.

## 1. Architecture State

- `runtime/fleet-console/cli` owns the thin `fleet` launcher Composition Root inside `@dotobokuri/fleet-console`: argv/process lifecycle, one in-process Fleet MCP (Wiki + `gateway_models`), an ephemeral loopback AI Gateway, and a Claude Code child with inherited stdio; it consumes single-fleet Admiral policy from `@dotobokuri/fleet-admiral`.
- `packages/core-agent` owns the host-agnostic one-shot executor/session/model runtime engine (`executeOneShot`, which builds a fresh provider client per call and resumes only via a caller-supplied session id), the builtin external MCP catalog, Fleet-domain-agnostic in-process MCP server primitives, and the shared register data contract.
- `packages/core-infra` owns host-agnostic auth, data-dir resolution, data-dir/settings, and the durable `fs-store` I/O primitives.
- `runtime/fleet-console` owns the standalone loopback Console Service: CLI register ingest, REST/SSE/WebSocket, Terminal PTY/provider/plugin runtime, durable state, and static UI.
- `runtime/fleet-desktop` is an optional Electron main-process shell that supervises the Console Service's separately packaged standard Node sidecar and loads `/console/`; it never owns duplicate UI, server, PTY, plugin, provider, or state code.

## 2. Ownership Model

The `fleet` launcher (under `runtime/fleet-console/cli`) owns:
- Thin argv dispatch and process lifecycle for Claude Code passthrough, `fleet auth`, `fleet update`, and `fleet console`.
- One in-process Fleet MCP (Wiki + `gateway_models`) and an ephemeral loopback AI Gateway for the Claude child.
- Host adapters that consume Admiral prompt/protocol/tool policy from `@dotobokuri/fleet-admiral`.
- Concrete runtime assembly in `cli/runtime/runtime.ts`.

It must not own PTY, TUI, terminal I/O interception, host-agnostic infrastructure internals, or generic MCP transport internals.

## 3. Allowed Dependency Direction

```text
@dotobokuri/fleet-console
  (package-local: cli/ thin fleet launcher + Console service)
  -> fleet-admiral
  -> core-agent
  -> core-infra
  -> fleet-wiki

core-agent / core-infra
  -> core-agent
```

Forbidden patterns:
- Lower packages importing a runtime host (`runtime/fleet-console` or `runtime/fleet-desktop`).
- Recreating deleted compatibility packages or namespace facades.
- Deep-importing package `src/**` or `internal/**` across package boundaries.

## 4. Operational Guidance For Agents

1. Ask whether the behavior belongs to host assembly, generic infrastructure, or generic MCP transport.
2. Keep Admiral runtime policy under `packages/fleet-admiral`; use `assets/hooks/` and `assets/skills/` only as the embedded hook and skill authoring sources.
3. Keep runtime boot order explicit in `runtime/fleet-console/cli/runtime/runtime.ts`.
4. Use the embedded `professional-pushback` skill when a requested approach has a material technical flaw and `delegation` to plan the smallest useful evidence graph and integrate its results.
5. Keep Fleet pin syntax out of the semantic skill, but require the roster lookup there: the skill's preflight makes the host call `gateway_models` itself, and per-dispatch identity choice is the skill's semantic policy — no pre-dispatch hook judges a pin. Never gate a hook on `Skill(<name>)` — Claude Code evaluates `if` as a permission rule whose content match needs the tool's `preparePermissionMatcher`, which the Skill tool lacks, so such a hook is silently skipped forever.
6. Keep graph mechanics in the live Workflow tool contract rather than repeating them in the skill; after meaningful returns, prune branches that can no longer change the host decision.
7. Keep implementation on the host by default; delegate only fully specified, mechanical, disjoint, independently checkable batches in isolated worktrees.
8. Keep Workflow-receipt handling in the model guard hook; do not duplicate it in a skill.
9. For mutating runs, inspect actual diffs and changed files against the settled host decisions before acceptance.

## 5. Compatibility Invariants

Preserve:
- Slash command names.
- Detached-job acceptance vs completion-push distinction.
- MCP/provider FIFO and archive behavior.
- Multi-instance state integrity for shared durable state.

## 6. Console Self-Update Operations

Fleet Console UI and `fleet update` update only the sole published package `@dotobokuri/fleet-console`. Operators and contributors should keep the following behavioral facts in mind:

- **Local builds are rejected.** The `POST /api/v1/updates/apply` route returns `403` for unpublished/local builds (for example `pnpm console` or `tsx` runs). Self-update only works against globally installed npm packages.
- **Update applies immediately.** The update route accepts the request regardless of active terminal sessions; the running PTY sessions are not terminated before the update proceeds.
- **Preflight before stop.** A writable global `npm`/`pnpm` install that owns the current package is resolved *before* anything is torn down — first server-side (the `POST /api/v1/updates/apply` route returns `503` and never spawns a worker when no usable, writable global manager is found) and again inside the detached worker. A preflight failure leaves the running console untouched, so the operator can install by hand; the server-side rejection surfaces as the `503` response rather than a worker file. Only failures that occur after preflight — for example a `node-pty` native rebuild during the install step, which runs once the old server has begun stopping — produce the worker status/log files described below.
- **Failure recovery is file-based.** The detached worker writes a JSON status file and a plain-text log file under the console data directory. If the worker fails before the new server starts, inspect those files; do not rely on browser state.
- **New server, new random port.** After a successful install the worker stops the old server and starts a fresh one on a new OS-assigned loopback port, then opens that URL in a browser. The previous tab is intentionally not reused or auto-reloaded.
- **One host package.** `@dotobokuri/fleet-console` is the sole published host and owns both bins; update only that package for the runtime and bins.

### Desktop supervision

Desktop ownership metadata is provenance, not a Console channel. `POST /api/v1/updates/apply` retains the global-package worker; managed `console/latest` updates stay in Desktop's hardened relaunch installer until a recoverable same-window handoff exists. Electron exposes pairing through the macOS app menu or Windows/Linux tray, while Desktop owns the local no-JavaScript input modal. Pairing identity is discovery rather than authentication; the user's exact loopback address remains the trust decision. Release automation keeps the GitHub Release draft until supported assets and required verification/signing gates pass. macOS requires the configured Developer ID/notarization path, Windows requires the configured Authenticode path, and Linux AppImage integrity is checksum/GPG material when release credentials provide it; do not claim an unavailable local signing identity as a signed release.
