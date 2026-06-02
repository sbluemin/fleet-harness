# fleet-admiral Doctrine

`packages/fleet-admiral` owns Fleet Admiral prompt policy, protocol text, standing orders, and Fleet-specific default tool catalog wiring.

## Owns

- Admiral system prompt assembly and the `createSystemPromptBuilder(deps): SystemPromptBuilder` factory
- Fleet Action Protocol prompt body
- Standing orders used by the Admiral system prompt
- Fleet-specific agent tool defaults and whitelist-only executor MCP tool exposure

## Must Not Own

- Host UI, PTY, render lifecycle, panels, or Agent CLI pane behavior
- Generic MCP HTTP server internals, token routing, executor session management, or schema conversion primitives
- Fleet Wiki UI, Fleet Infra, or CLI composition-root wiring

## Import Boundaries

- May depend on `@dotobokuri/fleet-carriers` and `@dotobokuri/fleet-mcp-server`.
- Must not import `@dotobokuri/fleet-cli`, `@dotobokuri/fleet-wiki`, `@dotobokuri/fleet-wiki-ui`, `@dotobokuri/fleet-infra`, or `runtime/fleet-cli`.
- Consumers import only from the root package entry `@dotobokuri/fleet-admiral`; do not add subpath exports or deep-import compatibility paths.

## Public Surface

The root barrel is whitelist-only. It may export exactly:

- `createSystemPromptBuilder`
- `SystemPromptBuilder`
- `registerAgentToolDefaults`
- `getExecutorMcpTools`
- `CARRIER_MCP_SERVER_NAME`
- `WIKI_MCP_SERVER_NAME`
- `CARRIER_EXECUTOR_MCP_TOOL_IDS`
- `WIKI_EXECUTOR_MCP_TOOL_IDS`
- `EXECUTOR_MCP_TOOL_IDS`

Do not use `export *`. Do not re-export generic MCP tool types, formatter helpers, `getAllAgentTools`, or `clearAllDefaultTools`.

## DI Factory Discipline

Injectable services use explicit pure factories:

```ts
createThing(deps): ThingInterface
```

Do not introduce DI containers, service locators, hidden host lookups, or module-level mutable runtime state.
