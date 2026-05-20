# Migration Guide: @sbluemin/fleet-mcp-server

This guide outlines the steps to migrate from the internal `fleet-core` tool registry and MCP logic to the standalone `@sbluemin/fleet-mcp-server` package.

## Context

The MCP server and tool registry internals have been extracted from `packages/fleet-core` into a dedicated leaf package, `@sbluemin/fleet-mcp-server`. This move enforces a clean boundary between the Fleet domain and the MCP transport layer.

## Key Changes

### 1. Import Path Migration

All generic MCP types, registry functions, and server lifecycle methods must now be imported from `@sbluemin/fleet-mcp-server`.

**Before:**
```typescript
import { registerAgentTool } from "./admiral/agent/tools.js";
import { AgentToolSpec } from "./admiral/agent/types.js";
```

**After:**
```typescript
import { registerAgentTool, AgentToolSpec } from "@sbluemin/fleet-mcp-server";
```

### 2. SSoT for Tool Specs

The `AgentToolSpec` interface is now owned by the leaf package. It remains the Single Source of Truth for both doctrine (prompts) and execution.

- Legacy interfaces like `ToolPromptManifest`, `AgentToolPiDescriptor`, and `AgentToolMcpDescriptor` have been **removed**.
- The `tag` field is now mandatory and strictly enforced (must match `[a-z0-9_]+`).

### 3. Server Lifecycle Management

The MCP server is now a singleton managed via `startMcpServer()` and `stopMcpServer()`.

- `fleet-core` manages MCP server startup and cleanup through its lifecycle boot/shutdown path.
- The fleet-core shutdown handle explicitly calls `stopMcpServer()`.

### 4. Hardening and Invariants

The new package introduces strict hardening policies that were previously loosely enforced:

- **FIFO Requirement**: You **must** resolve tool calls in the order they arrived for a given session. Any mismatch will result in a runtime error.
- **Body Caps**: Requests exceeding 1 MiB will be rejected with a `413 Payload Too Large` status.
- **Timeouts**: The default tool call timeout is now capped at **5 minutes**.

## Migration Steps

1. **Update `package.json`**: Add `@sbluemin/fleet-mcp-server` to your workspace dependencies (typically via `pnpm add -w @sbluemin/fleet-mcp-server` or linking in `pnpm-workspace.yaml`).
2. **Search and Replace Imports**: Update all import references pointing to legacy `fleet-core` registry files (e.g., `admiral/agent/tools.ts`, `infra/tool-registry/*`).
3. **Verify Tool Specs**: Ensure all `AgentToolSpec` objects have a valid `id` and `tag`.
4. **Audit Resolution Logic**: If you were manually resolving tool calls, ensure your logic honors the FIFO invariant.
