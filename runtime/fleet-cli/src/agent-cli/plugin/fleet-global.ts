import { existsSync } from "node:fs";
import path from "node:path";

import { linkUserFleetSourcesIntoPlugin } from "./internal.js";
import type { GlobalPluginBundle } from "./types.js";

const GLOBAL_FLEET_SOURCE_ENTRIES = ["skills", "agents", "hooks", ".mcp.json"] as const;

export const globalBundle: GlobalPluginBundle = {
  description: "Fleet global user-level agents, skills, hooks, and MCP plugin",
  directoryName: "fleet-global",
  displayName: "Fleet Global",
  hashFileName: ".fleet-global-codex-plugin.hash",
  name: "fleet-global",
  source: "global",
};

export function renderGlobalPluginRoot(pluginRoot: string, fleetRoot: string): void {
  linkUserFleetSourcesIntoPlugin(fleetRoot, pluginRoot);
}

export function globalFleetContentExists(fleetRoot: string): boolean {
  return GLOBAL_FLEET_SOURCE_ENTRIES.some((entry) => existsSync(path.join(fleetRoot, entry)));
}
