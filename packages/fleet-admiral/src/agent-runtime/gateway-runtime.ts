import {
	createExecutorSessionManager,
	type ExecutorSessionManager,
	type McpToolRegistry,
} from "@dotobokuri/core-agent";

import { createFleetAgentRuntimeMcpServices } from "./mcp-services.js";

type AdditionalMcpSession = Pick<ExecutorSessionManager, "getEndpoint" | "issueSessionToken" | "releaseSessionToken" | "cleanup">;

export interface FleetGatewayAgentRuntimeLifecycleDeps {
	/** 추가 연결은 호스트가 소유하며 이 런타임은 발급한 세션 토큰만 회수한다. */
	readonly additionalMcpSessions?: readonly AdditionalMcpSession[];
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
	const coreSession = createExecutorSessionManager({
		runtimes: [{
			name: mcpRuntime.name,
			runtime: {
				registry: mcpRuntime.mcpRegistry,
				server: mcpRuntime.mcpServer,
				snapshotStore: mcpRuntime.mcpToolSnapshotStore,
			},
		}],
	});
	const sessions = deps.additionalMcpSessions ?? [];
	const dedicatedMcpSession: ExecutorSessionManager = {
		async getEndpoint() {
			const endpoints = await Promise.all(sessions.map((session) => session.getEndpoint()));
			const servers = endpoints.flatMap((endpoint) => endpoint.servers);
			if (new Set(servers.map((server) => server.name)).size !== servers.length) throw new Error("Duplicate MCP server name");
			return { servers };
		},
		issueSessionToken(request) {
			try {
				return sessions.flatMap((session) => session.issueSessionToken(request));
			} catch (error) {
				for (const session of sessions) session.releaseSessionToken(request.label);
				throw error;
			}
		},
		createExecutorMcpSession: (request) => coreSession.createExecutorMcpSession(request),
		releaseSessionToken: (label) => { for (const session of sessions) session.releaseSessionToken(label); },
		cleanup: () => { for (const session of sessions) session.cleanup(); },
	};

	return {
		dedicatedMcpSession,
		mcpRegistry: mcpRuntime.mcpRegistry,
		async cleanup() {
			dedicatedMcpSession.cleanup();
			await mcpRuntime.mcpServer.stop();
		},
	};
}
