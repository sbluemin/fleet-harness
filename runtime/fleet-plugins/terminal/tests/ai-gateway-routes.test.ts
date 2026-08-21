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

    registerAiGatewayRoutes({
      pluginId: "terminal",
      basePath: "/plugins/terminal",
      registerRouter,
      host: {
        paths: { pluginDataDir: () => pluginDataDir },
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
    await cleanup?.();
    expect(path.join(pluginDataDir, "ai-gateway")).toContain("plugins/terminal/ai-gateway");
  });

  it("hands out panel gateways only while the setting says so", async () => {
    let dedicated = false;
    const { cleanup, pool } = register({ dedicatedGatewayPerPanel: () => dedicated });

    expect(pool.claim("op-1")).toBe("");
    expect(pool.size()).toBe(0);

    dedicated = true;
    expect(pool.claim("op-2")).toBe("op-2");
    expect(pool.size()).toBe(1);

    await cleanup?.();
    // 호스트가 내려가면 패널 라우터도 함께 회수된다. 남겨 두면 라우터가 쥔 업스트림 소켓이
    // Console보다 오래 산다.
    expect(pool.size()).toBe(0);
  });

  it("keeps every launch on the shared gateway when the host does not wire the setting", () => {
    const { pool } = register({});

    expect(pool.claim("op-1")).toBe("");
    expect(pool.size()).toBe(0);
  });
});

function register(deps: Parameters<typeof registerAiGatewayRoutes>[1]) {
  let cleanup: (() => void | Promise<void>) | undefined;
  const pool = registerAiGatewayRoutes({
    pluginId: "terminal",
    basePath: "/plugins/terminal",
    registerRouter: () => undefined,
    host: {
      paths: { pluginDataDir: () => "/tmp/fleet-console-test/plugins/terminal" },
      lifecycle: {
        registerCleanup: (candidate: () => void | Promise<void>) => {
          cleanup = candidate;
          return () => undefined;
        },
      },
    },
  } as unknown as FleetPluginServerContext, deps);
  return { cleanup, pool };
}
