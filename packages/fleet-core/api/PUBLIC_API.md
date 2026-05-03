# Fleet Core Public API

This contract describes the canonical consumer surface for `@sbluemin/fleet-core`.
Fleet Core exposes four facade-backed public services and five package entries only.

## Canonical Runtime

```ts
interface FleetCoreRuntimeContext {
  readonly admiral: FleetAdmiralServices;
  readonly admiralty: FleetAdmiraltyServices;
  readonly metaphor: FleetMetaphorServices;
  readonly infra: FleetInfraServices;
  shutdown(): Promise<void>;
}
```

`createFleetCoreRuntime(options)` preserves boot side effects in this order:
`setFleetCoreBootMode` -> `migrateLegacyFleetDataDir` -> `initAgentSessionRuntime` -> `initStore`.

`shutdown()` stops `infra.toolRegistry.mcp`, resets settings runtime state, and clears unified service status.

## Domain Services

- `FleetAdmiralServices` is `typeof admiral`.
- `FleetAdmiraltyServices` is `typeof admiralty`.
- `FleetMetaphorServices` is `typeof metaphor`.
- `FleetInfraServices` is `typeof infra`.

Each `packages/fleet-core/src/public/*-services.ts` file is assembly-only:

```ts
import { name as Facade } from "../name/index.js";
export type FleetNameServices = typeof Facade;
export function createFleetNameServices(): FleetNameServices {
  return Facade;
}
```

## Facades

- `admiral` owns agent/session/events/executor, carrier/squadron/taskforce, carrier job streaming, protocols, store, prompts, request directive, and Fleet constants.
- `admiralty` owns Grand Fleet IPC, prompts, reporter, status-source, sanitization, tool specs, and runtime access.
- `metaphor` owns prompts, worldview, operation-name, and directive-refinement.
- `infra` owns auth, data-dir, job archive/lifecycle utilities, log, settings, tool-registry, and `infra.toolRegistry.mcp`.

Streaming and executor surfaces remain separate: `admiral.agent.session` + `admiral.agent.events` are the long-lived streaming path, while `admiral.agent.executor` is the callback execution path.

Carrier job stream handlers live at `admiral.carrierJobs.streaming.register(handler)` and `admiral.carrierJobs.streaming.unregister(handler)`.

## Package Entries

Allowed package entries:

- `@sbluemin/fleet-core`
- `@sbluemin/fleet-core/admiral`
- `@sbluemin/fleet-core/admiralty`
- `@sbluemin/fleet-core/metaphor`
- `@sbluemin/fleet-core/infra`

Removed compatibility subpaths are intentionally not restored. Consumers must use the root barrel or one of the four documented subpaths.

## Public Source Layout

`packages/fleet-core/src/public/` contains:

- `runtime.ts`
- `admiral-services.ts`
- `admiralty-services.ts`
- `metaphor-services.ts`
- `infra-services.ts`

Do not add logic to public service files. Move behavior into the owning domain or infra facade first.
