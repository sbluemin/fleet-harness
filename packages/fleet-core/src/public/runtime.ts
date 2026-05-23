import { startMcpServer, stopMcpServer } from "@sbluemin/fleet-mcp-server";
import { infra, registerExecutorPort } from "@sbluemin/fleet-infra";
import {
  getRegisteredCarrierConfig,
  initStore,
  registerDefaultCarriers,
} from "@sbluemin/fleet-carriers";
import {
  initRuntime as initAgentSessionRuntime,
  disconnectAll,
} from "@sbluemin/fleet-infra/agent";
import { getExecutorMcpTools as getFleetCoreExecutorMcpTools } from "../admiral/agent/tools.js";
import { registerFleetCoreDefaultAgentTools } from "../admiral/agent/bootstrap.js";
import { cleanupDedicatedMcpSessionsForRuntimeShutdown } from "../admiral/mcp.js";
import { setFleetCoreBootMode } from "../runtime-flags.js";

export type { FleetAdmiralServices } from "./admiral-services.js";
export type { FleetAdmiraltyServices } from "./admiralty-services.js";

export interface FleetCoreRuntimeOptions {
  readonly dataDir: string;
  readonly bootMode?: "dev" | "normal";
}

export interface FleetCoreShutdownHandle {
  shutdown(): Promise<void>;
}

export function bootFleetCore(
  options: FleetCoreRuntimeOptions,
): FleetCoreShutdownHandle {
  setFleetCoreBootMode(options.bootMode ?? "normal");
  if (options.dataDir === infra.dataDir.getFleetDataDir()) {
    infra.dataDir.migrateLegacyFleetDataDir(options.dataDir);
  }
  registerExecutorPort({
    getCarrierExternalMcpServerIds(carrierId) {
      return carrierId
        ? getRegisteredCarrierConfig(carrierId)?.carrierMetadata?.allowedBuiltinExternalMcpServers ?? []
        : [];
    },
    getExecutorMcpTools(carrierId) {
      return getFleetCoreExecutorMcpTools(carrierId);
    },
  });
  initAgentSessionRuntime(options.dataDir);
  initStore(options.dataDir);
  registerDefaultCarriers();
  const settings = infra.settings.create();
  infra.settings.initSettingsService(settings);

  registerFleetCoreDefaultAgentTools();
  void startMcpServer().catch((error: unknown) => {
    console.error("[fleet-core] Failed to start MCP server", error);
  });

  return {
    async shutdown() {
      await disconnectAll();
      cleanupDedicatedMcpSessionsForRuntimeShutdown();
      await stopMcpServer();
      infra.settings.resetSettingsService(settings);
    },
  };
}
