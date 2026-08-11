import { describe, expect, it, vi } from "vitest";

import { registerRouter, registerWsHandler } from "../sdk/plugin/node.js";
import type { ApiCatalogEntry, FleetPluginServerContext } from "../sdk/plugin/types.js";
import type { RouteHandler, UpgradeHandler } from "../sdk/routing/types.js";

const catalog: ApiCatalogEntry = { method: "GET", path: "/health", summary: "Health", category: "test", gate: "loopback", transport: "http" };
const context = (values: Partial<FleetPluginServerContext>) => values as FleetPluginServerContext;

const legacyRegisterRouter = (ctx: FleetPluginServerContext, path: string, handler: RouteHandler) => ctx.registerRouter(path, handler);
const legacyRegisterWsHandler = (ctx: FleetPluginServerContext, path: string, handler: UpgradeHandler) => ctx.registerWsHandler(path, handler);

describe("plugin SDK node helpers", () => {
  it("old bundled HTTP helper ignores trailing catalog metadata", () => {
    const handler: RouteHandler = () => true;
    const register = vi.fn((_path: string, actual: RouteHandler) => actual({} as never));
    const oldContext = context({ registerRouter: register });

    (legacyRegisterRouter as unknown as (ctx: FleetPluginServerContext, path: string, handler: RouteHandler, catalog: ApiCatalogEntry) => void)(oldContext, "/health", handler, catalog);

    expect(register).toHaveBeenCalledWith("/health", handler);
    expect(register.mock.calls[0]?.[1]({} as never)).toBe(true);
  });

  it("old bundled WebSocket helper ignores trailing catalog metadata", () => {
    const handler: UpgradeHandler = () => true;
    const register = vi.fn((_path: string, actual: UpgradeHandler) => actual({} as never));
    const oldContext = context({ registerWsHandler: register });

    (legacyRegisterWsHandler as unknown as (ctx: FleetPluginServerContext, path: string, handler: UpgradeHandler, catalog: ApiCatalogEntry) => void)(oldContext, "/health", handler, catalog);

    expect(register).toHaveBeenCalledWith("/health", handler);
    expect(register.mock.calls[0]?.[1]({} as never)).toBe(true);
  });

  it("current helper registers HTTP handler with trailing catalog on old host", () => {
    const handler: RouteHandler = () => true;
    const register = vi.fn();
    registerRouter(context({ registerRouter: register }), "/health", handler, catalog);
    expect(register).toHaveBeenCalledWith("/health", handler, catalog);
  });

  it("current helper registers WebSocket handler with trailing catalog on current host", () => {
    const handler: UpgradeHandler = () => true;
    const register = vi.fn();
    registerWsHandler(context({ registerWsHandler: register }), "/health", handler, catalog);
    expect(register).toHaveBeenCalledWith("/health", handler, catalog);
  });
});
