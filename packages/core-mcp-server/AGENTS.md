# core-mcp-server Doctrine

`packages/core-mcp-server` is a leaf workspace package for generic agent tool registry primitives, MCP schema conversion, session tool snapshots, and local invocation helpers.

## Owns

- Session tool snapshots and MCP tool schema conversion
- Generic `AgentToolSpec`, `AgentToolCtx`, `McpCallToolResult`, registry, formatter, and invocation primitives
- Package-local tests for registry, snapshot, schema conversion, and local invocation behavior

## Must Not Own

- Fleet carrier framework, carrier metadata lookup, persona registration, default Fleet tool builders, prompt assembly, or host UI. Carrier metadata, default tool builders, and single-fleet prompt composition belong to `@dotobokuri/fleet-admiral`; runtime composition belongs to `fleet-cli`.
- Imports from any `@dotobokuri/fleet-*` workspace package
- Imports from Fleet engine packages, Anthropic packages, or `@modelcontextprotocol/*` unless an Admiral-approved plan explicitly changes this package boundary
- Live daemon/server lifecycle; Fleet Gateway owns local HTTP routing and token/FIFO transport.

## Import Boundaries

- This package may use Node built-ins such as `node:crypto`.
- This package must remain a dependency leaf relative to Fleet workspace packages: no `@dotobokuri/fleet-*` runtime, dev, test, or source imports.
- Consumers import through the root package entry `@dotobokuri/core-mcp-server`; do not add public subpath exports without an explicit plan requirement.

## MCP Invariants

Runtime HTTP invariants live in `runtime/fleet-gateway`. This package preserves:

- Registry ordering
- Scoped executor tool filtering
- Session snapshot conversion
- Local invocation result formatting

## TypeScript File Structure

All `.ts` files follow the repository declaration order:

```
imports -> types/interfaces -> constants -> functions
```

Do not interleave constants and functions, and do not declare types mid-file.
