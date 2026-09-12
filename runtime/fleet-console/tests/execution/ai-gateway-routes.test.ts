import path from "node:path";

import type { ConsoleRuntimeContext } from "../../core/host/runtime-context.js";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { describe, expect, it, vi } from "vitest";

import { registerAiGatewayRoutes } from "../../core/host/ai-gateway/routes.js";

describe("AI gateway Console route adapter", () => {
  it("registers the route and lifecycle cleanup", async () => {
    const registerRouter = vi.fn<(path: string, handler: RouteHandler) => void>();
    let cleanup: (() => void | Promise<void>) | undefined;
    const pluginDataDir = "/tmp/fleet-console-test/api/v1";

    const runtime = registerAiGatewayRoutes({
      dataDir: pluginDataDir,
      legacyDataDir: pluginDataDir,
      basePath: "/api/v1",
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
    } as unknown as ConsoleRuntimeContext);

    expect(registerRouter).toHaveBeenCalledTimes(1);
    expect(registerRouter.mock.calls[0]?.[0]).toBe("ai-gateway");
    expect(cleanup).toBeTypeOf("function");
    expect(runtime.compactHookToken).toMatch(/^[0-9a-f-]{36}$/);
    await cleanup?.();
  });
});
