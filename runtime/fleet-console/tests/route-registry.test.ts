import { describe, expect, it } from "vitest";

import { RouteRegistry } from "../core/host/transport/route-registry/registry.js";
import { UpgradeRegistry } from "../core/host/transport/route-registry/registry.js";

describe("route registries", () => {
  it("dispatches HTTP routes by exact prefix order", async () => {
    const registry = new RouteRegistry();
    const handled: string[] = [];
    registry.register("/api/v1/demo", ({ pathname }) => {
      handled.push(pathname);
      return true;
    });

    const result = await registry.handle({ req: {} as never, res: {} as never, pathname: "/api/v1/demo/api/ping" });

    expect(result).toBe(true);
    expect(handled).toEqual(["/api/v1/demo/api/ping"]);
  });

  it("dispatches upgrade routes by exact prefix order", () => {
    const registry = new UpgradeRegistry();
    registry.register("/api/v1/demo/ws", () => true);

    expect(registry.handle({ req: {} as never, socket: {} as never, head: Buffer.alloc(0), pathname: "/api/v1/demo/ws/stream" })).toBe(true);
    expect(registry.handle({ req: {} as never, socket: {} as never, head: Buffer.alloc(0), pathname: "/api/v1/demo/api" })).toBe(false);
  });
});
