import { createEmbeddedMcpServer } from "@fleet-console/agent-runtime/claude";
import { createExecutorSessionManager, createServedMcpEndpoint, type McpResource, type McpHttpTransport } from "@fleet-console/agent-runtime/mcp";
import { createMcpToolRegistry, createMcpToolSnapshotStore } from "@fleet-console/agent-runtime/tools";
import { buildGatewayPolicyResources, FLEET_AI_GATEWAY_INSTRUCTIONS } from "@fleet-console/ai-gateway";
import { FLEET_AI_GATEWAY_MCP_SERVER, type AiGatewayMcpHost, type ConsoleUseMcpConnection } from "@fleet-console/sdk/mcp";
import { resolveGatewayLoadout, type GatewayModelsDeps } from "./gateway-models.js";

export function createAiGatewayMcpHost(deps: GatewayModelsDeps & { readonly transport?: McpHttpTransport }): AiGatewayMcpHost & { dispose(): Promise<void> } {
  const connections = new Set<ConsoleUseMcpConnection>();
  let disposed = false;
  return {
    connect() {
      if (disposed) throw new Error("Gateway MCP host is disposed");
      let closed = false;
      const labels = new Map<string, readonly string[]>();
      const resources: McpResource[] = [...buildGatewayPolicyResources(), {
        uri: "fleet://ai-gateway/models", name: "models", mimeType: "application/json",
        description: "Live user-exposed delegable models, constraints, quota and spend priority. Read it to understand what this session can spend and how the providers stand, not to pick a name: Fleet assigns a delegated run's model when the run starts, and no dispatch field takes a value from here. modelId matches a running session's own model back to a row.",
        read: async () => {
          const loadout = await resolveGatewayLoadout(deps);
          return JSON.stringify({ observedAt: new Date().toISOString(), ...loadout });
        },
      }].map((resource) => ({ ...resource, read: async (context?: { readonly sessionToken?: string }) => {
        if (closed) throw new Error("Gateway MCP connection is disposed");
        const value = await resource.read(context);
        if (closed) throw new Error("Gateway MCP connection is disposed");
        return value;
      } }));
      const snapshotStore = createMcpToolSnapshotStore();
      const registry = createMcpToolRegistry();
      const server = createServedMcpEndpoint({ transport: deps.transport, serverInfo: { name: FLEET_AI_GATEWAY_MCP_SERVER }, instructions: FLEET_AI_GATEWAY_INSTRUCTIONS, resources, toolSnapshotStore: snapshotStore });
      const manager = createExecutorSessionManager({ runtimes: [{ name: FLEET_AI_GATEWAY_MCP_SERVER, runtime: { registry, snapshotStore, server, resources } }] });
      let closing: Promise<void> | undefined;
      const connection: ConsoleUseMcpConnection = {
        embeddedServer: createEmbeddedMcpServer({ name: FLEET_AI_GATEWAY_MCP_SERVER, instructions: FLEET_AI_GATEWAY_INSTRUCTIONS, resources }),
        getEndpoint: () => { if (closed) throw new Error("Gateway MCP connection is disposed"); return manager.getEndpoint(); },
        issueSessionToken: (request) => {
          if (closed) throw new Error("Gateway MCP connection is disposed");
          const tokens = manager.issueSessionToken(request);
          labels.set(request.label.trim(), tokens.map((entry) => entry.token));
          return tokens;
        },
        releaseSessionToken: (label) => { labels.delete(label.trim()); manager.releaseSessionToken(label); },
        cleanup: () => { labels.clear(); manager.cleanup(); },
        dispose() {
          if (closing) return closing;
          closed = true;
          labels.clear();
          manager.cleanup();
          connections.delete(connection);
          closing = server.stop();
          return closing;
        },
      };
      connections.add(connection);
      return connection;
    },
    async dispose() {
      disposed = true;
      await Promise.all([...connections].map((connection) => connection.dispose()));
    },
  };
}
