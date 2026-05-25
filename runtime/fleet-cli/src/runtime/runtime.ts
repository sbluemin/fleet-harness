import os from "node:os";
import path from "node:path";

import { createCarrierRuntime, type CarrierRuntime } from "@dotobokuri/fleet-carriers";
import {
	CARRIER_MCP_SERVER_NAME,
	getExecutorMcpTools,
	registerAgentToolDefaults,
	WIKI_MCP_SERVER_NAME,
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

interface RuntimeMcpBundles {
	readonly carriers: RuntimeMcpServices;
	readonly wiki: RuntimeMcpServices;
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
			switch (serverName) {
				case CARRIER_MCP_SERVER_NAME:
					return getExecutorMcpTools(mcpRuntimes.carriers.mcpRegistry, carrierRuntime, carrierId);
				case WIKI_MCP_SERVER_NAME:
					return getExecutorMcpTools(mcpRuntimes.wiki.mcpRegistry, carrierRuntime, carrierId);
				default:
					return [];
			}
		},
		getExecutorMcpRouterRuntimes() {
			return [
				{
					name: mcpRuntimes.carriers.name,
					runtime: {
						registry: mcpRuntimes.carriers.mcpRegistry,
						server: mcpRuntimes.carriers.mcpServer,
						snapshotStore: mcpRuntimes.carriers.mcpToolSnapshotStore,
					},
				},
				{
					name: mcpRuntimes.wiki.name,
					runtime: {
						registry: mcpRuntimes.wiki.mcpRegistry,
						server: mcpRuntimes.wiki.mcpServer,
						snapshotStore: mcpRuntimes.wiki.mcpToolSnapshotStore,
					},
				},
			];
		},
	});
	infraServices.sessionRuntime.initRuntime(dataDir);
	carrierRuntime.store.initStore(dataDir);
	carrierRuntime.registerCarrierDefaults();
	const settings = infraServices.settings.create();
	infraServices.settingsRuntime.init(settings);

	registerAgentToolDefaults(mcpRuntimes.carriers.mcpRegistry, carrierRuntime);
	for (const spec of getWikiToolSpecs()) {
		if (spec.id === "wiki_patch_queue") {
			mcpRuntimes.wiki.mcpRegistry.registerExecutorTool(spec, { allowedCarriers: [] });
		} else if (
			spec.id === "wiki_drydock"
			|| spec.id === "wiki_ingest"
			|| spec.id === "wiki_patch_edit"
			|| spec.id === "wiki_compile_source"
			|| spec.id === "wiki_query"
		) {
			mcpRuntimes.wiki.mcpRegistry.registerExecutorTool(spec, { allowedCarriers: ["chronicle"] });
		} else {
			mcpRuntimes.wiki.mcpRegistry.registerExecutorTool(spec);
		}
	}
	const dedicatedMcpSession = createExecutorSessionManager({
		runtimes: [
			{
				name: mcpRuntimes.carriers.name,
				runtime: {
					registry: mcpRuntimes.carriers.mcpRegistry,
					server: mcpRuntimes.carriers.mcpServer,
					snapshotStore: mcpRuntimes.carriers.mcpToolSnapshotStore,
				},
			},
			{
				name: mcpRuntimes.wiki.name,
				runtime: {
					registry: mcpRuntimes.wiki.mcpRegistry,
					server: mcpRuntimes.wiki.mcpServer,
					snapshotStore: mcpRuntimes.wiki.mcpToolSnapshotStore,
				},
			},
		],
	});
	void Promise.all([
		mcpRuntimes.carriers.mcpServer.start(),
		mcpRuntimes.wiki.mcpServer.start(),
	]).catch((error: unknown) => {
		console.error("[fleet-cli] Failed to start MCP servers", error);
	});

	reconcileRuntimeState(carrierRuntime);

	return {
		services: {
			carrierRuntime,
			dedicatedMcpSession,
			infraServices,
			mcpRegistry: [
				mcpRuntimes.carriers.mcpRegistry,
				mcpRuntimes.wiki.mcpRegistry,
			],
		},
		async shutdown() {
			dedicatedMcpSession.cleanup();
			const disconnectAgentSessions = infraServices.agent.disconnectAll;
			await disconnectAgentSessions();
			await Promise.all([
				mcpRuntimes.carriers.mcpServer.stop(),
				mcpRuntimes.wiki.mcpServer.stop(),
			]);
			infraServices.settingsRuntime.reset(settings);
		},
	};
}

function createRuntimeMcpServices(): RuntimeMcpBundles {
	return {
		carriers: createRuntimeMcpBundle(CARRIER_MCP_SERVER_NAME),
		wiki: createRuntimeMcpBundle(WIKI_MCP_SERVER_NAME),
	};
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
