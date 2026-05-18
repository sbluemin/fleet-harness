# fleet-mcp-server Doctrine

`packages/fleet-mcp-server` is a leaf workspace package for Fleet's generic MCP HTTP server, token/FIFO routing, session tool snapshots, and generic agent tool registry primitives.

## Owns

- Generic MCP HTTP JSON-RPC server lifecycle (body caps, timeouts, snapshot cleanup) and routing under `src/`
- Bearer token isolation, opaque server path, FIFO `tools/call` hold behavior, and pre-queued result handling
- Session tool snapshots and MCP tool schema conversion
- Generic `AgentToolSpec`, `AgentToolCtx`, `McpCallToolResult`, registry, formatter, and invocation primitives
- Package-local tests for MCP server and registry behavior

## Must Not Own

- Fleet carrier framework, carrier metadata lookup, persona registration, default Fleet tool builders, prompt assembly, Pi runtime wiring, or host UI
- Imports from any `@sbluemin/fleet-*` workspace package
- Imports from Pi host packages, Fleet engine packages, Anthropic packages, or `@modelcontextprotocol/*` unless an Admiral-approved plan explicitly changes this package boundary

## Import Boundaries

- This package may use Node built-ins such as `node:http` and `node:crypto`.
- This package must remain a dependency leaf relative to Fleet workspace packages: no `@sbluemin/fleet-*` runtime, dev, test, or source imports.
- Consumers import through the root package entry `@sbluemin/fleet-mcp-server`; do not add public subpath exports without an explicit plan requirement.

## TypeScript File Structure

All `.ts` files follow the repository declaration order:

```
imports -> types/interfaces -> constants -> functions
```

Do not interleave constants and functions, and do not declare types mid-file.
