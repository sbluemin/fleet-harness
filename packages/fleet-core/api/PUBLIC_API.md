# Fleet Core Public API

This contract describes the canonical consumer surface for `@sbluemin/fleet-core`.
Fleet Core exposes four facade-backed public services and five package entries only.

## Canonical Runtime

```ts
interface FleetCoreRuntimeContext {
  readonly admiral: FleetAdmiralServices;
  readonly admiralty: FleetAdmiraltyServices;
  readonly infra: FleetInfraServices;
  shutdown(): Promise<void>;
}
```

`createFleetCoreRuntime(options)` preserves boot side effects in this order:
`setFleetCoreBootMode` -> `migrateLegacyFleetDataDir` -> `initAgentSessionRuntime` -> `initStore`.

`shutdown()` stops the `@sbluemin/fleet-mcp-server` singleton, resets settings runtime state, and clears unified service status.

## Domain Services

- `FleetAdmiralServices` is `typeof admiral`.
- `FleetAdmiraltyServices` is `typeof admiralty`.
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

- `admiral` owns agent/session/events/executor, carrier/squadron/taskforce, carrier job streaming, protocols, store, prompts, and Fleet constants.
- `admiralty` owns Grand Fleet IPC, prompts, reporter, status-source, sanitization, tool specs, and runtime access.
- `infra` owns auth, data-dir, job archive/lifecycle utilities, log, and settings.

`admiral.agent.tools.*`, `AgentToolSpec`, and `AgentToolCtx` remain reachable through the fleet-core root/facade compatibility surface. The generic registry, MCP HTTP server, token routing, snapshots, and formatter primitives are implemented by `@sbluemin/fleet-mcp-server`; fleet-core owns the carrier metadata adapter, default Fleet tool bootstrap, prompt usage, and runtime composition.

Streaming and executor surfaces remain separate: `admiral.agent.session` + `admiral.agent.events` are the long-lived streaming path, while `admiral.agent.executor` is the callback execution path.

Carrier job stream handlers live at `admiral.carrierJobs.streaming.register(handler)` and `admiral.carrierJobs.streaming.unregister(handler)`.

## Package Entries

Allowed package entries:

- `@sbluemin/fleet-core`
- `@sbluemin/fleet-core/admiral`
- `@sbluemin/fleet-core/admiralty`
- `@sbluemin/fleet-core/infra`

Removed compatibility subpaths are intentionally not restored. Consumers must use the root barrel or one of the three documented subpaths.

## Public Source Layout

`packages/fleet-core/src/public/` contains:

- `runtime.ts`
- `admiral-services.ts`
- `admiralty-services.ts`
- `infra-services.ts`

Do not add logic to public service files. Move behavior into the owning domain or infra facade first.

## Breaking Changes

### [Unreleased]

- **Removed `metaphor` domain**: The `metaphor` service (previously `FleetCoreRuntimeContext.metaphor`) and the `@sbluemin/fleet-core/metaphor` subpath have been removed. This includes all worldview toggles, operation naming logic, and directive refinement services.
- **Removed `request_directive` tool**: The `request_directive` tool spec and its associated prompts and host-side UI integration have been removed from the `admiral` domain.
