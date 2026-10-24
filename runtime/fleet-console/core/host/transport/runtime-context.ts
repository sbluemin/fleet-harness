import type { ClaudeProcessSpawner } from "@fleet-console/agent-runtime/claude";
import type { AgentCliPlugin, LaunchPromptDirectoryAllocator } from "@fleet-console/agent-runtime/fleet";
import type { AgentOptionsService } from "@fleet-console/infra";
import type { ApiCatalogEntry } from "@fleet-console/infra/http/catalog";
import type { RouteHandler, UpgradeHandler } from "@fleet-console/infra/http/routing";
import type { RouteRegistry, UpgradeRegistry } from "./route-registry/registry.js";

import type { ConsoleRuntimeHost, ConsoleRuntimeContext } from "../../../features/execution/host/context.js";

export function createConsoleRuntimeContext(deps: {
  readonly host: ConsoleRuntimeHost;
  readonly dataDir: string;
  readonly recordFailure?: (kind: string, error: unknown) => void;
  readonly agentOptions: AgentOptionsService;
  readonly agentCliPlugin: AgentCliPlugin;
  readonly launchPromptDirectories?: LaunchPromptDirectoryAllocator;
  readonly spawnAgentProcess: ClaudeProcessSpawner;
  readonly routes: RouteRegistry;
  readonly upgrades: UpgradeRegistry;
  readonly catalog: ApiCatalogEntry[];
  readonly consoleControl?: import("../../../features/console-use/host/console-control.js").ConsoleControl;
  readonly agentCallRedirect?: (objectiveId: string) => string | null;
}): ConsoleRuntimeContext {
  const basePath = "/api/v1";
  const wsBasePath = "/api/v1/terminal/ws";
  const routePath = (prefix: string, value: string) => value === "/" ? prefix : `${prefix}/${value.replace(/^\/+/, "")}`;
  const record = (prefix: string, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]) => {
    for (const entry of catalog ? Array.isArray(catalog) ? catalog : [catalog] : []) {
      deps.catalog.push({ ...entry, path: `${prefix}${entry.path === "/" ? "" : entry.path}` });
    }
  };
  return {
    host: deps.host,
    consoleControl: deps.consoleControl,
    ...(deps.agentCallRedirect ? { agentCallRedirect: deps.agentCallRedirect } : {}),
    dataDir: deps.dataDir,
    recordFailure: deps.recordFailure,
    agentOptions: deps.agentOptions,
    agentCliPlugin: deps.agentCliPlugin,
    ...(deps.launchPromptDirectories ? { launchPromptDirectories: deps.launchPromptDirectories } : {}),
    spawnAgentProcess: deps.spawnAgentProcess,
    basePath,
    wsBasePath,
    registerRouter: (value, handler, catalog) => {
      const prefix = value.startsWith(`${basePath}/`) ? value : routePath(basePath, value);
      deps.routes.register(prefix, handler);
      record(prefix, catalog);
    },
    registerWsHandler: (value, handler, catalog) => {
      const prefix = routePath(wsBasePath, value);
      deps.upgrades.register(prefix, handler);
      record(prefix, catalog);
    },
  };
}
