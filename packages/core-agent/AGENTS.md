# core-agent Doctrine

`packages/core-agent` owns the Fleet-domain-agnostic agent executor substrate.

## Owns

- Executor pool lifecycle, session reuse, status tracking, model/effort helpers, and builtin external MCP catalog.
- The two-method `ExecutorPort` policy surface and the separate executor MCP runtime provider.
- Package-local tests for executor reuse, MCP setup, model helpers, and reset behavior.

## Boundaries

- No imports from `@dotobokuri/fleet-*` packages.
- Auth is injected through `AuthEnvResolver`; missing resolver must throw before provider connection.
- Use `scopeId` at public core boundaries. Fleet callers may map their local `carrierId` to `scopeId`.
- Public package surface is the single root barrel `@dotobokuri/core-agent`; do not expose `internal/*` subpaths.
- Fleet reserved MCP IDs are caller policy and must be passed in, not hard-coded here.

## Tests

- Tests live in `packages/core-agent/tests/**`.
- Reset global executor port/provider and pool state in tests that touch runtime registration or pooled clients.
