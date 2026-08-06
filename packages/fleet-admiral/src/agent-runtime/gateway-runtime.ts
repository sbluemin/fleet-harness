import {
	createExecutorSessionManager,
	type AgentToolSpec,
	type ExecutorSessionManager,
	type McpToolRegistry,
} from "@dotobokuri/core-agent";

import { createFleetAgentRuntimeMcpServices } from "./mcp-services.js";

export interface FleetGatewayAgentRuntimeLifecycleDeps {
	readonly wikiToolSpecs?: readonly AgentToolSpec[];
	readonly extraAgentTools?: readonly AgentToolSpec[];
}

export interface FleetGatewayAgentRuntimeLifecycle {
	readonly mcpRegistry: McpToolRegistry;
	readonly dedicatedMcpSession: ExecutorSessionManager;
	cleanup(): Promise<void>;
}

export async function createFleetGatewayAgentRuntimeLifecycle(
	deps: FleetGatewayAgentRuntimeLifecycleDeps,
): Promise<FleetGatewayAgentRuntimeLifecycle> {
	const mcpRuntime = createFleetAgentRuntimeMcpServices();
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

	for (const spec of deps.wikiToolSpecs ?? []) {
		mcpRuntime.mcpRegistry.registerAgentTool(spec);
	}
	for (const spec of deps.extraAgentTools ?? []) {
		mcpRuntime.mcpRegistry.registerAgentTool(spec);
	}

	try {
		await mcpRuntime.mcpServer.start();
	} catch (error) {
		dedicatedMcpSession.cleanup();
		await mcpRuntime.mcpServer.stop();
		throw error;
	}

	return {
		dedicatedMcpSession,
		mcpRegistry: mcpRuntime.mcpRegistry,
		async cleanup() {
			dedicatedMcpSession.cleanup();
			await mcpRuntime.mcpServer.stop();
		},
	};
}
