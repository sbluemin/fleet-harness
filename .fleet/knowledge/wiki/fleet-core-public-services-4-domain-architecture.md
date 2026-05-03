---
id: "fleet-core-public-services-4-domain-architecture"
title: "fleet-core public services 4-domain architecture (admiral/admiralty/metaphor/infra)"
tags: ["fleet-core", "public-api", "architecture", "doctrine", "invariant"]
created: "2026-05-03T16:17:15.650Z"
updated: "2026-05-03T16:17:15.650Z"
version: 1
rawSourceRef: "raw/2026-05-03-fleet-core-public-services-4-domain-architecture-source.md"
---
## Architecture

`@sbluemin/fleet-core` exposes exactly four public domain services. Every consumer-facing symbol either belongs inside one of these four or is internal.

| Public service | src package | facade object |
|----------------|-------------|---------------|
| admiral services | `src/admiral/` | `export const admiral` |
| admiralty services | `src/admiralty/` | `export const admiralty` |
| metaphor services | `src/metaphor/` | `export const metaphor` |
| infra services | `src/infra/` | `export const infra` |

## Canonical factory shape (invariant)

Each `public/<name>-services.ts` MUST be exactly four lines of body. Conversion, wrapping, injection, getters, and lifecycle code are forbidden in `public/`.

```ts
import { <name> as Facade } from "../<name>/index.js";
export type Fleet<Name>Services = typeof Facade;
export function createFleet<Name>Services(): Fleet<Name>Services {
  return Facade;
}
```

## Runtime context

```ts
interface FleetCoreRuntimeContext {
  readonly admiral: FleetAdmiralServices;
  readonly admiralty: FleetAdmiraltyServices;
  readonly metaphor: FleetMetaphorServices;
  readonly infra: FleetInfraServices;
  shutdown(): Promise<void>;
}
```

`runtime.ts` is the single composition root. Initialization side-effect order is preserved: `setFleetCoreBootMode → migrateLegacyFleetDataDir → initAgentSessionRuntime → initStore → infra.settings.create → assemble four services`.

## Domain package facade rule

Each domain package `index.ts` exposes one primary facade object that aggregates its sub-domains.

- `admiral` aggregates: `agent, carrier, squadron, taskforce, carrierJobs, protocols, store, prompts, requestDirective, constants`
- `infra` aggregates: `auth, dataDir, job, log, settings, toolRegistry`
- `admiralty` and `metaphor` aggregate their flat/nested modules respectively

## admiral.agent — 9 slot contract

`admiral/agent/index.ts` exports `const agent` (NOT `const admiral` — name collides with the package facade). The 9 slots are:

`tools, session, events, lifecycle, connections, models, serviceStatus, bridge, executor`

Streaming surface (`session` + `events`) and callback surface (`executor`) are sibling slots and must never be merged.

## package.json exports

Exactly five entries are allowed:

- `.`
- `./admiral`
- `./admiralty`
- `./metaphor`
- `./infra`

All other subpaths (e.g., `./services/log`, `./admiral/carrier`, `./constants`, `./carrier-jobs`, `./admiral/_shared/carrier-job-events`) were removed in 2026-05 and must not be re-added.

## Why this shape

`public/` is composition-only; its purpose is to surface domain facades 1:1. Wrapping or transforming the facade in `public/` is treated as a regression because it duplicates ownership and breaks the single-package SSoT rule.