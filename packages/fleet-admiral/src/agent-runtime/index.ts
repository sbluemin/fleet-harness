import {
	createExecutorSessionManager,
	createInProcessMcpServer,
	createMcpToolRegistry,
	createMcpToolSnapshotStore,
	executorMcpRuntimeProviderRuntime,
	executorPortRuntime,
	type AgentToolSpec,
	type ExecutorSessionManager,
	type InProcessMcpServer,
	type McpToolRegistry,
	type McpToolSnapshotStore,
	type RegisterExecutorToolOptions,
	type AuthEnvResolver,
} from "@dotobokuri/core-agent";
import type { AuthService, GlobalOptionsService } from "@dotobokuri/core-infra";
import { getFleetDataDir } from "@dotobokuri/core-infra/data-dir";
import {
	createCarrierRuntime,
	type CarrierRuntime,
	type WorkspaceChangeScanner,
} from "@dotobokuri/fleet-carriers";

import { getProviderModelIds } from "@dotobokuri/core-unified-agent";

import {
	FLEET_MCP_SERVER_NAME,
	getExecutorMcpTools,
	registerAgentToolDefaults,
} from "../tools.js";
import { resolveAgentCliAuthEnv } from "../agent-cli/auth.js";
import {
	resolveKimiModelSelection,
	resolveKimiModelSelectionFromOverride,
} from "../agent-cli/kimi-model.js";

export interface FleetAgentRuntimeToolRegistration {
	readonly spec: AgentToolSpec;
	readonly options?: RegisterExecutorToolOptions;
}

export interface FleetAgentRuntimeLifecycleDeps {
	readonly dataDir?: string;
	readonly authService?: AuthService;
	readonly globalOptionsService?: GlobalOptionsService;
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
	"wiki_schema_list",
	"wiki_schema_read",
]);

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

export function createAuthEnvResolver(
	globalOptionsService: GlobalOptionsService | undefined,
	authService?: AuthService,
): AuthEnvResolver {
	return async (cli, context): Promise<Record<string, string>> => {
		if (cli === "claude-kimi") {
			// 명시적 모델 컨텍스트(캐리어별 선택)가 유효하면 우선 적용하고,
			// 그렇지 않으면 전역 설정의 프로바이더 기본 모델을 사용한다.
			const selection = context?.model && getProviderModelIds("claude-kimi").includes(context.model)
				? resolveKimiModelSelectionFromOverride(context.model, context.effort)
				: resolveKimiModelSelection(globalOptionsService);
			return resolveAgentCliAuthEnv(cli, authService, selection);
		}
		if (cli !== "codex" || !globalOptionsService) return {};
		try {
			const mode = globalOptionsService.load().codexLaunchMode;
			// 저장된 모드가 없으면 주입하지 않는다 — process.env 폴백과 기본 ACP 우선순위를 보존한다.
			if (!mode) return {};
			return { CODEX_USE_ACP: mode === "app-server" ? "false" : "true" };
		} catch {
			return {};
		}
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
		authEnvResolver: createAuthEnvResolver(deps.globalOptionsService, deps.authService),
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

function registerWikiToolSpec(mcpRegistry: McpToolRegistry, spec: AgentToolSpec): void {
	mcpRegistry.registerAgentTool(spec);
	if (spec.id === "wiki_patch_queue" || spec.id === "wiki_schema_create") {
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
