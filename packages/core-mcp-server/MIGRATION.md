# Migration Guide: @dotobokuri/core-mcp-server

This guide outlines the steps to migrate from the internal `fleet-admiral` tool registry and MCP logic to the standalone `@dotobokuri/core-mcp-server` package.

## Context

The MCP server and tool registry internals have been extracted from `packages/fleet-admiral` into a dedicated leaf package, `@dotobokuri/core-mcp-server`. This move enforces a clean boundary between the Fleet domain and the MCP transport layer.

## Key Changes

### 1. Import Path Migration

All generic MCP types, registry functions, and server lifecycle methods must now be imported from `@dotobokuri/core-mcp-server`.

**Before:**
```typescript
import { registerAgentTool } from "./legacy/agent/tools.js";
import { AgentToolSpec } from "./legacy/agent/types.js";
```

**After:**
```typescript
import { registerAgentTool, AgentToolSpec } from "@dotobokuri/core-mcp-server";
```

### 2. SSoT for Tool Specs

The `AgentToolSpec` interface is now owned by the leaf package. It remains the Single Source of Truth for both doctrine (prompts) and execution.

- Legacy interfaces like `ToolPromptManifest`, `AgentToolPiDescriptor`, and `AgentToolMcpDescriptor` have been **removed**.
- The `tag` field is now mandatory and strictly enforced (must match `[a-z0-9_]+`).

### 3. Server Lifecycle Management

The MCP server is now a singleton managed via `startMcpServer()` and `stopMcpServer()`.

- `fleet-admiral` manages MCP server startup and cleanup through its lifecycle boot/shutdown path.
- The fleet-admiral shutdown handle explicitly calls `stopMcpServer()`.

### 4. Hardening and Invariants

The new package introduces strict hardening policies that were previously loosely enforced:

- **FIFO Requirement**: You **must** resolve tool calls in the order they arrived for a given session. Any mismatch will result in a runtime error.
- **Body Caps**: Requests exceeding 1 MiB will be rejected with a `413 Payload Too Large` status.
- **Timeouts**: The default tool call timeout is now capped at **5 minutes**.

## Migration Steps

1. **Update `package.json`**: Add `@dotobokuri/core-mcp-server` to your workspace dependencies (typically via `pnpm add -w @dotobokuri/core-mcp-server` or linking in `pnpm-workspace.yaml`).
2. **Search and Replace Imports**: Update all import references pointing to legacy `fleet-admiral` registry files (e.g., `admiral/agent/tools.ts`, `infra/tool-registry/*`).
3. **Verify Tool Specs**: Ensure all `AgentToolSpec` objects have a valid `id` and `tag`.
4. **Audit Resolution Logic**: If you were manually resolving tool calls, ensure your logic honors the FIFO invariant.
