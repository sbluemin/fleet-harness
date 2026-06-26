import type { OperationLaunchCatalogProvider } from "../operations/types.js";
import type { RouteHandler, UpgradeHandler } from "../routing/types.js";
import type { FleetPluginDefinition, FleetPluginServerContext } from "./types.js";

export function definePlugin(definition: FleetPluginDefinition): FleetPluginDefinition {
  return definition;
}

export function registerRouter(ctx: FleetPluginServerContext, path: string, handler: RouteHandler): void {
  ctx.registerRouter(normalizePath(path), handler);
}

export function registerWsHandler(ctx: FleetPluginServerContext, path: string, handler: UpgradeHandler): void {
  ctx.registerWsHandler(normalizePath(path), handler);
}

export function registerLaunchCatalog(ctx: FleetPluginServerContext, provider: OperationLaunchCatalogProvider): () => void {
  return ctx.host.operations.registerLaunchCatalog(ctx.pluginId, provider);
}

function normalizePath(path: string): string {
  if (path.length === 0 || path === "/") return "/";
  return path;
}
