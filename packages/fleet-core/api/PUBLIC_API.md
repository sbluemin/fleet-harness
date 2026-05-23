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
`setFleetCoreBootMode` -> `migrateLegacyFleetDataDir` -> `registerExecutorPort` -> `initAgentSessionRuntime` -> `initStore` -> `registerDefaultCarriers`.

`shutdown()` disconnects all executor pool clients, stops the `@sbluemin/fleet-mcp-server` singleton, and resets settings runtime state.

Consumers access domain operations through the root barrel:

- `admiral`
- `admiralty`

The lifecycle boot function does not return these facades and does not expose a service container.

## Facades

- `admiral` exposes agent executor, carrier delegation including Task Force execution mode, carrier job streaming, protocols, store, prompts, and Fleet constants. Carrier runtime implementation is owned by `@sbluemin/fleet-carriers`; fleet-core preserves the facade shape.
- `admiralty` owns Grand Fleet IPC, prompts, reporter, status-source, sanitization, tool specs, and runtime access.
Host-agnostic infrastructure is owned by `@sbluemin/fleet-infra`.

`admiral.agent.tools.*`, `AgentToolSpec`, and `AgentToolCtx` remain reachable through the fleet-core root/facade compatibility surface. The generic registry, MCP HTTP server, token routing, snapshots, and formatter primitives are implemented by `@sbluemin/fleet-mcp-server`; fleet-core owns the carrier metadata adapter, default Fleet tool bootstrap, prompt usage, and lifecycle boot.

`carrier_dispatch` is the public carrier delegation entrypoint. When the selected carrier has a valid Task Force configuration, dispatch auto-promotes to Task Force execution under the same delegation surface. Task Force job IDs keep the `taskforce:` prefix, and `carrier_jobs(action: "result", format: "full")` returns `results: Record<cliType, string>` for Task Force jobs.

`admiral.agent` exposes only `executor`, `connections`, `tools`, and `models`. The executor entrypoints are `admiral.agent.executor.executeWithPool` and `admiral.agent.executor.executeOneShot`; host streaming session/event/bridge/service-status surfaces are intentionally absent.

Carrier job stream handlers live at `admiral.carrierJobs.streaming.register(handler)` and `admiral.carrierJobs.streaming.unregister(handler)`.

Carrier runtime symbols exported from the fleet-core root and `admiral` facade remain compatibility re-exports. The implementation relocation to `@sbluemin/fleet-carriers` does not add package entries or change the frozen symbol surface.

## Package Entries

Allowed package entries:

- `@sbluemin/fleet-core`
- `@sbluemin/fleet-core/admiral`
- `@sbluemin/fleet-core/admiralty`

Removed compatibility subpaths are intentionally not restored. Consumers must use the root barrel or one of the documented subpaths. Infra consumers must import from `@sbluemin/fleet-infra`.

## Public Source Layout

`packages/fleet-core/src/public/` contains:

- `runtime.ts`
- `admiral-services.ts`
- `admiralty-services.ts`

Do not add domain logic to public files. Move behavior into the owning domain first.

## Breaking Changes

### [Unreleased]

- **Removed `metaphor` domain**: The former `metaphor` service and the `@sbluemin/fleet-core/metaphor` subpath have been removed. This includes all worldview toggles, operation naming logic, and directive refinement services.
- **Removed `request_directive` tool**: The `request_directive` tool spec and its associated prompts and host-side UI integration have been removed from the `admiral` domain.
- **Removed host agent streaming surface**: `admiral.agent.session`, `admiral.agent.events`, `admiral.agent.lifecycle`, `admiral.agent.bridge`, and `admiral.agent.serviceStatus` have been removed; carrier execution remains available through `executeWithPool` and `executeOneShot`.
- **Removed runtime service container**: Fleet-core lifecycle boot now returns only a shutdown handle; consumers use root-barrel facades for domain operations.
