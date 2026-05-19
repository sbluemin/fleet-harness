import { startMcpServer, stopMcpServer } from "@sbluemin/fleet-mcp-server";
import { initStore } from "../admiral/store/fleet-store.js";
import { initRuntime as initAgentSessionRuntime } from "../admiral/agent/internal/session-runtime.js";
import { registerFleetCoreDefaultAgentTools } from "../admiral/agent/bootstrap.js";
import { disconnectAll } from "../admiral/agent/connections.js";
import { cleanupDedicatedMcpSessionsForRuntimeShutdown } from "../admiral/mcp.js";
import { setFleetCoreBootMode } from "../runtime-flags.js";
import {
  createFleetAdmiralServices,
  type FleetAdmiralServices,
} from "./admiral-services.js";
import {
  createFleetAdmiraltyServices,
  type FleetAdmiraltyServices,
} from "./admiralty-services.js";
import {
  createFleetInfraServices,
  type FleetInfraServices,
} from "./infra-services.js";

export type { FleetAdmiralServices } from "./admiral-services.js";
export type { FleetAdmiraltyServices } from "./admiralty-services.js";
export type { FleetInfraServices } from "./infra-services.js";

export interface FleetCoreRuntimeOptions {
  readonly dataDir: string;
  readonly bootMode?: "dev" | "normal";
}

export interface FleetCoreRuntimeContext {
  readonly admiral: FleetAdmiralServices;
  readonly admiralty: FleetAdmiraltyServices;
  readonly infra: FleetInfraServices;
  shutdown(): Promise<void>;
}

export function createFleetCoreRuntime(
  options: FleetCoreRuntimeOptions,
): FleetCoreRuntimeContext {
  const infra = createFleetInfraServices();
  setFleetCoreBootMode(options.bootMode ?? "normal");
  if (options.dataDir === infra.dataDir.getFleetDataDir()) {
    infra.dataDir.migrateLegacyFleetDataDir(options.dataDir);
  }
  initAgentSessionRuntime(options.dataDir);
  initStore(options.dataDir);
  const settings = infra.settings.create();
  infra.settings.initSettingsService(settings);

  registerFleetCoreDefaultAgentTools();
  void startMcpServer().catch((error: unknown) => {
    console.error("[fleet-core] Failed to start MCP server", error);
  });

  return {
    admiral: createFleetAdmiralServices(),
    admiralty: createFleetAdmiraltyServices(),
    infra,
    async shutdown() {
      await disconnectAll();
      cleanupDedicatedMcpSessionsForRuntimeShutdown();
      await stopMcpServer();
      infra.settings.resetSettingsService(settings);
    },
  };
}
