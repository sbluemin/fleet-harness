import { describe, expect, it } from "vitest";

import { createGatewayStalePolicy } from "../src/stale.js";

describe("gateway stale policy", () => {
  it("detects builds newer than the lock", () => {
    const policy = createGatewayStalePolicy({ fs: { statSync: () => ({ mtimeMs: 20 }) } as never });

    expect(policy.isBuildStale({ pid: 1, host: "127.0.0.1", port: 37283, endpoint: "http://127.0.0.1:37283/mcp", startedAt: 10, token: "token", version: "test" }, "server.mjs")).toBe(true);
  });
});
