# fleet-mcp-server Notes

- Keep this package leaf-only: no `@sbluemin/fleet-*`, Pi runtime, Fleet engine, Anthropic, or MCP SDK dependencies.
- Own only generic MCP server, routing, snapshot, registry, type, formatter, and invocation primitives.
- Fleet carrier metadata, default tool builders, prompt composition, and runtime composition stay in `@sbluemin/fleet-core`.
- Preserve MCP invariants: opaque path, Bearer token isolation, FIFO call resolution, pre-queued results, immediate headers/keepalive behavior, null-safe stop, and restart after stop.
