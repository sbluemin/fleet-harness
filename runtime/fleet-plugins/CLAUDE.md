# Fleet Plugins

Built-in Console plugin implementations. Plugins are part of the Console product surface: the domain, security, and design doctrine in `runtime/fleet-console/CLAUDE.md` applies here, and each plugin's own `CLAUDE.md` adds plugin-specific rules within its scope.

## Constraints

- Plugin CSS falls under the Console `Design invariants`: colors are consumed only as theme tokens via `var()`/`color-mix`, chromatic raw literals are forbidden, and near-achromatic shadow/scrim/sheen depth literals are the sanctioned exception.

- Use the Console Agent SDK for AI execution and session-scoped tools. Plugins own prompts, domain tool handlers, product state, and user approval; Console owns execution, isolated child resources, and teardown. Do not construct Agent SDK engines or MCP execution servers in plugins.
