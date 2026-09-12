import { createEmbeddedMcpServer } from "@dotobokuri/core-agent/claude";
import { createExecutorSessionManager, createMcpToolRegistry, createMcpToolSnapshotStore, createServedMcpEndpoint, type McpResource, type McpHttpTransport } from "@dotobokuri/core-agent";
import { buildGatewayPolicyResources, FLEET_AI_GATEWAY_INSTRUCTIONS } from "@dotobokuri/fleet-admiral";
import { FLEET_AI_GATEWAY_MCP_SERVER, type AiGatewayMcpHost, type ConsoleUseMcpConnection } from "@fleet-console/sdk/mcp";
import { resolveGatewayLoadout, type GatewayModelsDeps } from "./gateway-models.js";

export function createAiGatewayMcpHost(deps: GatewayModelsDeps & { readonly transport?: McpHttpTransport }): AiGatewayMcpHost & { dispose(): Promise<void> } {
  const connections = new Set<ConsoleUseMcpConnection>();
  let disposed = false;
  return {
    connect() {
      if (disposed) throw new Error("Gateway MCP host is disposed");
      let closed = false;
      const registrations = new Map<string, ReadonlySet<string>>();
      const labels = new Map<string, readonly string[]>();
      const resources: McpResource[] = [...buildGatewayPolicyResources(), {
        uri: "fleet://ai-gateway/models", name: "models", mimeType: "application/json",
        description: "Live user-exposed delegable models, constraints, quota and spend priority. agentTypes are registered Agent subagent_type / Workflow agentType names; modelId is a value for a model field, never interchangeable. Agent registration freezes at session start: confirm a selector exists in the host registry before dispatch. Newly exposed selectors require a new session. Read again immediately before dispatch.",
        read: async (context?: { readonly sessionToken?: string }) => {
          const loadout = await resolveGatewayLoadout(deps);
          const registered = context?.sessionToken ? registrations.get(context.sessionToken) : undefined;
          return JSON.stringify({ observedAt: new Date().toISOString(), ...loadout, providers: Object.fromEntries(Object.entries(loadout.providers).map(([provider, entry]) => [provider, { ...entry, models: entry.models.map((model) => ({ ...model, execution: Object.fromEntries(Object.entries(model.agentTypes).map(([effort, selector]) => [effort, { selector, availableNow: registered ? registered.has(selector) : null, requiresNewSession: registered ? !registered.has(selector) : null, ...(registered ? {} : { reason: "Host registration snapshot unavailable; confirm in the host registry." }) }])) })) }])) });
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
          for (const token of labels.get(request.label.trim()) ?? []) registrations.delete(token);
          const tokens = manager.issueSessionToken(request);
          labels.set(request.label.trim(), tokens.map((entry) => entry.token));
          if (request.registeredAgentNames) for (const entry of tokens) registrations.set(entry.token, new Set(request.registeredAgentNames));
          return tokens;
        },
        releaseSessionToken: (label) => { for (const token of labels.get(label.trim()) ?? []) registrations.delete(token); labels.delete(label.trim()); manager.releaseSessionToken(label); },
        cleanup: () => { registrations.clear(); labels.clear(); manager.cleanup(); },
        dispose() {
          if (closing) return closing;
          closed = true;
          registrations.clear(); labels.clear();
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
