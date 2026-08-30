import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { describe, expect, it, vi } from "vitest";

import { registerAiGatewayRoutes } from "../server/ai-gateway-routes.js";

describe("AI gateway Console route adapter", () => {
  it("registers the route and lifecycle cleanup", async () => {
    const registerRouter = vi.fn<(path: string, handler: RouteHandler) => void>();
    let cleanup: (() => void | Promise<void>) | undefined;
    const pluginDataDir = "/tmp/fleet-console-test/plugins/terminal";

    const runtime = registerAiGatewayRoutes({
      pluginId: "terminal",
      basePath: "/plugins/terminal",
      registerRouter,
      host: {
        paths: { pluginDataDir: () => pluginDataDir },
        theaterFlags: { register: () => () => undefined },
        lifecycle: {
          registerCleanup: (candidate: () => void | Promise<void>) => {
            cleanup = candidate;
            return () => undefined;
          },
        },
      },
    } as unknown as FleetPluginServerContext);

    expect(registerRouter).toHaveBeenCalledTimes(1);
    expect(registerRouter.mock.calls[0]?.[0]).toBe("ai-gateway");
    expect(cleanup).toBeTypeOf("function");
    expect(runtime.compactHookToken).toMatch(/^[0-9a-f-]{36}$/);
    await cleanup?.();
    expect(path.join(pluginDataDir, "ai-gateway")).toContain("plugins/terminal/ai-gateway");
  });
});
