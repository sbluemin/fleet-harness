import { randomUUID } from "node:crypto";
import { createExecutorSessionManager, createMcpToolRegistry, createMcpToolSnapshotStore, createServedMcpEndpoint, type McpHttpTransport } from "@dotobokuri/core-agent";
import type { AdmiralMcpSession, PluginMcpTool } from "@fleet-console/sdk/mcp";
import { z } from "zod";

/** 호스트 인스턴스가 소유한다. 플러그인 번들의 모듈 사본과 상태를 공유하지 않는다. */
export function createPluginAdmiralMcpHost(transport?: McpHttpTransport) {
  type Registration = { manager: ReturnType<typeof createExecutorSessionManager>; stop(): Promise<void> };
  const registrations = new Map<string, Registration>();
  const retiring = new Set<Promise<void>>();
  let disposed = false;
  return {
    register(pluginId: string, tools: readonly PluginMcpTool[]): () => void {
      if (disposed) throw new Error("Plugin MCP host is disposed");
      const name = `fleet-${pluginId}`;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(pluginId) || name === "fleet-console-use" || name === "fleet-core") throw new Error("Invalid plugin MCP name");
      if (registrations.has(name)) throw new Error(`Plugin MCP already registered: ${name}`);
      if (!tools.length || new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error("Plugin MCP tools must be nonempty and unique");
      const registry = createMcpToolRegistry();
      const snapshotStore = createMcpToolSnapshotStore();
      const controller = new AbortController();
      for (const tool of tools) {
        if (!/^[a-zA-Z0-9_-]+$/.test(tool.name)) throw new Error("Invalid plugin MCP tool name");
        const schema = z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
        registry.registerAgentTool({
          id: tool.name, tag: tool.name, title: tool.name, description: tool.description,
          promptSnippet: "", whenToUse: [], whenNotToUse: [], usageGuidelines: [], parameters: tool.inputSchema,
          execute: async (args, context) => {
            if (controller.signal.aborted) return { content: [{ type: "text", text: "Plugin MCP is unavailable" }], isError: true };
            const parsed = schema.safeParse(args);
            if (!parsed.success) return { content: [{ type: "text", text: "Invalid MCP arguments" }], isError: true };
            return tool.execute(parsed.data, { ...context, signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal });
          },
        });
      }
      const server = createServedMcpEndpoint({ transport, serverInfo: { name }, toolSnapshotStore: snapshotStore });
      const manager = createExecutorSessionManager({ runtimes: [{ name, runtime: { registry, snapshotStore, server } }] });
      const registration: Registration = { manager, stop: () => { controller.abort(); manager.cleanup(); return server.stop(); } };
      registrations.set(name, registration);
      return () => {
        if (registrations.get(name) !== registration) return;
        registrations.delete(name);
        controller.abort();
        manager.cleanup();
        const closing = registration.stop();
        retiring.add(closing);
        void closing.then(() => retiring.delete(closing), () => {});
      };
    },
    connect(): AdmiralMcpSession {
      const prefix = randomUUID();
      const scopedLabel = (label: string) => `${prefix}:${label.trim()}`;
      const labels = new Map<string, readonly Registration[]>();
      return {
        async getEndpoint() {
          if (disposed) throw new Error("Plugin MCP host is disposed");
          const endpoints = await Promise.all([...registrations.values()].map(({ manager }) => manager.getEndpoint()));
          return { servers: endpoints.flatMap((endpoint) => endpoint.servers) };
        },
        issueSessionToken(request) {
          if (disposed) throw new Error("Plugin MCP host is disposed");
          if (labels.has(request.label.trim())) throw new Error("Plugin MCP session label already in use");
          const active = [...registrations.values()];
          try {
            const tokens = active.flatMap(({ manager }) => manager.issueSessionToken({ ...request, label: scopedLabel(request.label) }));
            labels.set(request.label.trim(), active);
            return tokens;
          } catch (error) {
            for (const { manager } of active) manager.releaseSessionToken(scopedLabel(request.label));
            throw error;
          }
        },
        releaseSessionToken(label) {
          for (const { manager } of labels.get(label.trim()) ?? []) manager.releaseSessionToken(scopedLabel(label));
          labels.delete(label.trim());
        },
        cleanup() {
          for (const [label, active] of labels) for (const { manager } of active) manager.releaseSessionToken(scopedLabel(label));
          labels.clear();
        },
      };
    },
    async dispose() {
      disposed = true;
      const active = [...registrations.values()];
      registrations.clear();
      for (const { manager } of active) manager.cleanup();
      const results = await Promise.allSettled([...retiring, ...active.map((entry) => entry.stop())]);
      retiring.clear();
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (errors.length) throw new AggregateError(errors.map((result) => result.reason), "Plugin MCP cleanup failed");
    },
  };
}
