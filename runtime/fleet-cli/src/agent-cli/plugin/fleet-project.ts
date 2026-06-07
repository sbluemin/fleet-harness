import { lstatSync, statSync } from "node:fs";
import path from "node:path";

import { linkUserFleetSourcesIntoPlugin } from "./internal.js";
import type { CreateAgentCliPluginOptions, ProjectPluginBundle } from "./types.js";

export const projectBundle: ProjectPluginBundle = {
  description: "Fleet project-local agents, skills, hooks, and MCP plugin",
  directoryName: "fleet-project",
  displayName: "Fleet Project",
  hashFileName: ".fleet-project-codex-plugin.hash",
  name: "fleet-project",
  source: "project",
};

export function renderProjectPluginRoot(pluginRoot: string, options: CreateAgentCliPluginOptions): void {
  const fleetProjectRoot = resolveProjectFleetRoot(options.cwd);
  linkUserFleetSourcesIntoPlugin(fleetProjectRoot, pluginRoot);
}

export function resolveProjectFleetRoot(cwd: string): string {
  const fleetProjectRoot = path.join(cwd, ".fleet");
  const sourceStat = lstatSync(fleetProjectRoot);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Fleet project plugin source root is a symlink: ${fleetProjectRoot}`);
  }
  const verifiedStat = statSync(fleetProjectRoot);
  if (!verifiedStat.isDirectory()) {
    throw new Error(`Fleet project plugin source root is not a directory: ${fleetProjectRoot}`);
  }
  return fleetProjectRoot;
}
