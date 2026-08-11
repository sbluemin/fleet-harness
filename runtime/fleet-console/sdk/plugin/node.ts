import type { OperationLaunchCatalogProvider } from "../operations/types.js";
import type { RouteHandler, UpgradeHandler } from "../routing/types.js";
import type { ApiCatalogEntry, FleetPluginDefinition, FleetPluginServerContext } from "./types.js";

export function definePlugin(definition: FleetPluginDefinition): FleetPluginDefinition {
  return definition;
}

export function registerRouter(ctx: FleetPluginServerContext, path: string, handler: RouteHandler): void;
export function registerRouter(
  ctx: FleetPluginServerContext,
  path: string,
  catalog: ApiCatalogEntry | readonly ApiCatalogEntry[],
  handler: RouteHandler,
): void;
export function registerRouter(
  ctx: FleetPluginServerContext,
  path: string,
  catalogOrHandler: ApiCatalogEntry | readonly ApiCatalogEntry[] | RouteHandler,
  metadataHandler?: RouteHandler,
): void {
  if (metadataHandler && ctx.apiCatalogVersion === 1) {
    ctx.registerRouter(normalizePath(path), catalogOrHandler as ApiCatalogEntry | readonly ApiCatalogEntry[], metadataHandler);
    return;
  }
  ctx.registerRouter(normalizePath(path), metadataHandler ?? catalogOrHandler as RouteHandler);
}

export function registerWsHandler(ctx: FleetPluginServerContext, path: string, handler: UpgradeHandler): void;
export function registerWsHandler(
  ctx: FleetPluginServerContext,
  path: string,
  catalog: ApiCatalogEntry | readonly ApiCatalogEntry[],
  handler: UpgradeHandler,
): void;
export function registerWsHandler(
  ctx: FleetPluginServerContext,
  path: string,
  catalogOrHandler: ApiCatalogEntry | readonly ApiCatalogEntry[] | UpgradeHandler,
  metadataHandler?: UpgradeHandler,
): void {
  if (metadataHandler && ctx.apiCatalogVersion === 1) {
    ctx.registerWsHandler(normalizePath(path), catalogOrHandler as ApiCatalogEntry | readonly ApiCatalogEntry[], metadataHandler);
    return;
  }
  ctx.registerWsHandler(normalizePath(path), metadataHandler ?? catalogOrHandler as UpgradeHandler);
}

export function registerLaunchCatalog(ctx: FleetPluginServerContext, provider: OperationLaunchCatalogProvider): () => void {
  return ctx.host.operations.registerLaunchCatalog(ctx.pluginId, provider);
}

function normalizePath(path: string): string {
  if (path.length === 0 || path === "/") return "/";
  return path;
}
