# core-agent

Fleet-domain-agnostic executor, session, MCP, and tool-registry substrate.

## Directory index

| Directory | Responsibility |
|---|---|
| `src/` | Public executor, session, MCP, model, and registry capabilities |
| `src/internal/` | Execution internals that are not a consumer API |
| `tests/` | One-shot executor, session, registry, and reset contracts |

## Constraints

- Do not hard-code Fleet identities, reserved IDs, package names, lifecycle policy, or browser exposure rules; callers own them.
- Authentication is injected and must resolve before a provider connection begins.
- Public isolation uses a generic scope identity; Fleet-specific scope mapping happens in the caller. Host-session tool narrowing is expressed as a caller-supplied tool-id predicate, never as a built-in tool allowlist.
- Every executor call owns a fresh provider client and MCP session; resume metadata is caller-owned and never retains a live client or process.
