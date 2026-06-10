import crypto from "node:crypto";

import type { GatewayToolCallResult } from "./api-types.js";
import type { createGatewayCallQueue } from "./call-queue.js";
import type { GatewaySessionRecord } from "./tenant-store.js";

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
}

export interface GatewayMcpRouterDeps {
  readonly serverInfo?: { readonly name?: string; readonly version?: string };
  readonly callQueue: ReturnType<typeof createGatewayCallQueue>;
}

export function createGatewayMcpJsonRpcRouter(deps: GatewayMcpRouterDeps) {
  const serverInfo = {
    name: deps.serverInfo?.name ?? "fleet-gateway",
    version: deps.serverInfo?.version ?? "1.0.0",
  };

  async function process(req: JsonRpcRequest, session: GatewaySessionRecord): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;
    if (req.method === "initialize") {
      return result(id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo });
    }
    if (req.method === "notifications/initialized") return null;
    if (req.method === "tools/list") {
      return result(id, {
        tools: session.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
    }
    if (req.method === "tools/call") {
      const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      if (!params?.name) return error(id, -32602, "tool name missing");
      if (!session.tools.some((tool) => tool.name === params.name)) {
        return error(id, -32602, `tool not found: ${params.name}`);
      }
      const callId = crypto.randomUUID();
      const callResult: GatewayToolCallResult = await deps.callQueue.enqueue(
        session.sessionId,
        callId,
        params.name,
        params.arguments ?? {},
      );
      return result(id, callResult);
    }
    if (req.id == null) return null;
    return error(id, -32601, `Unsupported method: ${req.method}`);
  }

  return { process };
}

function result(id: string | number | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: value };
}

function error(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
