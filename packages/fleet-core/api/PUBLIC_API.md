# Fleet Core Public API

This contract describes the canonical consumer surface for `@sbluemin/fleet-core`.
Fleet Core exposes root-barrel facades, lifecycle boot, and documented package entries only.

## Canonical Runtime

```ts
interface FleetCoreShutdownHandle {
  shutdown(): Promise<void>;
}
```

`bootFleetCore(options)` preserves boot side effects in this order:
`setFleetCoreBootMode` -> `migrateLegacyFleetDataDir` -> `initAgentSessionRuntime` -> `initStore`.

`shutdown()` disconnects all executor pool clients, stops the `@sbluemin/fleet-mcp-server` singleton, and resets settings runtime state.

Consumers access domain operations through the root barrel:

- `admiral`
- `admiralty`
- `infra`

The lifecycle boot function does not return these facades and does not expose a service container.

## Facades

- `admiral` owns agent executor, carrier/taskforce, carrier job streaming, protocols, store, prompts, and Fleet constants.
- `admiralty` owns Grand Fleet IPC, prompts, reporter, status-source, sanitization, tool specs, and runtime access.
- `infra` owns auth, data-dir, job archive/lifecycle utilities, log, and settings.

`admiral.agent.tools.*`, `AgentToolSpec`, and `AgentToolCtx` remain reachable through the fleet-core root/facade compatibility surface. The generic registry, MCP HTTP server, token routing, snapshots, and formatter primitives are implemented by `@sbluemin/fleet-mcp-server`; fleet-core owns the carrier metadata adapter, default Fleet tool bootstrap, prompt usage, and lifecycle boot.

`admiral.agent` exposes only `executor`, `connections`, `tools`, and `models`. The executor entrypoints are `admiral.agent.executor.executeWithPool` and `admiral.agent.executor.executeOneShot`; host streaming session/event/bridge/service-status surfaces are intentionally absent.

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

Do not add domain logic to public files. Move behavior into the owning domain or infra facade first.

## Breaking Changes

### [Unreleased]

- **Removed `metaphor` domain**: The former `metaphor` service and the `@sbluemin/fleet-core/metaphor` subpath have been removed. This includes all worldview toggles, operation naming logic, and directive refinement services.
- **Removed `request_directive` tool**: The `request_directive` tool spec and its associated prompts and host-side UI integration have been removed from the `admiral` domain.
- **Removed host agent streaming surface**: `admiral.agent.session`, `admiral.agent.events`, `admiral.agent.lifecycle`, `admiral.agent.bridge`, and `admiral.agent.serviceStatus` have been removed; carrier execution remains available through `executeWithPool` and `executeOneShot`.
- **Removed runtime service container**: Fleet-core lifecycle boot now returns only a shutdown handle; consumers use root-barrel facades for domain operations.
