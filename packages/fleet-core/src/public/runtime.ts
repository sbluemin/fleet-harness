import { startMcpServer, stopMcpServer } from "@sbluemin/fleet-mcp-server";
import { infra } from "@sbluemin/fleet-infra";
import { initStore } from "../admiral/store/fleet-store.js";
import { initRuntime as initAgentSessionRuntime } from "../admiral/agent/internal/session-runtime.js";
import { registerFleetCoreDefaultAgentTools } from "../admiral/agent/bootstrap.js";
import { disconnectAll } from "../admiral/agent/connections.js";
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
  initAgentSessionRuntime(options.dataDir);
  initStore(options.dataDir);
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
