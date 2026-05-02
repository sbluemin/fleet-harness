# Fleet Core Public API

This contract describes the canonical consumer surface for `@sbluemin/fleet-core`.
Fleet Core now exposes completed domain APIs through `FleetCoreRuntimeContext`;
legacy public leaf APIs such as `CoreServices`, `AgentRequestService`,
`agentRequest`, and raw registry handles are not public runtime fields.

## Canonical Runtime

- Subpath: `@sbluemin/fleet-core`
- `createFleetCoreRuntime(options: { dataDir: string }): FleetCoreRuntimeContext`

`FleetCoreRuntimeContext` is the only host-consumer context:

```ts
interface FleetCoreRuntimeContext {
  readonly fleet: FleetServices;
  readonly grandFleet: GrandFleetServices;
  readonly metaphor: FleetMetaphorServices;
  readonly jobs: FleetJobServices;
  readonly log: FleetLogServices;
  readonly settings: FleetSettingsServices;
  shutdown(): Promise<void>;
}
```

`shutdown()` owns cleanup for the Fleet Core runtime state, settings singleton,
and service-status callbacks.

## Domain Services

The package root exports the domain services that make up
`FleetCoreRuntimeContext`:

- `FleetServices` — Admiral carrier, squadron, taskforce, protocol, tool, and MCP domain APIs.
  - `readonly protocols`: Admiral protocol facade (standing orders, etc.)
  - `readonly carrier`: Carrier service facade (sortie, personas, etc.)
  - `readonly squadron`: Squadron service facade.
  - `readonly taskForce`: Taskforce service facade.
  - `readonly tools`: Lazy getter for `AgentToolSpec[]` (sortie, squadron, taskforce, carrier_jobs).
  - `readonly mcp`: MCP coordination service.
- `FleetServices.mcp` exposes request-session MCP coordination:
  - `url(): Promise<string>`
  - `setOnToolCallArrived(token, cb)`
  - `resolveNextToolCall(token, toolCallId, result)`
  - `hasPendingToolCall(token)`
  - `clearPendingForSession(token)`
  - `registerTools(token, tools)`
  - `getTools(token)`
  - `getToolNames(token)`
  - `removeTools(token)`
  - `clearAllTools()`
  - `computeToolHash(tools)`
  - `convertToolSchema(schema)`
- `GrandFleetServices` — Admiralty/Grand Fleet domain APIs.
- `FleetMetaphorServices` — worldview, persona, operation-name, and directive-refinement domain APIs.
- `FleetJobServices` — detached carrier job/archive APIs.
- `FleetLogServices` — Fleet log domain APIs.
- `FleetSettingsServices` — runtime-owned settings API.

The old compatibility names are intentionally absent from the runtime context:

- no `coreServices`
- no `settingsServices`
- no `agentRequest`
- no raw `agent` runtime object
- no `agents` alias
- no `carriers` alias
- no `admiral` alias
- no `tools` alias
- no raw `toolRegistry` object
- no raw `mcp` object outside `FleetServices`
- no `toolRegistry` runtime field
- no `mcp` runtime field

## Support Types

The root export also provides support types needed to host the runtime:

- `FleetJobServices.streaming.register(handler)` — Registers a synchronous handler for normalized carrier job stream events.
- `FleetJobServices.streaming.unregister(handler)` — Unregisters a carrier job stream handler.
- `AgentToolSpec` — Host-agnostic agent tool metadata and execution contract.
- `AgentToolCtx` — Execution context passed to registered agent tools.
- `McpCallToolResult` / `ToolCallArrivedCallback` — Types for MCP interaction.

## Public Source Layout

`packages/fleet-core/src/public/` is the source home for root-exported runtime
composition and domain service modules:

- `runtime.ts`
- `fleet-services.ts`
- `grand-fleet-services.ts`
- `metaphor-services.ts`
- `job-services.ts`
- `log-services.ts`
- `settings-services.ts`

`runtime.ts` remains as an internal source leaf for directory structure and root
composition. It is not exposed as `@sbluemin/fleet-core/runtime`.

Do not add legacy public leaves such as `agent-request.ts`, `agent-runtime.ts`,
`backend-adapter.ts`, `host-ports.ts`, `mcp.ts`, `streaming-sink.ts`,
`tool-registry.ts`, or `types.ts`.

## Compatibility Subpaths

Some package subpaths still exist for active migration compatibility. They expose 
narrow implementation contracts. New public functionality must enter through 
the domain service modules above.

Current Fleet domain compatibility subpaths (based on `package.json` exports):

- `@sbluemin/fleet-core/constants`
- `@sbluemin/fleet-core/job`
- `@sbluemin/fleet-core/admiral`
- `@sbluemin/fleet-core/admiral/carrier`
- `@sbluemin/fleet-core/admiral/carrier/status-overlay-controller`
- `@sbluemin/fleet-core/admiral/carrier/types` — `CarrierMetadata`, `CarrierCategory`, `CarrierStatusEntry`, `RequestBlock`, `OverlayState`, and overlay callback types.
- `@sbluemin/fleet-core/admiral/carrier/personas`
- `@sbluemin/fleet-core/admiral/squadron`
- `@sbluemin/fleet-core/admiral/taskforce`
- `@sbluemin/fleet-core/admiral/store`
- `@sbluemin/fleet-core/admiral/agent-runtime`
- `@sbluemin/fleet-core/admiral/_shared/carrier-job-events`
- `@sbluemin/fleet-core/admiral/_shared/stream-reducers`
- `@sbluemin/fleet-core/admiral/_shared/view-model`
- `@sbluemin/fleet-core/carrier-jobs`
- `@sbluemin/fleet-core/admiral/protocols/standing-orders`
- `@sbluemin/fleet-core/services/tool-registry`
- `@sbluemin/fleet-core/metaphor`
- `@sbluemin/fleet-core/metaphor/operation-name`
- `@sbluemin/fleet-core/metaphor/directive-refinement`
- `@sbluemin/fleet-core/services/settings`
- `@sbluemin/fleet-core/services/log`
- `@sbluemin/fleet-core/admiralty`
