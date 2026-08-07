import {
	createInProcessMcpServer,
	createMcpToolRegistry,
	createMcpToolSnapshotStore,
	type InProcessMcpServer,
	type McpToolRegistry,
	type McpToolSnapshotStore,
} from "@dotobokuri/core-agent";

import { FLEET_MCP_SERVER_NAME } from "../tools.js";

export interface FleetAgentRuntimeMcpServices {
	readonly name: string;
	readonly mcpServer: InProcessMcpServer;
	readonly mcpRegistry: McpToolRegistry;
	readonly mcpToolSnapshotStore: McpToolSnapshotStore;
}

export function createFleetAgentRuntimeMcpServices(): FleetAgentRuntimeMcpServices {
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
