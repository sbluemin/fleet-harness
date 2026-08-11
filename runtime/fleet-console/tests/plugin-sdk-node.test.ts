import { describe, expect, it, vi } from "vitest";

import { registerRouter, registerWsHandler } from "../sdk/plugin/node.js";
import type { ApiCatalogEntry, FleetPluginServerContext } from "../sdk/plugin/types.js";
import type { RouteHandler, UpgradeHandler } from "../sdk/routing/types.js";

const catalog: ApiCatalogEntry = {
  method: "GET",
  path: "/health",
  summary: "Health",
  category: "test",
  gate: "loopback",
  transport: "http",
};

function context(overrides: Partial<FleetPluginServerContext> = {}): FleetPluginServerContext {
  return overrides as FleetPluginServerContext;
}

describe("plugin SDK node helpers", () => {
  it("uses the handler as the second HTTP registrar argument on old hosts", async () => {
    const handler: RouteHandler = () => true;
    const register = vi.fn();

    registerRouter(context({ registerRouter: register }), "/health", catalog, handler);

    expect(register).toHaveBeenCalledWith("/health", handler);
    expect(register.mock.calls[0]?.[1]()).toBe(true);
  });

  it("passes HTTP metadata to marker-aware hosts", () => {
    const handler: RouteHandler = () => true;
    const register = vi.fn();

    registerRouter(context({ apiCatalogVersion: 1, registerRouter: register }), "/health", catalog, handler);

    expect(register).toHaveBeenCalledWith("/health", catalog, handler);
  });

  it("uses the handler as the second WebSocket registrar argument on old hosts", () => {
    const handler: UpgradeHandler = () => true;
    const register = vi.fn();

    registerWsHandler(context({ registerWsHandler: register }), "/health", catalog, handler);

    expect(register).toHaveBeenCalledWith("/health", handler);
    expect(register.mock.calls[0]?.[1]()).toBe(true);
  });

  it("passes WebSocket metadata to marker-aware hosts", () => {
    const handler: UpgradeHandler = () => true;
    const register = vi.fn();

    registerWsHandler(context({ apiCatalogVersion: 1, registerWsHandler: register }), "/health", catalog, handler);

    expect(register).toHaveBeenCalledWith("/health", catalog, handler);
  });
});
