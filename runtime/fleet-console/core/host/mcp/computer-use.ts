import { randomUUID } from "node:crypto";
import { createExecutorSessionManager, createMcpToolRegistry, createMcpToolSnapshotStore, createServedMcpEndpoint, type McpHttpTransport } from "@dotobokuri/core-agent";
import type { AdmiralMcpSession } from "@fleet-console/sdk/mcp";
import { z } from "zod";
import type { ComputerUseService } from "../agent/computer-use.js";

export const FLEET_COMPUTER_USE_MCP_SERVER = "fleet-computer-use";
export interface ComputerUseMcpConnection extends AdmiralMcpSession {
  cancelSession(label: string): void;
  dispose(): Promise<void>;
}

/** Console 조회 MCP와 도구·토큰·소유권을 공유하지 않는 기기 조작 서버. */
export function createComputerUseMcpHost(deps: { readonly transport?: McpHttpTransport; readonly service: ComputerUseService }) {
  const connections = new Set<ComputerUseMcpConnection>();
  let disposed = false;
  return {
    connect(): ComputerUseMcpConnection {
      if (disposed) throw new Error("Computer Use MCP host is disposed");
      const prefix = randomUUID();
      const owner = (label: string) => `${prefix}:${label}`;
      const owners = new Set<string>();
      const controller = new AbortController();
      const registry = createMcpToolRegistry();
      const snapshotStore = createMcpToolSnapshotStore();
      for (const spec of deps.service.specs()) {
        const schema = z.fromJSONSchema(spec.parameters as Parameters<typeof z.fromJSONSchema>[0]);
        registry.registerAgentTool({ ...spec, execute: (args, context) => {
          const parsed = schema.safeParse(args);
          if (!parsed.success || !context.sessionLabel || controller.signal.aborted) return Promise.resolve({ content: [{ type: "text", text: "Computer Use session or arguments unavailable" }], isError: true });
          const sessionLabel = owner(context.sessionLabel);
          owners.add(sessionLabel);
          return spec.execute(parsed.data, { ...context, sessionLabel, signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal });
        } });
      }
      const server = createServedMcpEndpoint({ transport: deps.transport, serverInfo: { name: FLEET_COMPUTER_USE_MCP_SERVER }, toolSnapshotStore: snapshotStore });
      const manager = createExecutorSessionManager({ runtimes: [{ name: FLEET_COMPUTER_USE_MCP_SERVER, runtime: { registry, snapshotStore, server } }] });
      let closed = false;
      let closing: Promise<void> | null = null;
      const release = (label: string) => { const id = owner(label); deps.service.release(id); owners.delete(id); };
      const cleanup = () => { for (const id of owners) deps.service.release(id); owners.clear(); manager.cleanup(); };
      const connection: ComputerUseMcpConnection = {
        getEndpoint: async () => { if (closed) throw new Error("Computer Use MCP disposed"); return manager.getEndpoint(); },
        issueSessionToken: (request) => {
          if (closed) throw new Error("Computer Use MCP disposed");
          const enabled = deps.service.status().enabled;
          return manager.issueSessionToken({ ...request, includeTool: (id) => (id === "computer_status" || id === "computer_end" || enabled) && (request.includeTool?.(id) ?? true) });
        },
        cancelSession: release,
        releaseSessionToken: (label) => { release(label); manager.releaseSessionToken(label); },
        cleanup,
        dispose: () => {
          if (closing) return closing;
          closed = true;
          controller.abort();
          cleanup();
          connections.delete(connection);
          closing = server.stop();
          return closing;
        },
      };
      connections.add(connection);
      return connection;
    },
    async dispose(): Promise<void> {
      disposed = true;
      await Promise.all([...connections].map((connection) => connection.dispose()));
      await deps.service.stop();
    },
  };
}
