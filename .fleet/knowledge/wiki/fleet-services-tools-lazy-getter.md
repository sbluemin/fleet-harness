---
id: "fleet-services-tools-lazy-getter"
title: "FleetServices.tools lazy getter — SUPERSEDED by admiral.agent.tools (2026-05)"
tags: ["fleet-core", "superseded", "doctrine", "history", "tool-spec"]
created: "2026-05-03T16:19:09.790Z"
updated: "2026-05-03T16:19:09.790Z"
version: 1
rawSourceRef: "raw/2026-05-03-fleet-services-tools-lazy-getter-source.md"
---
## Status: SUPERSEDED

This invariant no longer applies. The 2026-05 4-domain unification removed `FleetServices`, `public/fleet-services.ts`, and the `tools` lazy getter pattern entirely.

## What replaced it

The Fleet tool catalog is now sourced through:

- `runtime.admiral.agent.tools.list()` — returns the registered tool specs
- `runtime.admiral.agent.tools.invoke(...)` — invokes a tool
- `runtime.admiral.agent.tools.registerExtraTools(scopeKey, specs)` — host-scoped extras
- `runtime.admiral.agent.tools.unregisterExtraTools(scopeKey)`

Default Fleet tool specs are auto-registered when the `admiral.agent` facade module is loaded. There is no lazy getter at the public layer.

## What survives from the old invariant

The motivation (lazy-evaluating Fleet tool specs to avoid stale catalogs and to register MCP defaults exactly once) survives, but the implementation moved into `admiral/agent/tools.ts` module-level state. `registerDefaultTool` is invoked at facade load time. There is no longer a getter on the public service object.

## Where to look now

- Public consumer surface: `runtime.admiral.agent.tools.*`
- Source of truth for tool registry state: `packages/fleet-core/src/admiral/agent/tools.ts`
- Default fleet tool spec builders: `packages/fleet-core/src/admiral/{carrier,squadron,taskforce,carrier-jobs}/tool-spec.ts`

## Do not re-introduce

- A `tools` getter on any `public/*-services.ts` factory — `public/` is assembly-only (4-line factory shape).
- A separate `FleetServices` interface — public services are exactly four (`admiral/admiralty/metaphor/infra`).

## Reference

See companion entry `fleet-core-public-services-4-domain-architecture` for the canonical four-domain shape and the 9-slot `admiral.agent` contract.