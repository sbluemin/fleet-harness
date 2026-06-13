import { createCarrierRuntime, type CarrierRuntime } from "@dotobokuri/fleet-carriers";
import {
	FLEET_MCP_SERVER_NAME,
	getExecutorMcpTools,
	registerAgentToolDefaults,
} from "@dotobokuri/fleet-admiral";
import {
	createExecutorSessionManager,
	createInProcessMcpServer,
	createMcpToolRegistry,
	createMcpToolSnapshotStore,
	disconnectAll,
	executorMcpRuntimeProviderRuntime,
	executorPortRuntime,
	type AuthEnvResolver,
	type ExecutorSessionManager,
	type InProcessMcpServer,
	type McpToolSnapshotStore,
	type McpToolRegistry,
} from "@dotobokuri/core-agent";
import { createInfraServices, type InfraServices } from "@dotobokuri/fleet-infra";
import { resolveAuthEnv } from "@dotobokuri/fleet-infra/auth";
import { getFleetDataDir } from "@dotobokuri/fleet-infra/data-dir";
import { getWikiToolSpecs } from "@dotobokuri/fleet-wiki";

import { createConsoleRegisterPublisher, type ConsoleRegisterPublisher } from "./console-register-publisher.js";
import { reconcileRuntimeState } from "./reconciliation.js";
import { createWorkspaceChangeScanner } from "./workspace-scanner.js";

export interface RuntimeServices {
	readonly carrierRuntime: CarrierRuntime;
	readonly consolePublisher: ConsoleRegisterPublisher;
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
	readonly mcpServer: InProcessMcpServer;
	readonly mcpRegistry: McpToolRegistry;
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
	const dataDir = deps.dataDir ?? getFleetDataDir();
	const infraServices = createInfraServices();
	const mcpRuntimes = createRuntimeMcpServices();
	const carrierRuntime = createCarrierRuntime();
	const authEnvResolver: AuthEnvResolver = (cli) => resolveAuthEnv(cli, { authService: infraServices.authService });

	executorPortRuntime.register({
		getScopeExternalMcpServerIds(scopeId) {
			return scopeId
				? carrierRuntime.registry.getState().modes.get(scopeId)?.config.carrierMetadata?.allowedBuiltinExternalMcpServers ?? []
				: [];
		},
		getExecutorMcpTools(serverName, scopeId) {
			if (serverName !== FLEET_MCP_SERVER_NAME) return [];
			return getExecutorMcpTools(mcpRuntimes.mcpRegistry, carrierRuntime, scopeId);
		},
	});
	carrierRuntime.store.initStore(dataDir);
	carrierRuntime.registerCarrierDefaults();

	registerAgentToolDefaults(mcpRuntimes.mcpRegistry, carrierRuntime, {
		authEnvResolver,
		reservedExternalMcpServerIds: [FLEET_MCP_SERVER_NAME, "carrier", "wiki", "fleet-carriers", "fleet-wiki", "fleet-tools"],
		workspaceChangeScanner: createWorkspaceChangeScanner(),
	});
	for (const spec of getWikiToolSpecs()) {
		if (spec.id === "wiki_patch_queue") {
			mcpRuntimes.mcpRegistry.registerExecutorTool(spec, { allowedScopes: [] });
		} else if (
			spec.id === "wiki_drydock"
			|| spec.id === "wiki_ingest"
			|| spec.id === "wiki_patch_edit"
			|| spec.id === "wiki_compile_source"
			|| spec.id === "wiki_query"
		) {
			mcpRuntimes.mcpRegistry.registerExecutorTool(spec, { allowedScopes: ["chronicle"] });
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
	executorMcpRuntimeProviderRuntime.register({
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
		createExecutorMcpSession(request) {
			return dedicatedMcpSession.createExecutorMcpSession(request);
		},
	});
	const consolePublisher = createConsoleRegisterPublisher({
		cwd: process.cwd(),
		fleetVersion: getRuntimeVersion(),
		mcpServerName: mcpRuntimes.name,
		toolCount: mcpRuntimes.mcpRegistry.getAllAgentTools().length,
	});
	consolePublisher.start();
	const unsubscribeConsolePublisher = carrierRuntime.jobs.streaming.register((event) => {
		consolePublisher.publishJobEvent(event);
	});

	reconcileRuntimeState(carrierRuntime);

	return {
		services: {
			carrierRuntime,
			consolePublisher,
			dedicatedMcpSession,
			infraServices,
			mcpRegistry: [mcpRuntimes.mcpRegistry],
		},
		async shutdown() {
			dedicatedMcpSession.cleanup();
			unsubscribeConsolePublisher();
			await consolePublisher.cleanup();
			await disconnectAll();
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
	const mcpServer = createInProcessMcpServer({
		serverInfo: { name },
		toolSnapshotStore: mcpToolSnapshotStore,
	});
	return { name, mcpRegistry, mcpServer, mcpToolSnapshotStore };
}

function getRuntimeVersion(): string {
	return typeof process.env.npm_package_version === "string" ? process.env.npm_package_version : "0.0.0-dev";
}
