---
id: "fleet-core-runtime-context-shape"
title: "FleetCoreRuntimeContext shape — 4 services after 2026-05 unification (replaces 2026-04 6-service shape)"
tags: ["fleet-core", "public-api", "doctrine", "invariant", "runtime-context"]
created: "2026-05-03T16:18:32.451Z"
updated: "2026-05-03T16:18:32.451Z"
version: 1
rawSourceRef: "raw/2026-05-03-fleet-core-runtime-context-shape-source.md"
---
## Final shape (2026-05 unification)

The 4-domain unification (May 2026, mission `fleet-core-public-services-4-unification`) replaced the previous 6-service runtime context with the following final shape:

```ts
interface FleetCoreRuntimeContext {
  readonly admiral: FleetAdmiralServices;
  readonly admiralty: FleetAdmiraltyServices;
  readonly metaphor: FleetMetaphorServices;
  readonly infra: FleetInfraServices;
  shutdown(): Promise<void>;
}
```

## Removed fields (do not re-add)

The following 6-service fields are permanently retired:

- `fleet: FleetServices`
- `grandFleet: GrandFleetServices`
- `jobs: FleetJobServices`
- `log: FleetLogServices`
- `settings: FleetSettingsServices`

The types `FleetServices`, `GrandFleetServices`, `FleetJobServices`, `FleetLogServices`, `FleetSettingsServices` and their `createFleetXxxServices()` factories no longer exist. The `metaphor` field name survives but its type is now `FleetMetaphorServices = typeof metaphor` (the metaphor package facade), not the legacy structure.

## Initialization invariant

`createFleetCoreRuntime()` MUST call side effects in this exact order before assembling services:

1. `setFleetCoreBootMode(options.bootMode ?? "normal")`
2. `migrateLegacyFleetDataDir(options.dataDir)` (when data dir matches default)
3. `initAgentSessionRuntime(options.dataDir)`
4. `initStore(options.dataDir)`
5. `infra.settings.create()` then `infra.settings.runtime.initSettingsService(...)`
6. `createFleetAdmiralServices()`, `createFleetAdmiraltyServices()`, `createFleetMetaphorServices()`, `createFleetInfraServices()`

`shutdown()` MUST call `infra.toolRegistry.mcp.stopMcpServer()`, reset settings runtime, and `resetServiceStatus()`.

## Why the destructive cleanse

Backward-compat shims for the old 6-service shape were rejected. See companion entry `fleet-core-aggressive-public-surface-cleaning-2026-05` for the policy rationale and the full list of removed surfaces.

## Migration cheatsheet

| AS-IS (2026-04) | TO-BE (2026-05) |
|-----------------|-----------------|
| `runtime.fleet.admiral.*` | `runtime.admiral.agent.*` |
| `runtime.fleet.carrier.*` | `runtime.admiral.carrier.*` |
| `runtime.fleet.mcp.*` | `runtime.infra.toolRegistry.mcp.*` |
| `runtime.fleet.auth.*` | `runtime.infra.auth.*` |
| `runtime.fleet.tools` | `runtime.admiral.agent.tools.list()` |
| `runtime.grandFleet.admiralty.*` | `runtime.admiralty.*` |
| `runtime.jobs.archive.*` | `runtime.infra.job.archive.*` |
| `runtime.jobs.streaming.*` | `runtime.admiral.carrierJobs.streaming.*` |
| `runtime.log.core.*` | `runtime.infra.log.*` |
| `runtime.settings.settings.*` | `runtime.infra.settings.*` |
| `runtime.metaphor.core.*` | `runtime.metaphor.*` |