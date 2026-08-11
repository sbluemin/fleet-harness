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
  handler: RouteHandler,
  catalog: ApiCatalogEntry | readonly ApiCatalogEntry[],
): void;
export function registerRouter(
  ctx: FleetPluginServerContext,
  path: string,
  handler: RouteHandler,
  catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[],
): void {
  if (catalog) {
    ctx.registerRouter(normalizePath(path), handler, catalog);
    return;
  }
  ctx.registerRouter(normalizePath(path), handler);
}

export function registerWsHandler(ctx: FleetPluginServerContext, path: string, handler: UpgradeHandler): void;
export function registerWsHandler(
  ctx: FleetPluginServerContext,
  path: string,
  handler: UpgradeHandler,
  catalog: ApiCatalogEntry | readonly ApiCatalogEntry[],
): void;
export function registerWsHandler(
  ctx: FleetPluginServerContext,
  path: string,
  handler: UpgradeHandler,
  catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[],
): void {
  if (catalog) {
    ctx.registerWsHandler(normalizePath(path), handler, catalog);
    return;
  }
  ctx.registerWsHandler(normalizePath(path), handler);
}

export function registerLaunchCatalog(ctx: FleetPluginServerContext, provider: OperationLaunchCatalogProvider): () => void {
  return ctx.host.operations.registerLaunchCatalog(ctx.pluginId, provider);
}

function normalizePath(path: string): string {
  if (path.length === 0 || path === "/") return "/";
  return path;
}
