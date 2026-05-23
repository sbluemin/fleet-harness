# Fleet Lightweight Follow-up

## Background

Fleet now uses explicit package ownership instead of a transitional core facade.

- `packages/fleet-agent` owns CLI lifecycle wiring, TUI rendering, host-specific adapters, and concrete runtime assembly.
- `packages/fleet-admiralty` owns multi-fleet coordination.
- `packages/fleet-admiral` owns single-fleet orchestration, prompts, runtime contracts, MCP tool policy, and operational protocols.
- `packages/fleet-carriers` owns carrier personas, dispatch, carrier jobs, and carrier state.
- `packages/fleet-infra` owns host-agnostic infrastructure and I/O gateways.
- `@sbluemin/fleet-unified-agent` remains the independent backend client package.

## Purpose

The follow-up keeps host packages thin while preserving a clear product-domain home for each behavior. The goal is explicit construction, one-way dependencies, and no hidden process-global runtime state.

## Current State

- **Logical ownership:** Final package homes are split by domain.
- **Dependency direction:** `fleet-agent` -> `fleet-admiralty` -> `fleet-admiral` -> `fleet-carriers` -> `fleet-infra`.

## Goals

- **Thin Host adapter:** Keep host packages focused on registration, rendering, lifecycle, and concrete service assembly.
- **Explicit domain services:** Keep reusable Fleet behavior in its owning package with public factory APIs.
- **Future host readiness:** Ensure new hosts can reuse the same public package surfaces without private imports.

## Guardrails

- Keep lower packages host-agnostic.
- Keep host imports on public package exports only.
- Use explicit `create*(deps)` factories instead of DI containers, service locators, or hidden global registries.
