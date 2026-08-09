# core-agent

Fleet-domain-agnostic in-process MCP, tool-registry, binary-resolution, and update substrate.

This package drives no model and speaks no agent protocol. Callers that need one bring their own transport and hand this package only the MCP session and tool wiring.

## Directory index

| Directory | Responsibility |
|---|---|
| `src/` | Public MCP session, router, tool registry, binary, and update capabilities |
| `tests/` | MCP transport, registry, external-MCP, and update contracts |

## Constraints

- Do not hard-code Fleet identities, reserved IDs, package names, lifecycle policy, or browser exposure rules; callers own them.
- Public isolation uses a generic scope identity; Fleet-specific scope mapping happens in the caller. Host-session tool narrowing is expressed as a caller-supplied tool-id predicate, never as a built-in tool allowlist.
- Each MCP session owns its own port and bearer token and is disposed with the session; nothing here retains a live child process.
- Whoever hands a child both internal MCP sessions and external MCP servers must call `assertInternalMcpTokensNotShared` before spawning. An internal bearer token reaching an external server is a credential leak that no other gate catches.
- `McpServerConfig.toolTimeoutSeconds` is seconds. Providers that take milliseconds must convert at their own boundary.
