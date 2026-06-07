# core-mcp-server Doctrine

`packages/core-mcp-server` is a leaf workspace package for Fleet's generic MCP HTTP server, token/FIFO routing, session tool snapshots, and generic agent tool registry primitives.

## Owns

- Generic MCP HTTP JSON-RPC server lifecycle (body caps, timeouts, snapshot cleanup) and routing under `src/`
- Bearer token isolation, opaque server path, FIFO `tools/call` hold behavior, pre-queued result handling, and generic executor session token management through `createExecutorSessionManager(deps): ExecutorSessionManager`.
- Session tool snapshots and MCP tool schema conversion
- Generic `AgentToolSpec`, `AgentToolCtx`, `McpCallToolResult`, registry, formatter, and invocation primitives
- Package-local tests for MCP server, registry, and executor session manager behavior

## Must Not Own

- Fleet carrier framework, carrier metadata lookup, persona registration, default Fleet tool builders, prompt assembly, or host UI. Carrier metadata, default tool builders, and single-fleet prompt composition belong to `@dotobokuri/fleet-admiral`; runtime composition belongs to `fleet-cli`.
- Imports from any `@dotobokuri/fleet-*` workspace package
- Imports from Fleet engine packages, Anthropic packages, or `@modelcontextprotocol/*` unless an Admiral-approved plan explicitly changes this package boundary

## Import Boundaries

- This package may use Node built-ins such as `node:http` and `node:crypto`.
- This package must remain a dependency leaf relative to Fleet workspace packages: no `@dotobokuri/fleet-*` runtime, dev, test, or source imports.
- Consumers import through the root package entry `@dotobokuri/core-mcp-server`; do not add public subpath exports without an explicit plan requirement.

## MCP Invariants

These runtime invariants must be preserved across changes:

- Opaque server path and Bearer token isolation per session
- FIFO `tools/call` resolution and pre-queued result handling
- Immediate headers / keepalive behavior
- Null-safe stop and restart-after-stop lifecycle

## TypeScript File Structure

All `.ts` files follow the repository declaration order:

```
imports -> types/interfaces -> constants -> functions
```

Do not interleave constants and functions, and do not declare types mid-file.
