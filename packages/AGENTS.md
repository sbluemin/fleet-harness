# Packages

`packages/` contains reusable capabilities and Fleet domains; executable host lifecycle remains under `runtime/`.

## Directory index

| Directory | Responsibility |
|---|---|
| `core-process/` | Dependency-free process and binary primitives |
| `core-unified-agent/` | Provider-neutral Agent CLI client and transport normalization |
| `core-agent/` | Executor, session, MCP, and tool-registry substrate |
| `core-infra/` | Authentication, data-root, and durable filesystem gateways |
| `fleet-carriers/` | Carrier personas, dispatch, detached jobs, and state |
| `fleet-admiral/` | Admiral prompt, protocol, tool, launch, and runtime policy |
| `fleet-wiki/` | Fleet Wiki storage, retrieval, and approval-gated mutation domain |

## Constraints

- Package-owned mutable runtime state must have one owner and explicit lifecycle and test-reset boundaries; cross-layer access must use the owning package's declared runtime surface.
