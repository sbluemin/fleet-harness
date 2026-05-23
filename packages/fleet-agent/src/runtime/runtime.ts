// fleet-wiki agent specs는 모듈 로드 시 executor tool을 self-register한다.
import "@sbluemin/fleet-wiki";

import os from "node:os";
import path from "node:path";

import { createFleetAdmiral, cleanupDedicatedMcpSessionsForRuntimeShutdown, getExecutorMcpTools, registerDefaultAgentTools } from "@sbluemin/fleet-admiral";
import { createFleetAdmiralty } from "@sbluemin/fleet-admiralty";
import { createCarrierRuntime, getRegisteredCarrierConfig, initStore, registerDefaultCarriers } from "@sbluemin/fleet-carriers";
import { createInfraServices, infra, registerExecutorPort } from "@sbluemin/fleet-infra";
import { disconnectAll, initRuntime as initAgentSessionRuntime } from "@sbluemin/fleet-infra/agent";
import { startMcpServer, stopMcpServer } from "@sbluemin/fleet-mcp-server";

import { reconcileRuntimeState } from "./reconciliation.js";

interface RuntimeShutdownHandle {
	shutdown(): Promise<void>;
}

let shutdownHandle: RuntimeShutdownHandle | null = null;

export async function bootRuntime(): Promise<void> {
	const dataDir = path.join(os.homedir(), ".fleet");
	const infraServices = createInfraServices();
	const carrierRuntime = createCarrierRuntime({ config: {} });
	const fleetAdmiral = createFleetAdmiral({ config: {}, carrierRuntime, infraServices });
	const fleetAdmiralty = createFleetAdmiralty({ config: {}, fleetAdmiral });

	if (dataDir === infra.dataDir.getFleetDataDir()) {
		infra.dataDir.migrateLegacyFleetDataDir(dataDir);
	}
	registerExecutorPort({
		getCarrierExternalMcpServerIds(carrierId) {
			return carrierId
				? getRegisteredCarrierConfig(carrierId)?.carrierMetadata?.allowedBuiltinExternalMcpServers ?? []
				: [];
		},
		getExecutorMcpTools(carrierId) {
			return getExecutorMcpTools(carrierId);
		},
	});
	initAgentSessionRuntime(dataDir);
	initStore(dataDir);
	registerDefaultCarriers();
	const settings = infra.settings.create();
	infra.settings.initSettingsService(settings);

	registerDefaultAgentTools();
	void startMcpServer().catch((error: unknown) => {
		console.error("[fleet-agent] Failed to start MCP server", error);
	});
	shutdownHandle = {
		async shutdown() {
			void fleetAdmiralty;
			void fleetAdmiral;
			void carrierRuntime;
			void infraServices;
			await disconnectAll();
			cleanupDedicatedMcpSessionsForRuntimeShutdown();
			await stopMcpServer();
			infra.settings.resetSettingsService(settings);
		},
	};

	reconcileRuntimeState();
}

export async function shutdownRuntime(): Promise<void> {
	const handle = shutdownHandle;
	shutdownHandle = null;
	await handle?.shutdown();
}
