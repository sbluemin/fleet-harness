import type { ExecutorSessionManager, McpToolRegistry } from "@dotobokuri/core-agent";
import {
	createFleetAgentRuntimeLifecycle,
	type FleetAgentRuntimeLifecycle,
} from "@dotobokuri/fleet-admiral";
import type { CarrierRuntime } from "@dotobokuri/fleet-carriers";
import { createInfraServices, type InfraServices } from "@dotobokuri/fleet-infra";
import { getFleetDataDir } from "@dotobokuri/fleet-infra/data-dir";
import { getWikiToolSpecs } from "@dotobokuri/fleet-wiki";

import { reconcileRuntimeState } from "./reconciliation.js";
import { createWorkspaceChangeScanner } from "./workspace-scanner.js";

export interface RuntimeServices {
	readonly carrierRuntime: CarrierRuntime;
	readonly dataDir: string;
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

interface StartedRuntime {
	readonly agentRuntime: FleetAgentRuntimeLifecycle;
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
	const agentRuntime = createFleetAgentRuntimeLifecycle({
		dataDir,
		onMcpServerStartError: (error) => {
			console.error("[fleet-cli] Failed to start MCP server", error);
		},
		workspaceChangeScanner: createWorkspaceChangeScanner(),
		wikiToolSpecs: getWikiToolSpecs(),
	});
	reconcileRuntimeState(agentRuntime.carrierRuntime);

	return {
		agentRuntime,
		services: {
			carrierRuntime: agentRuntime.carrierRuntime,
			dataDir,
			dedicatedMcpSession: agentRuntime.dedicatedMcpSession,
			infraServices,
			mcpRegistry: [agentRuntime.mcpRegistry],
		},
		async shutdown() {
			await agentRuntime.cleanup();
		},
	};
}
