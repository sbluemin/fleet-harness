import type { ApiCatalogEntry, FleetPluginHostCapabilities } from "@fleet-console/sdk/plugin";
import type { RouteHandler, UpgradeHandler } from "@fleet-console/sdk/routing";
import type { RouteRegistry, UpgradeRegistry } from "./route-registry/registry.js";

type ConsoleRuntimeHost = Pick<FleetPluginHostCapabilities, "consoleUse" | "aiGatewayMcp" | "mcpTransport" | "events" | "server" | "http" | "security" | "lifecycle" | "experiments"> & {
  readonly admiralMcp: Pick<FleetPluginHostCapabilities["admiralMcp"], "connect">;
  readonly operations: Pick<FleetPluginHostCapabilities["operations"], "list" | "get" | "create" | "patch" | "delete">;
  readonly paths: Omit<FleetPluginHostCapabilities["paths"], "pluginDataDir">;
};

/** Console이 직접 구성하는 실행 기능의 의존성. 플러그인 신원·manifest·로더를 갖지 않는다. */
export interface ConsoleRuntimeContext {
  readonly basePath: string;
  readonly wsBasePath: string;
  readonly dataDir: string;
  readonly legacyDataDir: string;
  readonly host: ConsoleRuntimeHost;
  registerRouter(path: string, handler: RouteHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
  registerWsHandler(path: string, handler: UpgradeHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
}

export function createConsoleRuntimeContext(deps: {
  readonly host: ConsoleRuntimeHost;
  readonly dataDir: string;
  readonly legacyDataDir: string;
  readonly routes: RouteRegistry;
  readonly upgrades: UpgradeRegistry;
  readonly catalog: ApiCatalogEntry[];
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

export function registerRouter(ctx: ConsoleRuntimeContext, path: string, handler: RouteHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void {
  ctx.registerRouter(path, handler, catalog);
}

export function registerWsHandler(ctx: ConsoleRuntimeContext, path: string, handler: UpgradeHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void {
  ctx.registerWsHandler(path, handler, catalog);
}
