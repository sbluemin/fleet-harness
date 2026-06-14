import type { AuthEnvResolver, ExecutorSessionManager, McpToolRegistry } from "@dotobokuri/core-agent";
import {
	FLEET_MCP_SERVER_NAME,
	createFleetAgentRuntimeLifecycle,
	type FleetAgentRuntimeLifecycle,
} from "@dotobokuri/fleet-admiral";
import type { CarrierRuntime } from "@dotobokuri/fleet-carriers";
import { createInfraServices, type InfraServices } from "@dotobokuri/fleet-infra";
import { resolveAuthEnv } from "@dotobokuri/fleet-infra/auth";
import { getFleetDataDir } from "@dotobokuri/fleet-infra/data-dir";
import { getWikiToolSpecs } from "@dotobokuri/fleet-wiki";

import { createConsoleRegisterPublisher, type ConsoleRegisterPublisher } from "./console-register-publisher.js";
import { reconcileRuntimeState } from "./reconciliation.js";
import { createWorkspaceChangeScanner } from "./workspace-scanner.js";

export interface RuntimeServices {
	readonly authEnvResolver: AuthEnvResolver;
	readonly carrierRuntime: CarrierRuntime;
	readonly consolePublisher: ConsoleRegisterPublisher;
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
	readonly consoleRegister?: boolean;
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
	const authEnvResolver: AuthEnvResolver = (cli) => resolveAuthEnv(cli, { authService: infraServices.authService });
	const agentRuntime = createFleetAgentRuntimeLifecycle({
		authEnvResolver,
		dataDir,
		onMcpServerStartError: (error) => {
			console.error("[fleet-cli] Failed to start MCP server", error);
		},
		workspaceChangeScanner: createWorkspaceChangeScanner(),
		wikiToolSpecs: getWikiToolSpecs(),
	});
	const consolePublisher = createConsoleRegisterPublisher({
		cwd: process.cwd(),
		env: process.env,
		fleetVersion: getRuntimeVersion(),
		mcpServerName: FLEET_MCP_SERVER_NAME,
		toolCount: agentRuntime.mcpRegistry.getAllAgentTools().length,
	});
	let unsubscribeConsolePublisher = () => {};
	if (deps.consoleRegister === true) {
		consolePublisher.start();
		unsubscribeConsolePublisher = agentRuntime.carrierRuntime.jobs.streaming.register((event) => {
			consolePublisher.publishJobEvent(event);
		});
	}

	reconcileRuntimeState(agentRuntime.carrierRuntime);

	return {
		agentRuntime,
		services: {
			authEnvResolver,
			carrierRuntime: agentRuntime.carrierRuntime,
			consolePublisher,
			dataDir,
			dedicatedMcpSession: agentRuntime.dedicatedMcpSession,
			infraServices,
			mcpRegistry: [agentRuntime.mcpRegistry],
		},
		async shutdown() {
			unsubscribeConsolePublisher();
			await consolePublisher.cleanup();
			await agentRuntime.cleanup();
		},
	};
}

function getRuntimeVersion(): string {
	return typeof process.env.npm_package_version === "string" ? process.env.npm_package_version : "0.0.0-dev";
}
