---
id: "fleet-mcp-server-internal-lifecycle"
title: "MCP server lifecycle — owned by admiral/_shared/mcp.ts, surfaced via infra.toolRegistry.mcp"
tags: ["fleet-core", "mcp", "invariant", "lifecycle", "tool-registry"]
created: "2026-05-03T16:18:52.398Z"
updated: "2026-05-03T16:18:52.398Z"
version: 1
rawSourceRef: "raw/2026-05-03-fleet-mcp-server-internal-lifecycle-source.md"
---
## Invariant

The MCP HTTP server defined in `packages/fleet-core/src/admiral/_shared/mcp.ts` (FIFO queue, token isolation, HTTP-hold) is owned exclusively by fleet-core. Its lifecycle (`startMcpServer`/`stopMcpServer`) MUST NOT be exposed to consumers.

## Implementation home (unchanged)

The implementation file remains `packages/fleet-core/src/admiral/_shared/mcp.ts`. The 2026-05 4-domain unification did NOT move the file; only the public surface presentation changed.

## Public surface (4-domain shape)

After the 4-domain unification, MCP-related consumer-facing surface is grouped under `infra.toolRegistry.mcp`:

- `runtime.infra.toolRegistry.mcp.url()`
- `runtime.infra.toolRegistry.mcp.resolveNextToolCall(token, toolCallId, result)`
- `runtime.infra.toolRegistry.mcp.hasPendingToolCall(token)`
- `runtime.infra.toolRegistry.mcp.clearPendingForSession(token)`
- `McpCallToolResult` type re-exported via the same facade

`startMcpServer` and `stopMcpServer` remain internal — they are NOT part of the `infra.toolRegistry.mcp` facade slot. The server lifecycle is driven by `getFleetMcpUrl()` lazy-singleton inside fleet-core and `shutdown()` in `runtime.ts` (which calls `stopMcpServer` directly).

## Why

Multi-process MCP server start in fleet-harness-extension would break token isolation and FIFO order. MCP must be a single in-process singleton owned by fleet-core composition root.

## Re-grouping rule

The 2026-05 cleanup grouped MCP surface under `infra.toolRegistry.mcp` because tool-registry transports tool calls and MCP is its HTTP transport. Do NOT promote MCP to a top-level `infra.mcp` facade — keep it nested under `toolRegistry`.

## Migration

| AS-IS (pre-2026-05) | TO-BE |
|---------------------|-------|
| `runtime.fleet.mcp.url()` | `runtime.infra.toolRegistry.mcp.url()` |
| `runtime.fleet.mcp.resolveNextToolCall(...)` | `runtime.infra.toolRegistry.mcp.resolveNextToolCall(...)` |
| `runtime.fleet.mcp.hasPendingToolCall(...)` | `runtime.infra.toolRegistry.mcp.hasPendingToolCall(...)` |
| `runtime.fleet.mcp.clearPendingForSession(...)` | `runtime.infra.toolRegistry.mcp.clearPendingForSession(...)` |