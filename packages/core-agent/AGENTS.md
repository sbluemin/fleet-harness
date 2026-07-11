# core-agent

Fleet-domain-agnostic executor, session, MCP, and tool-registry substrate.

## Directory index

| Directory | Responsibility |
|---|---|
| `src/` | Public executor, session, MCP, model, and registry capabilities |
| `src/internal/` | Execution internals that are not a consumer API |
| `tests/` | Pool, session, registry, and reset contracts |

## Constraints

- Do not hard-code Fleet identities, reserved IDs, package names, lifecycle policy, or browser exposure rules; callers own them.
- Authentication is injected and must resolve before a provider connection begins.
- Public isolation uses a generic scope identity; Fleet-specific Carrier mapping happens in the caller.
- Executor pools and registered executor port/provider state are process-local; never persist them, and explicitly clean or replace them at lifecycle and test boundaries.
