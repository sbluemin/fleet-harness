# core-agent Doctrine

`packages/core-agent` owns the Fleet-domain-agnostic agent executor substrate.

## Owns

- Executor pool lifecycle, session reuse, status tracking, model/effort helpers, and builtin external MCP catalog.
- Generic in-process MCP HTTP/JSON-RPC server primitives and executor session manager primitives.
- The two-method `ExecutorPort` policy surface and the separate executor MCP runtime provider.
- Re-exports Windows binary resolution helpers from `@dotobokuri/core-process` (`resolveBinary`, `resolvePathBinary`, `createChildEnv`) so downstream consumers keep the existing root-barrel import path. The primitives themselves live in `core-process`.
- Domain-agnostic version check pure functions shared by callers.
- Generic global package updater factory for package-manager detection, global-root checks, version resolution, install spawning, and manual fallback messages.
- Package-local tests for executor reuse, MCP setup, model helpers, and reset behavior.

## Boundaries

- No imports from `@dotobokuri/fleet-*` packages.
- Auth is injected through `AuthEnvResolver`; missing resolver must throw before provider connection.
- Use `scopeId` at public core boundaries. Fleet callers may map their local `carrierId` to `scopeId`.
- Public package surface is the single root barrel `@dotobokuri/core-agent`; do not expose `internal/*` subpaths.
- Fleet reserved MCP IDs, CLI/process identity, lifecycle policy, and browser-facing exposure rules are caller policy and must be passed in, not hard-coded here.
- Generic global update helpers must not import `@dotobokuri/fleet-*`, `runtime/fleet-*`, or hard-code Fleet package-name literals; hosts inject package names and lifecycle policy.

## Tests

- Tests live in `packages/core-agent/tests/**`.
- Reset global executor port/provider and pool state in tests that touch runtime registration or pooled clients.
