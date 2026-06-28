import { describe, expect, it } from "vitest";

import { RouteRegistry } from "../core/host/route-registry/route-registry.js";
import { UpgradeRegistry } from "../core/host/route-registry/upgrade-registry.js";

describe("route registries", () => {
  it("dispatches HTTP routes by exact prefix order", async () => {
    const registry = new RouteRegistry();
    const handled: string[] = [];
    registry.register("/plugins/demo", ({ pathname }) => {
      handled.push(pathname);
      return true;
    });

    const result = await registry.handle({ req: {} as never, res: {} as never, pathname: "/plugins/demo/api/ping" });

    expect(result).toBe(true);
    expect(handled).toEqual(["/plugins/demo/api/ping"]);
  });

  it("dispatches upgrade routes by exact prefix order", () => {
    const registry = new UpgradeRegistry();
    registry.register("/plugins/demo/ws", () => true);

    expect(registry.handle({ req: {} as never, socket: {} as never, head: Buffer.alloc(0), pathname: "/plugins/demo/ws/stream" })).toBe(true);
    expect(registry.handle({ req: {} as never, socket: {} as never, head: Buffer.alloc(0), pathname: "/plugins/demo/api" })).toBe(false);
  });
});
