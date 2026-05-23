import os from "node:os";
import path from "node:path";

import { createCarrierRuntime } from "@sbluemin/fleet-carriers";
import { createInfraServices } from "@sbluemin/fleet-infra";
import { createMcpServer, createMcpToolRegistry, createMcpToolSnapshotStore } from "@sbluemin/fleet-mcp-server";
import { getWikiToolSpecs } from "@sbluemin/fleet-wiki";

import { createDedicatedMcpSession, type DedicatedMcpSessionPort } from "../admiral/mcp.js";
import { configureAgentToolRegistry, getExecutorMcpTools, registerAgentToolDefaults } from "../admiral/tools.js";
import { configureCarrierRuntime } from "./instances.js";
import { reconcileRuntimeState } from "./reconciliation.js";

export interface RuntimeServices {
	readonly dedicatedMcpSession: DedicatedMcpSessionPort;
}

interface RuntimeShutdownHandle {
	shutdown(): Promise<void>;
}

let shutdownHandle: RuntimeShutdownHandle | null = null;

export async function bootRuntime(): Promise<RuntimeServices> {
	const dataDir = path.join(os.homedir(), ".fleet");
	const infraServices = createInfraServices();
	const mcpRegistry = createMcpToolRegistry();
	const mcpToolSnapshotStore = createMcpToolSnapshotStore();
	const mcpServer = createMcpServer({
		registry: mcpRegistry,
		toolSnapshotStore: mcpToolSnapshotStore,
	});
	configureAgentToolRegistry(mcpRegistry);
	const carrierRuntime = createCarrierRuntime({ config: {} });
	configureCarrierRuntime(carrierRuntime);

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
		if (spec.id === "wiki_drydock" || spec.id === "wiki_ingest" || spec.id === "wiki_patch_edit" || spec.id === "wiki_query") {
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
	shutdownHandle = {
		async shutdown() {
			dedicatedMcpSession.cleanup();
			const disconnectAgentSessions = infraServices.agent.disconnectAll;
			await disconnectAgentSessions();
			await mcpServer.stop();
			infraServices.settingsRuntime.reset(settings);
			configureCarrierRuntime(null);
		},
	};

	reconcileRuntimeState();
	return { dedicatedMcpSession };
}

export async function shutdownRuntime(): Promise<void> {
	const handle = shutdownHandle;
	shutdownHandle = null;
	await handle?.shutdown();
}
