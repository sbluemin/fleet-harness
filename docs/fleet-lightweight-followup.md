# Fleet Lightweight Follow-up

## Background
Fleet has completed the logical product split that separates the product core from the host adapter.

- `packages/fleet-core` owns Fleet domain logic, prompts, runtime contracts, MCP/tool/job internals, and public APIs.
- `packages/fleet-agent` owns CLI lifecycle wiring, TUI rendering, and host-specific adapters.
- `@sbluemin/fleet-unified-agent` remains the independent backend client package.

This split is the foundation for turning Fleet into a standalone product that can be exposed through multiple hosts.

## Purpose
The lightweight follow-up exists to reduce the amount of product behavior that has to be understood through the host package. The goal is to make the already-split architecture easier to maintain by hardening the `fleet-core` public surface and making host packages thinner, more mechanical, and more replaceable.

## Current State
- **Logical ownership:** Final. `fleet-core` owns Fleet domain logic; host packages own host capabilities.
- **Dependency direction:** Host packages consume `fleet-core` through public APIs. `fleet-core` must not import host packages.

## Goals
- **Thin Host adapter:** Keep host packages (like `fleet-agent`) focused on registration, rendering, and lifecycle.
- **Thick product core:** Move reusable Fleet behavior, product policy, domain decisions, and pure execution contracts toward `fleet-core`.
- **Future host readiness:** Ensure the architecture allows new hosts to reuse the same core without modification.

## Target Direction
The target model is **thick core, thin adapter**.

```text
fleet-core
  owns product behavior, domain policy, prompt assets, job logic, public APIs

fleet-agent (host)
  adapts Fleet to CLI through TUI, process management, and input routing
```

## Guardrails
- Keep `fleet-core` host-agnostic.
- Keep host packages focused on their specific environment (TUI, terminal, etc.).
- Keep host imports on public `fleet-core` exports only.
