import { describe, expect, it } from "vitest";

import { createGatewayCallQueue } from "../src/call-queue.js";
import { createGatewayMcpJsonRpcRouter } from "../src/mcp-jsonrpc.js";
import type { GatewaySessionRecord } from "../src/tenant-store.js";

describe("gateway MCP router", () => {
  it("returns uploaded tool snapshots without schema ownership", async () => {
    const router = createGatewayMcpJsonRpcRouter({ callQueue: createGatewayCallQueue() });
    const session: GatewaySessionRecord = {
      sessionId: "session",
      tenantId: "tenant",
      token: "token",
      tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
      createdAt: 1,
    };

    await expect(router.process({ jsonrpc: "2.0", id: 1, method: "tools/list" }, session)).resolves.toMatchObject({
      result: { tools: [{ name: "ping", description: "Ping" }] },
    });
    await expect(router.process({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "missing" } }, session)).resolves.toMatchObject({
      error: { code: -32602 },
    });
  });
});
