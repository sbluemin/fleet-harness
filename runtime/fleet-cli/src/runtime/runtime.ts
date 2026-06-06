import os from "node:os";
import path from "node:path";

import { createCarrierRuntime, type CarrierRuntime } from "@dotobokuri/fleet-carriers";
import {
	FLEET_MCP_SERVER_NAME,
	getExecutorMcpTools,
	registerAgentToolDefaults,
} from "@dotobokuri/fleet-admiral";
import { createInfraServices, type InfraServices } from "@dotobokuri/fleet-infra";
import {
	createMcpServer,
	createMcpToolRegistry,
	createMcpToolSnapshotStore,
	createExecutorSessionManager,
	type ExecutorSessionManager,
	type McpServer,
	type McpToolRegistry,
	type McpToolSnapshotStore,
} from "@dotobokuri/fleet-mcp-server";
import { getWikiToolSpecs } from "@dotobokuri/fleet-wiki";

import { reconcileRuntimeState } from "./reconciliation.js";

export interface RuntimeServices {
	readonly carrierRuntime: CarrierRuntime;
	readonly dedicatedMcpSession: ExecutorSessionManager;
	readonly infraServices: InfraServices;
	readonly mcpRegistry: readonly McpToolRegistry[];
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
	readonly name: string;
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
	const mcpRuntimes = createRuntimeMcpServices();
	const carrierRuntime = createCarrierRuntime();

	infraServices.executorPortRuntime.register({
		getCarrierExternalMcpServerIds(carrierId) {
			return carrierId
				? carrierRuntime.registry.getState().modes.get(carrierId)?.config.carrierMetadata?.allowedBuiltinExternalMcpServers ?? []
				: [];
		},
		getExecutorMcpTools(serverName, carrierId) {
			if (serverName !== FLEET_MCP_SERVER_NAME) return [];
			return getExecutorMcpTools(mcpRuntimes.mcpRegistry, carrierRuntime, carrierId);
		},
		getExecutorMcpRouterRuntimes() {
			return [
				{
					name: mcpRuntimes.name,
					runtime: {
						registry: mcpRuntimes.mcpRegistry,
						server: mcpRuntimes.mcpServer,
						snapshotStore: mcpRuntimes.mcpToolSnapshotStore,
					},
				},
			];
		},
	});
	carrierRuntime.store.initStore(dataDir);
	carrierRuntime.registerCarrierDefaults();

	registerAgentToolDefaults(mcpRuntimes.mcpRegistry, carrierRuntime);
	for (const spec of getWikiToolSpecs()) {
		if (spec.id === "wiki_patch_queue") {
			mcpRuntimes.mcpRegistry.registerExecutorTool(spec, { allowedCarriers: [] });
		} else if (
			spec.id === "wiki_drydock"
			|| spec.id === "wiki_ingest"
			|| spec.id === "wiki_patch_edit"
			|| spec.id === "wiki_compile_source"
			|| spec.id === "wiki_query"
		) {
			mcpRuntimes.mcpRegistry.registerExecutorTool(spec, { allowedCarriers: ["chronicle"] });
		} else {
			mcpRuntimes.mcpRegistry.registerExecutorTool(spec);
		}
	}
	const dedicatedMcpSession = createExecutorSessionManager({
		runtimes: [
			{
				name: mcpRuntimes.name,
				runtime: {
					registry: mcpRuntimes.mcpRegistry,
					server: mcpRuntimes.mcpServer,
					snapshotStore: mcpRuntimes.mcpToolSnapshotStore,
				},
			},
		],
	});
	void mcpRuntimes.mcpServer.start().catch((error: unknown) => {
		console.error("[fleet-cli] Failed to start MCP server", error);
	});

	reconcileRuntimeState(carrierRuntime);

	return {
		services: {
			carrierRuntime,
			dedicatedMcpSession,
			infraServices,
			mcpRegistry: [mcpRuntimes.mcpRegistry],
		},
		async shutdown() {
			dedicatedMcpSession.cleanup();
			const disconnectAgentSessions = infraServices.agent.disconnectAll;
			await disconnectAgentSessions();
			await mcpRuntimes.mcpServer.stop();
		},
	};
}

function createRuntimeMcpServices(): RuntimeMcpServices {
	return createRuntimeMcpBundle(FLEET_MCP_SERVER_NAME);
}

function createRuntimeMcpBundle(name: string): RuntimeMcpServices {
	const mcpRegistry = createMcpToolRegistry();
	const mcpToolSnapshotStore = createMcpToolSnapshotStore();
	const mcpServer = createMcpServer({
		registry: mcpRegistry,
		serverInfo: { name },
		toolSnapshotStore: mcpToolSnapshotStore,
	});
	return { name, mcpRegistry, mcpServer, mcpToolSnapshotStore };
}
