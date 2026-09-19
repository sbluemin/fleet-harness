import type { ApiCatalogEntry, FleetPluginHostCapabilities } from "@fleet-console/sdk/plugin";
import type { RouteHandler, UpgradeHandler } from "@fleet-console/sdk/routing";

export type ConsoleRuntimeHost = Pick<FleetPluginHostCapabilities, "consoleUse" | "aiGatewayMcp" | "mcpTransport" | "events" | "server" | "http" | "security" | "lifecycle" | "experiments"> & {
  readonly admiralMcp: Pick<FleetPluginHostCapabilities["admiralMcp"], "connect">;
  readonly computerUseMcp?: { connect(): import("../../computer-use/host/mcp.js").ComputerUseMcpConnection; revokeOperation(operationId: string): void };
  readonly browserMcp?: { connect(): import("../../browser/host/mcp.js").BrowserMcpConnection; revokeOperation(operationId: string): void; interruptOperation(operationId: string): number; bindTerminalPaste(paste: (operationId: string) => boolean): () => void; endAgentSession(operationId: string): void };
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
  readonly consoleControl?: import("../../console-use/host/console-control.js").ConsoleControl;
  registerRouter(path: string, handler: RouteHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
  registerWsHandler(path: string, handler: UpgradeHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
}

export function registerRouter(ctx: ConsoleRuntimeContext, path: string, handler: RouteHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void {
  ctx.registerRouter(path, handler, catalog);
}

export function registerWsHandler(ctx: ConsoleRuntimeContext, path: string, handler: UpgradeHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void {
  ctx.registerWsHandler(path, handler, catalog);
}
