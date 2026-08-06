import {
	createInProcessMcpServer,
	createMcpToolRegistry,
	createMcpToolSnapshotStore,
	type AgentToolSpec,
	type InProcessMcpServer,
	type McpToolRegistry,
	type McpToolSnapshotStore,
} from "@dotobokuri/core-agent";

import {
	FLEET_MCP_SERVER_NAME,
	GLOBAL_READONLY_WIKI_TOOL_IDS,
} from "../tools.js";

export interface FleetAgentRuntimeMcpServices {
	readonly name: string;
	readonly mcpServer: InProcessMcpServer;
	readonly mcpRegistry: McpToolRegistry;
	readonly mcpToolSnapshotStore: McpToolSnapshotStore;
}

export const DEFAULT_RESERVED_EXTERNAL_MCP_SERVER_IDS = [
	FLEET_MCP_SERVER_NAME,
	"carrier",
	"wiki",
	"fleet-carriers",
	"fleet-wiki",
	"fleet-tools",
] as const;

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

export function registerWikiToolSpec(mcpRegistry: McpToolRegistry, spec: AgentToolSpec): void {
	mcpRegistry.registerAgentTool(spec);
	// 읽기 전용 도구만 executor(캐리어)에 글로벌 노출한다. 그 외 Wiki 도구는 host-only —
	// 호스트가 orient·구성·ingest·승인까지 직접 수행하므로 어떤 캐리어에도 노출하지 않는다.
	if (GLOBAL_READONLY_WIKI_TOOL_IDS.has(spec.id)) {
		mcpRegistry.registerExecutorTool(spec);
	}
}

export function buildReservedExternalMcpServerIds(
	injectedIds: readonly string[] | undefined,
): readonly string[] {
	return [...new Set([...DEFAULT_RESERVED_EXTERNAL_MCP_SERVER_IDS, ...(injectedIds ?? [])])];
}
