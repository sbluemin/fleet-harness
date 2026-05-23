import os from "node:os";
import path from "node:path";

import { createCarrierRuntime, type CarrierRuntime } from "@sbluemin/fleet-carriers";
import { createInfraServices, type InfraServices } from "@sbluemin/fleet-infra";
import {
	createMcpServer,
	createMcpToolRegistry,
	createMcpToolSnapshotStore,
	type McpServer,
	type McpToolRegistry,
	type McpToolSnapshotStore,
} from "@sbluemin/fleet-mcp-server";
import { getWikiToolSpecs } from "@sbluemin/fleet-wiki";

import { createDedicatedMcpSession, type DedicatedMcpSessionPort } from "../admiral/mcp.js";
import { getExecutorMcpTools, registerAgentToolDefaults } from "../admiral/tools.js";
import { reconcileRuntimeState } from "./reconciliation.js";

export interface RuntimeServices {
	readonly carrierRuntime: CarrierRuntime;
	readonly dedicatedMcpSession: DedicatedMcpSessionPort;
	readonly infraServices: InfraServices;
	readonly mcpRegistry: McpToolRegistry;
}

export interface FleetRuntimeLifecycle {
	readonly services: RuntimeServices | undefined;
	shutdown(): Promise<void>;
	start(): Promise<RuntimeServices>;
}

interface FleetRuntimeLifecycleDeps {
	readonly dataDir?: string;
}

interface RuntimeMcpServices {
	readonly mcpRegistry: McpToolRegistry;
	readonly mcpServer: McpServer;
	readonly mcpToolSnapshotStore: McpToolSnapshotStore;
}

interface StartedRuntime {
	readonly services: RuntimeServices;
	readonly shutdown: () => Promise<void>;
}

export function createFleetRuntimeLifecycle(deps: FleetRuntimeLifecycleDeps = {}): FleetRuntimeLifecycle {
	let startedRuntime: StartedRuntime | undefined;
	return {
		get services() {
			return startedRuntime?.services;
		},
		async shutdown() {
			const runtime = startedRuntime;
			startedRuntime = undefined;
			await runtime?.shutdown();
		},
		async start() {
			if (startedRuntime !== undefined) {
				return startedRuntime.services;
			}

			startedRuntime = await startRuntime(deps);
			return startedRuntime.services;
		},
	};
}

async function startRuntime(deps: FleetRuntimeLifecycleDeps): Promise<StartedRuntime> {
	const dataDir = deps.dataDir ?? path.join(os.homedir(), ".fleet");
	const infraServices = createInfraServices();
	const { mcpRegistry, mcpServer, mcpToolSnapshotStore } = createRuntimeMcpServices();
	const carrierRuntime = createCarrierRuntime({ config: {} });

	infraServices.executorPortRuntime.register({
		getCarrierExternalMcpServerIds(carrierId) {
			return carrierId
				? carrierRuntime.registry.getState().modes.get(carrierId)?.config.carrierMetadata?.allowedBuiltinExternalMcpServers ?? []
				: [];
		},
		getExecutorMcpTools(carrierId) {
			return getExecutorMcpTools(mcpRegistry, carrierRuntime, carrierId);
		},
		getExecutorMcpRouterRuntime() {
			return {
				registry: mcpRegistry,
				server: mcpServer,
				snapshotStore: mcpToolSnapshotStore,
			};
		},
	});
	infraServices.sessionRuntime.initRuntime(dataDir);
	carrierRuntime.store.initStore(dataDir);
	carrierRuntime.registerCarrierDefaults();
	const settings = infraServices.settings.create();
	infraServices.settingsRuntime.init(settings);

	registerAgentToolDefaults(mcpRegistry, carrierRuntime);
	for (const spec of getWikiToolSpecs()) {
		if (spec.id === "wiki_patch_queue") {
			mcpRegistry.registerExecutorTool(spec, { allowedCarriers: [] });
		} else if (
			spec.id === "wiki_drydock"
			|| spec.id === "wiki_ingest"
			|| spec.id === "wiki_patch_edit"
			|| spec.id === "wiki_compile_source"
			|| spec.id === "wiki_query"
		) {
			mcpRegistry.registerExecutorTool(spec, { allowedCarriers: ["chronicle"] });
		} else {
			mcpRegistry.registerExecutorTool(spec);
		}
	}
	const dedicatedMcpSession = createDedicatedMcpSession({
		server: mcpServer,
		registry: mcpRegistry,
		snapshotStore: mcpToolSnapshotStore,
	});
	void mcpServer.start().catch((error: unknown) => {
		console.error("[fleet-agent] Failed to start MCP server", error);
	});

	reconcileRuntimeState(carrierRuntime);

	return {
		services: {
			carrierRuntime,
			dedicatedMcpSession,
			infraServices,
			mcpRegistry,
		},
		async shutdown() {
			dedicatedMcpSession.cleanup();
			const disconnectAgentSessions = infraServices.agent.disconnectAll;
			await disconnectAgentSessions();
			await mcpServer.stop();
			infraServices.settingsRuntime.reset(settings);
		},
	};
}

function createRuntimeMcpServices(): RuntimeMcpServices {
	const mcpRegistry = createMcpToolRegistry();
	const mcpToolSnapshotStore = createMcpToolSnapshotStore();
	const mcpServer = createMcpServer({
		registry: mcpRegistry,
		toolSnapshotStore: mcpToolSnapshotStore,
	});
	return { mcpRegistry, mcpServer, mcpToolSnapshotStore };
}
