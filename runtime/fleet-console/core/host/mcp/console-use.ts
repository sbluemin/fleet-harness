import { createEmbeddedMcpServer, defineTool } from "@dotobokuri/core-agent/claude";
import { z } from "zod";
import {
  createExecutorSessionManager,
  createMcpToolRegistry,
  createMcpToolSnapshotStore,
  createServedMcpEndpoint,
  type AgentToolSpec,
  type McpHttpTransport,
} from "@dotobokuri/core-agent";
import { FLEET_CONSOLE_USE_MCP_SERVER, type ConsoleUseMcpConnection, type ConsoleUseMcpHost, type ConsoleUseSnapshot } from "@fleet-console/sdk/mcp";
import type { OperationNode } from "@fleet-console/sdk/operations";
import { buildGatewayModelsToolSpec, type GatewayModelsToolDeps } from "./gateway-models-tool.js";

export interface ConsoleUseDeps {
  readonly transport?: McpHttpTransport;
  readonly theaters?: () => readonly { readonly id: string; readonly name: string }[];
  readonly operations?: () => readonly OperationNode[];
  readonly gateway: GatewayModelsToolDeps;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], isError: false };
}

function consoleSpecs(deps: ConsoleUseDeps, snapshot: () => ConsoleUseSnapshot | null): AgentToolSpec[] {
  const specs: AgentToolSpec[] = [buildGatewayModelsToolSpec(deps.gateway)];
  if (!deps.theaters || !deps.operations) return specs;
  const theaters = deps.theaters;
  const operations = deps.operations;
  specs.push({
    id: "console_theaters", tag: "console_theaters", title: "Console Theaters", promptSnippet: "", whenToUse: [], whenNotToUse: [], usageGuidelines: [],
    description: "List registered Console projects (Theaters): id and name. Does not expose filesystem paths.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => text(theaters()),
  }, {
    id: "console_operations", tag: "console_operations", title: "Console Operations", promptSnippet: "", whenToUse: [], whenNotToUse: [], usageGuidelines: [],
    description: "List Console Operations with title, Theater, kind, activity, and creation time. Activity is from the supplied snapshot, not a live stream; unknown means no observation is available.",
    parameters: {
      type: "object",
      properties: { activity: { type: "string", enum: ["idle", "running", "awaiting", "background", "ended"] } },
      additionalProperties: false,
    },
    execute: async (input) => {
      const args = input as { readonly activity?: string };
      const current = snapshot();
      const activities = new Map(current?.operations.map((op) => [op.id, op.activity]) ?? []);
      const names = new Map(theaters().map((theater) => [theater.id, theater.name]));
      const rows = operations().map((op) => ({
        id: op.id,
        title: op.title,
        theaterId: op.theaterId,
        theater: names.get(op.theaterId) ?? op.theaterId,
        kind: op.type,
        activity: activities.get(op.id) ?? "unknown",
        createdAt: new Date(op.ts.createdAt).toISOString(),
      }));
      return text({ snapshotAt: current?.takenAt ?? null, operations: args.activity ? rows.filter((op) => op.activity === args.activity) : rows });
    },
  });
  return specs;
}

/** 각 연결은 자체 MCP endpoint·토큰·도구 바인딩을 소유한다. 플러그인 도구는 등록하지 않는다. */
export function createConsoleUseMcpHost(deps: ConsoleUseDeps): ConsoleUseMcpHost & { dispose(): Promise<void> } {
  const connections = new Set<ConsoleUseMcpConnection>();
  let disposed = false;
  return {
    connect(options) {
      if (disposed) throw new Error("Console MCP host is disposed");
      const requested = new Set(options.tools);
      const specs = consoleSpecs(deps, options.snapshot ?? (() => null)).filter((spec) => requested.has(spec.id as typeof options.tools[number]));
      if (!specs.length || specs.length !== requested.size) throw new Error("Unavailable Console MCP tools");
      const registry = createMcpToolRegistry();
      const snapshotStore = createMcpToolSnapshotStore();
      let closed = false;
      const controller = new AbortController();
      const schemas = new Map(specs.map((spec) => [spec.id, z.fromJSONSchema(spec.parameters as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodObject]));
      for (const spec of specs) registry.registerAgentTool({
        ...spec,
        execute: (args, ctx) => {
          if (closed || options.enabled?.() === false) return Promise.resolve({ ...text({ error: "console_read_disabled", hint: "Console access is disabled. Do not answer from earlier Console results." }), isError: true });
          const parsed = schemas.get(spec.id)!.safeParse(args);
          if (!parsed.success) return Promise.resolve({ ...text({ error: "invalid_arguments" }), isError: true });
          return spec.execute(parsed.data, { ...ctx, signal: ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal });
        },
      });
      const server = createServedMcpEndpoint({ transport: deps.transport, serverInfo: { name: FLEET_CONSOLE_USE_MCP_SERVER }, toolSnapshotStore: snapshotStore });
      const manager = createExecutorSessionManager({ runtimes: [{ name: FLEET_CONSOLE_USE_MCP_SERVER, runtime: { registry, snapshotStore, server } }] });
      let closing: Promise<void> | undefined;
      const embeddedServer = createEmbeddedMcpServer({
        name: FLEET_CONSOLE_USE_MCP_SERVER,
        tools: registry.getAllAgentTools().map((spec) => defineTool(
          spec.id,
          spec.description,
          schemas.get(spec.id)!.shape,
          async (args) => await spec.execute(args, { cwd: "", signal: controller.signal }) as { content: readonly Readonly<Record<string, unknown>>[]; isError?: boolean },
        )),
      });
      const connection: ConsoleUseMcpConnection = {
        embeddedServer,
        getEndpoint: async () => {
          if (closed) throw new Error("Console MCP connection is disposed");
          return manager.getEndpoint();
        },
        issueSessionToken: (request) => {
          if (closed) throw new Error("Console MCP connection is disposed");
          return manager.issueSessionToken(request);
        },
        releaseSessionToken: (label) => manager.releaseSessionToken(label),
        cleanup: () => manager.cleanup(),
        dispose: () => {
          if (closing) return closing;
          closed = true;
          controller.abort();
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
      const results = await Promise.allSettled([...connections].map((connection) => connection.dispose()));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Console MCP cleanup failed");
    },
  };
}
