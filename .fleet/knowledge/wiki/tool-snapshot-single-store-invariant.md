---
id: "tool-snapshot-single-store-invariant"
title: "Tool snapshot store SSoT — packages/fleet-core/src/infra/tool-registry/tool-snapshot.ts (path updated 2026-05)"
tags: ["fleet-core", "pi-fleet-extension", "tool-snapshot", "mcp", "invariant", "trap"]
created: "2026-05-03T16:19:27.125Z"
updated: "2026-05-03T16:19:27.125Z"
version: 1
rawSourceRef: "raw/2026-05-03-tool-snapshot-single-store-invariant-source.md"
---
## Invariant

The tool snapshot store globalThis surface lives in **one place only**:

`packages/fleet-core/src/infra/tool-registry/tool-snapshot.ts`

The MCP HTTP server (`packages/fleet-core/src/admiral/_shared/mcp.ts`) reads from this store. pi-fleet-extension MUST NOT re-implement, copy, or shadow this store.

## Path update — 2026-05

The 2026-05 services-to-infra rename moved the file from `src/services/tool-registry/tool-snapshot.ts` to `src/infra/tool-registry/tool-snapshot.ts`. Imports and AGENTS.md references were updated repo-wide. Old `src/services/tool-registry/...` paths are stale and should not appear in any documentation, code, or wiki entry.

## Public surface (after 4-domain unification)

Consumer access flows through:

- `runtime.infra.toolRegistry.snapshot.*` — facade-grouped reads/writes
- `runtime.infra.toolRegistry.registry.*` — manifest registration
- Internal `tool-snapshot.ts` exports remain stable: `registerToolsForSession`, `getToolsForSession`, `getToolNamesForSession`, `removeToolsForSession`, `clearAllTools`, `computeToolHash`, `convertToolSchema`.

## Why a single store

Token isolation and FIFO routing in MCP depend on a single in-process `Map<sessionToken, RegisteredTool[]>`. A duplicate store in pi-fleet-extension would cause MCP tool calls to dispatch to the wrong session.

## Trap

Do NOT copy snapshot state into pi-fleet-extension panel/view-model layer. Read it through `runtime.infra.toolRegistry.snapshot` instead.

## Reference

See companion entry `fleet-mcp-server-internal-lifecycle` for MCP lifecycle ownership and `fleet-core-public-services-4-domain-architecture` for the four-domain runtime context.