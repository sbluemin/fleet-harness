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

  it("returns per-request responses for initialize and tools/list batches", async () => {
    const router = createGatewayMcpJsonRpcRouter({ callQueue: createGatewayCallQueue() });
    const session = createSession();

    await expect(router.processPayload([
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ], session)).resolves.toMatchObject([
      { id: 1, result: { protocolVersion: "2025-03-26" } },
      { id: 2, result: { tools: [{ name: "ping", description: "Ping" }] } },
    ]);
  });

  it("returns no payload for notification-only and empty batches", async () => {
    const router = createGatewayMcpJsonRpcRouter({ callQueue: createGatewayCallQueue() });
    const session = createSession();

    await expect(router.processPayload([
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ], session)).resolves.toBeNull();
    await expect(router.processPayload([], session)).resolves.toBeNull();
  });
});

function createSession(): GatewaySessionRecord {
  return {
    sessionId: "session",
    tenantId: "tenant",
    token: "token",
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
    createdAt: 1,
  };
}
