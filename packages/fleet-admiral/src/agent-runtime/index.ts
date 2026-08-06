import {
	createExecutorSessionManager,
	executorMcpRuntimeProviderRuntime,
	executorPortRuntime,
	type AgentToolSpec,
	type ExecutorSessionManager,
	type McpToolRegistry,
	type RegisterExecutorToolOptions,
} from "@dotobokuri/core-agent";
import { getFleetDataDir } from "@dotobokuri/core-infra/data-dir";
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
import {
	buildReservedExternalMcpServerIds,
	createFleetAgentRuntimeMcpServices,
	registerWikiToolSpec,
	type FleetAgentRuntimeMcpServices,
} from "./mcp-services.js";

export interface FleetAgentRuntimeToolRegistration {
	readonly spec: AgentToolSpec;
	readonly options?: RegisterExecutorToolOptions;
}

export interface FleetAgentRuntimeLifecycleDeps {
	readonly dataDir?: string;
	readonly workspaceChangeScanner?: WorkspaceChangeScanner;
	readonly extraAgentTools?: readonly AgentToolSpec[];
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

export function createFleetAgentRuntimeLifecycle(
	deps: FleetAgentRuntimeLifecycleDeps,
): FleetAgentRuntimeLifecycle {
	let active = true;
	const resolvedDataDir = deps.dataDir ?? getFleetDataDir();
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
	carrierRuntime.store.initStore(resolvedDataDir);
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
			// Ordering matters: stop admission, then let the Carrier runtime cancel and
			// await every in-flight one-shot dispatch (disconnecting its client) BEFORE
			// dedicated MCP sessions and the MCP server are torn down.
			active = false;
			await carrierRuntime.cleanup();
			dedicatedMcpSession.cleanup();
			await mcpRuntime.mcpServer.stop();
		},
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
	for (const spec of deps.extraAgentTools ?? []) {
		mcpRegistry.registerAgentTool(spec);
	}
	for (const registration of deps.extraExecutorTools ?? []) {
		mcpRegistry.registerExecutorTool(registration.spec, registration.options);
	}
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
