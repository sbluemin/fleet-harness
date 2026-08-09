# Packages

`packages/` contains reusable capabilities and Fleet domains; executable host lifecycle remains under `runtime/`.

## Directory index

| Directory | Responsibility |
|---|---|
| `core-process/` | Dependency-free process and binary primitives |
| `core-agent/` | Tool vocabulary, MCP serving, the Claude gateway SDK, and update primitives; the only sanctioned vendor-SDK import site |
| `core-infra/` | Authentication, data-root, and durable filesystem gateways |
| `fleet-admiral/` | Admiral prompt, protocol, tool, launch, and runtime policy |
| `fleet-wiki/` | Fleet Wiki storage, retrieval, and approval-gated mutation domain |

## Constraints

- Package-owned mutable runtime state must have one owner and explicit lifecycle and test-reset boundaries; cross-layer access must use the owning package's declared runtime surface.
