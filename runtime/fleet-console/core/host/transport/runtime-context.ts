import type { ApiCatalogEntry, FleetPluginHostCapabilities } from "@fleet-console/sdk/plugin";
import type { RouteHandler, UpgradeHandler } from "@fleet-console/sdk/routing";
import type { RouteRegistry, UpgradeRegistry } from "./route-registry/registry.js";

import type { ConsoleRuntimeHost, ConsoleRuntimeContext } from "../../../features/execution/host/context.js";

export function createConsoleRuntimeContext(deps: {
  readonly host: ConsoleRuntimeHost;
  readonly dataDir: string;
  readonly legacyDataDir: string;
  readonly routes: RouteRegistry;
  readonly upgrades: UpgradeRegistry;
  readonly catalog: ApiCatalogEntry[];
  readonly consoleControl?: import("../../../features/console-use/host/console-control.js").ConsoleControl;
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
    dataDir: deps.dataDir,
    legacyDataDir: deps.legacyDataDir,
    basePath,
    wsBasePath,
    registerRouter: (value, handler, catalog) => {
      const prefix = value.startsWith(`${basePath}/`) ? value : routePath(basePath, value);
      deps.routes.register(prefix, handler);
      // 이전 버전의 클라이언트·hook도 동일한 handler와 보안 게이트를 통과한다.
      const suffix = prefix.slice(basePath.length);
      const legacySuffix = suffix === "/agent/settings" ? "/settings" : suffix;
      for (const legacyBase of ["/plugins/terminal", "/api/v1/plugins/terminal"]) {
        const legacyPrefix = `${legacyBase}${legacySuffix}`;
        deps.routes.register(legacyPrefix, async (request) => {
          const pathname = `${prefix}${request.pathname.slice(legacyPrefix.length)}`;
          const previousUrl = request.req.url;
          request.req.url = previousUrl?.replace(legacyPrefix, prefix);
          try { return await handler({ ...request, pathname }); }
          finally { request.req.url = previousUrl; }
        });
      }
      record(prefix, catalog);
    },
    registerWsHandler: (value, handler, catalog) => {
      const prefix = routePath(wsBasePath, value);
      deps.upgrades.register(prefix, handler);
      deps.upgrades.register("/plugins/terminal/ws", (request) => handler({ ...request, pathname: prefix }));
      record(prefix, catalog);
    },
  };
}
