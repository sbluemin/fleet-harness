# @dotobokuri/core-mcp-server

A leaf workspace package for generic Model Context Protocol (MCP) HTTP server, tool registry, and session-scoped routing primitives.

## Overview

`@dotobokuri/core-mcp-server` provides a robust, session-aware implementation of the MCP JSON-RPC 2.0 protocol over HTTP. It is designed to be a "leaf" package—purely focused on MCP transport and tool management without dependencies on any host domain or runtime.

## Key Features

- **Generic Tool Registry**: A unified registry for `AgentToolSpec` objects that combine doctrine (prompts) and execution (logic).
- **Session-Scoped Routing**: Concurrent MCP sessions isolated by Bearer tokens, featuring FIFO tool-call queues and result pre-queuing.
- **HTTP Transport**: Stateless JSON-RPC over HTTP with keepalive (chunked) support for long-running tool calls.
- **Hardening by Design**: Built-in protection against payload flooding, slow-loris attacks, and stale session state.
- **Executor Integration**: Specialized whitelisting and lazy resolution for scope-tier executor sessions.

## Public API

### Server Lifecycle
- `startMcpServer(): Promise<string>`: Boots the HTTP server on a random port with an opaque path. Returns the full MCP URL.
- `stopMcpServer(): Promise<void>`: Gracefully shuts down the server, terminates all pending calls, and clears all internal state.

### Tool Registry
- `registerAgentTool(spec: AgentToolSpec): void`: Registers a tool for global doctrine and invocation.
- `registerExecutorTool(spec: AgentToolSpec, options?: { allowedScopes?: string[] }): void`: Registers a tool and whitelists it for scope executor sessions.
- `invoke(name: string, args: unknown, ctx?: Partial<AgentToolCtx>): Promise<McpCallToolResult>`: Directly executes a registered tool.

### Routing Primitives
- `setOnToolCallArrived(token: string, cb: ToolCallArrivedCallback | null): void`: Hooks into the MCP request stream for a specific session token.
- `resolveNextToolCall(token: string, toolCallId: string, result: McpCallToolResult): void`: Delivers a tool execution result to a waiting MCP client.

### Snapshot & Schema
- `registerToolsForSession(token: string, tools: McpTool[]): void`: Snapshots a set of tools for a specific session's `tools/list` response.
- `convertToolSchema(schema: unknown): Record<string, unknown>`: Normalizes TypeBox or complex JSON schemas into standard MCP-compatible shapes.

## Usage Examples

### Starting the Server and Registering a Tool

```typescript
import { startMcpServer, registerAgentTool } from "@dotobokuri/core-mcp-server";

// 1. Start the server
const mcpUrl = await startMcpServer();
console.log(`MCP Server running at: ${mcpUrl}`);

// 2. Register a tool
registerAgentTool({
  id: "my_tool",
  tag: "my-tool",
  title: "My Custom Tool",
  description: "Does something useful",
  promptSnippet: "Use my_tool to achieve X",
  whenToUse: ["When the user asks for X"],
  whenNotToUse: ["When Y is already done"],
  usageGuidelines: ["Provide parameter Z"],
  parameters: {
    type: "object",
    properties: {
      input: { type: "string" }
    }
  },
  execute: async (args) => {
    return { result: `Processed: ${args.input}` };
  }
});
```

### Resolving an MCP Tool Call Manually

```typescript
import { setOnToolCallArrived, resolveNextToolCall } from "@dotobokuri/core-mcp-server";

const sessionToken = "my-secret-token";

setOnToolCallArrived(sessionToken, (toolName, args) => {
  const toolCallId = "unique-call-id";
  
  // Logic to trigger execution...
  // When done, resolve:
  resolveNextToolCall(sessionToken, toolCallId, {
    content: [{ type: "text", text: "Success!" }],
    isError: false
  });

  return toolCallId;
});
```

## Hardening Policies

The following invariants are enforced at the transport level:

| Policy | Value | Description |
|--------|-------|-------------|
| **Body Cap** | 1 MiB | Maximum size for incoming JSON-RPC request bodies. |
| **Held-Call Cap** | 64 | Maximum number of concurrent "in-flight" tool calls per token. |
| **Tool Timeout** | 5 min | Tool calls held by the server expire if not resolved within this window. |
| **Server Timeout** | 30 min | Idle HTTP connections are reaped to prevent resource leaks. |
| **FIFO Enforcement** | Strict | Results must be resolved in the exact order the tool calls arrived (per session). |

## Invariants

- **Token Isolation**: Sessions are strictly isolated by their Bearer tokens. Data or tool visibility never leaks across tokens.
- **HTTP-Hold**: The `tools/call` endpoint utilizes HTTP chunked-encoding/keepalive to hold connections open while waiting for async resolution.
- **Pre-Queueing**: If `resolveNextToolCall` is called before the corresponding `tools/call` HTTP request arrives, the result is held in a pre-queue and delivered immediately upon arrival.
- **UTF-8 Safety**: Internal buffers and string slicing guarantee valid UTF-8 sequences, preventing corruption of multi-byte characters (CJK, emojis).

## Migration

If you are migrating from the internal `fleet-admiral` tool registry, please refer to [MIGRATION.md](./MIGRATION.md) for detailed instructions.
