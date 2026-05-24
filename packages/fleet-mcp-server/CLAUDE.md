# fleet-mcp-server Notes

- Keep this package leaf-only: no `@dotobokuri/fleet-*`, Fleet engine, Anthropic, or MCP SDK dependencies.
- Own only generic MCP server, routing, snapshot, registry, type, formatter, executor session manager, and invocation primitives.
- Fleet carrier metadata, default tool builders, and single-fleet prompt composition stay in `@dotobokuri/fleet-admiral`; runtime composition stays in `fleet-cli`; Grand Fleet composition stays in `fleet-cli/src/grand-fleet`.
- Preserve MCP invariants: opaque path, Bearer token isolation, FIFO call resolution, pre-queued results, immediate headers/keepalive behavior, null-safe stop, and restart after stop.
