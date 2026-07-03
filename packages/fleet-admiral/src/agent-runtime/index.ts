import {
	createExecutorSessionManager,
	createInProcessMcpServer,
	createMcpToolRegistry,
	createMcpToolSnapshotStore,
	disconnectAll,
	executorMcpRuntimeProviderRuntime,
	executorPortRuntime,
	type AgentToolSpec,
	type ExecutorSessionManager,
	type InProcessMcpServer,
	type McpToolRegistry,
	type McpToolSnapshotStore,
	type RegisterExecutorToolOptions,
} from "@dotobokuri/core-agent";
import {
	createCarrierRuntime,
	type CarrierRuntime,
	type WorkspaceChangeScanner,
} from "@dotobokuri/fleet-carriers";

import {
	FLEET_MCP_SERVER_NAME,
	getExecutorMcpTools,
	registerAgentToolDefaults,
} from "../tools.js";

export interface FleetAgentRuntimeToolRegistration {
	readonly spec: AgentToolSpec;
	readonly options?: RegisterExecutorToolOptions;
}

export interface FleetAgentRuntimeLifecycleDeps {
	readonly dataDir: string;
	readonly workspaceChangeScanner?: WorkspaceChangeScanner;
	readonly extraExecutorTools?: readonly FleetAgentRuntimeToolRegistration[];
	readonly wikiToolSpecs?: readonly AgentToolSpec[];
	readonly reservedExternalMcpServerIds?: readonly string[];
	readonly onMcpServerStartError?: (error: unknown) => void;
}

export interface FleetAgentRuntimeServices {
	readonly carrierRuntime: CarrierRuntime;
	readonly dedicatedMcpSession: ExecutorSessionManager;
	readonly mcpRegistry: McpToolRegistry;
}

export interface FleetAgentRuntimeLifecycle extends FleetAgentRuntimeServices {
	cleanup(): Promise<void>;
}

interface FleetAgentRuntimeMcpServices {
	readonly name: string;
	readonly mcpServer: InProcessMcpServer;
	readonly mcpRegistry: McpToolRegistry;
	readonly mcpToolSnapshotStore: McpToolSnapshotStore;
}

const DEFAULT_RESERVED_EXTERNAL_MCP_SERVER_IDS = [
	FLEET_MCP_SERVER_NAME,
	"carrier",
	"wiki",
	"fleet-carriers",
	"fleet-wiki",
	"fleet-tools",
] as const;
const CHRONICLE_WIKI_TOOL_IDS = new Set([
	"wiki_drydock",
	"wiki_ingest",
	"wiki_patch_edit",
	"wiki_compile_source",
	"wiki_query",
]);

export function createFleetAgentRuntimeLifecycle(
	deps: FleetAgentRuntimeLifecycleDeps,
): FleetAgentRuntimeLifecycle {
	let active = true;
	const mcpRuntime = createFleetAgentRuntimeMcpServices();
	const carrierRuntime = createCarrierRuntime();
	const dedicatedMcpSession = createExecutorSessionManager({
		runtimes: [
			{
				name: mcpRuntime.name,
				runtime: {
					registry: mcpRuntime.mcpRegistry,
					server: mcpRuntime.mcpServer,
					snapshotStore: mcpRuntime.mcpToolSnapshotStore,
				},
			},
		],
	});

	registerExecutorPort(mcpRuntime.mcpRegistry, carrierRuntime, () => active);
	carrierRuntime.store.initStore(deps.dataDir);
	carrierRuntime.registerCarrierDefaults();
	registerFleetAgentRuntimeTools(mcpRuntime.mcpRegistry, carrierRuntime, deps);
	registerExecutorMcpRuntimeProvider(mcpRuntime, dedicatedMcpSession, () => active);
	void mcpRuntime.mcpServer.start().catch((error: unknown) => {
		deps.onMcpServerStartError?.(error);
	});

	return {
		carrierRuntime,
		dedicatedMcpSession,
		mcpRegistry: mcpRuntime.mcpRegistry,
		async cleanup() {
			active = false;
			dedicatedMcpSession.cleanup();
			await disconnectAll();
			await mcpRuntime.mcpServer.stop();
		},
	};
}

function createFleetAgentRuntimeMcpServices(): FleetAgentRuntimeMcpServices {
	const mcpRegistry = createMcpToolRegistry();
	const mcpToolSnapshotStore = createMcpToolSnapshotStore();
	const mcpServer = createInProcessMcpServer({
		serverInfo: { name: FLEET_MCP_SERVER_NAME },
		toolSnapshotStore: mcpToolSnapshotStore,
	});
	return {
		name: FLEET_MCP_SERVER_NAME,
		mcpRegistry,
		mcpServer,
		mcpToolSnapshotStore,
	};
}

function registerExecutorPort(
	mcpRegistry: McpToolRegistry,
	carrierRuntime: CarrierRuntime,
	isActive: () => boolean,
): void {
	executorPortRuntime.register({
		getScopeExternalMcpServerIds(scopeId) {
			if (!isActive()) return [];
			return scopeId
				? carrierRuntime.registry.getState().modes.get(scopeId)?.config.carrierMetadata?.allowedBuiltinExternalMcpServers ?? []
				: [];
		},
		getExecutorMcpTools(serverName, scopeId) {
			if (!isActive()) return [];
			if (serverName !== FLEET_MCP_SERVER_NAME) return [];
			return getExecutorMcpTools(mcpRegistry, carrierRuntime, scopeId);
		},
	});
}

function registerFleetAgentRuntimeTools(
	mcpRegistry: McpToolRegistry,
	carrierRuntime: CarrierRuntime,
	deps: FleetAgentRuntimeLifecycleDeps,
): void {
	registerAgentToolDefaults(mcpRegistry, carrierRuntime, {
		authEnvResolver: async () => ({}),
		reservedExternalMcpServerIds: buildReservedExternalMcpServerIds(deps.reservedExternalMcpServerIds),
		workspaceChangeScanner: deps.workspaceChangeScanner,
	});
	for (const spec of deps.wikiToolSpecs ?? []) {
		registerWikiToolSpec(mcpRegistry, spec);
	}
	for (const registration of deps.extraExecutorTools ?? []) {
		mcpRegistry.registerExecutorTool(registration.spec, registration.options);
	}
}

function registerWikiToolSpec(mcpRegistry: McpToolRegistry, spec: AgentToolSpec): void {
	if (spec.id === "wiki_patch_queue") {
		mcpRegistry.registerExecutorTool(spec, { allowedScopes: [] });
		return;
	}
	if (CHRONICLE_WIKI_TOOL_IDS.has(spec.id)) {
		mcpRegistry.registerExecutorTool(spec, { allowedScopes: ["chronicle"] });
		return;
	}
	mcpRegistry.registerExecutorTool(spec);
}

function registerExecutorMcpRuntimeProvider(
	mcpRuntime: FleetAgentRuntimeMcpServices,
	dedicatedMcpSession: ExecutorSessionManager,
	isActive: () => boolean,
): void {
	executorMcpRuntimeProviderRuntime.register({
		getExecutorMcpRouterRuntimes() {
			if (!isActive()) return [];
			return [
				{
					name: mcpRuntime.name,
					runtime: {
						registry: mcpRuntime.mcpRegistry,
						server: mcpRuntime.mcpServer,
						snapshotStore: mcpRuntime.mcpToolSnapshotStore,
					},
				},
			];
		},
		createExecutorMcpSession(request) {
			if (!isActive()) {
				throw new Error("Fleet agent runtime lifecycle is not active.");
			}
			return dedicatedMcpSession.createExecutorMcpSession(request);
		},
	});
}

function buildReservedExternalMcpServerIds(
	injectedIds: readonly string[] | undefined,
): readonly string[] {
	return [...new Set([...DEFAULT_RESERVED_EXTERNAL_MCP_SERVER_IDS, ...(injectedIds ?? [])])];
}
