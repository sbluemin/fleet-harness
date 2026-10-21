import { randomUUID } from "node:crypto";
import { createExecutorSessionManager, createServedMcpEndpoint, type McpHttpTransport } from "@fleet-console/agent-runtime/mcp";
import { createMcpToolRegistry, createMcpToolSnapshotStore } from "@fleet-console/agent-runtime/tools";
import { inputIssues, type AdmiralMcpSession, type ConsoleCaller, type PluginAdmiralMcpRegistration, type PluginMcpServerTools, type PluginMcpTool } from "@fleet-console/sdk/mcp";
import { z } from "zod";

export interface PluginAdmiralMcpHostOptions {
  /**
   * 세션 라벨(연결 접두사를 벗긴 것)을 호출자 Operation 으로 푼다. 모르는 라벨은 null — 호출자 없이 부른다(fail-closed).
   * 모델 인자나 토큰 밖의 값으로 호출자를 정하지 않는다.
   */
  readonly resolveCaller?: (label: string) => ConsoleCaller | null;
  readonly onFailure?: (kind: string, error: unknown) => void;
}

/** 연결마다 붙인 접두사(`<uuid>:`)를 벗긴다 — uuid 에는 콜론이 없으므로 첫 콜론까지가 접두사다. */
const unscopedLabel = (label: string | undefined): string | null => {
  if (!label) return null;
  const at = label.indexOf(":");
  return at > 0 ? label.slice(at + 1) : null;
};

/** 호스트 인스턴스가 소유한다. 플러그인 번들의 모듈 사본과 상태를 공유하지 않는다. */
export function createPluginAdmiralMcpHost(transport?: McpHttpTransport, options: PluginAdmiralMcpHostOptions = {}) {
  type ToolRunner = { readonly tool: PluginMcpTool; readonly run: (args: unknown, context: Parameters<PluginMcpTool["execute"]>[1]) => Promise<unknown> };
  type Registration = {
    manager: ReturnType<typeof createExecutorSessionManager>;
    stop(): Promise<void>;
    /** Theater 루트에 묶어 내줄 수 있는 서버면 그 도구 — 실행은 서빙 경로와 같은 검증을 지난다. 아니면 null. */
    theaterTools: readonly ToolRunner[] | null;
  };
  const registrations = new Map<string, Registration>();
  const retiring = new Set<Promise<void>>();
  let disposed = false;
  return {
    register(pluginId: string, tools: readonly PluginMcpTool[], registration: PluginAdmiralMcpRegistration = {}): () => void {
      if (disposed) throw new Error("Plugin MCP host is disposed");
      const name = `fleet-${pluginId}`;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(pluginId) || name === "fleet-console-use" || name === "fleet-core" || name === "fleet-ai-gateway" || name === "fleet-computer-use") throw new Error("Invalid plugin MCP name");
      if (registrations.has(name)) throw new Error(`Plugin MCP already registered: ${name}`);
      if (!tools.length || new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error("Plugin MCP tools must be nonempty and unique");
      const registry = createMcpToolRegistry();
      const snapshotStore = createMcpToolSnapshotStore();
      const controller = new AbortController();
      const runners: ToolRunner[] = [];
      for (const tool of tools) {
        if (!/^[a-zA-Z0-9_-]+$/.test(tool.name)) throw new Error("Invalid plugin MCP tool name");
        const schema = z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
        // 서빙 경로와 Theater 묶음 경로가 같은 선검사(내려간 서버·인자 검증)를 지난다. 호출자·cwd 는 부르는 쪽이 정한다.
        const run = async (args: unknown, context: Parameters<PluginMcpTool["execute"]>[1]) => {
          if (controller.signal.aborted) return { content: [{ type: "text", text: "Plugin MCP is unavailable" }], isError: true };
          const parsed = schema.safeParse(args);
          if (!parsed.success) return { content: [{ type: "text", text: JSON.stringify({ error: "Invalid MCP arguments", issues: inputIssues(parsed.error.issues) }) }], isError: true };
          return tool.execute(parsed.data, { ...context, signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal });
        };
        runners.push({ tool, run });
        registry.registerAgentTool({
          id: tool.name, tag: tool.name, title: tool.name, description: tool.description,
          promptSnippet: "", whenToUse: [], whenNotToUse: [], usageGuidelines: [], parameters: tool.inputSchema,
          execute: async (args, context) => {
            const label = unscopedLabel(context.sessionLabel);
            const caller = label && options.resolveCaller ? options.resolveCaller(label) : null;
            return run(args, { ...context, ...(caller ? { caller } : {}) });
          },
        });
      }
      const server = createServedMcpEndpoint({ transport, serverInfo: { name }, toolSnapshotStore: snapshotStore });
      const manager = createExecutorSessionManager({ runtimes: [{ name, runtime: { registry, snapshotStore, server, onFailure: options.onFailure } }] });
      const entry: Registration = { manager, stop: () => { controller.abort(); manager.cleanup(); return server.stop(); }, theaterTools: registration.theaterScoped ? runners : null };
      registrations.set(name, entry);
      return () => {
        if (registrations.get(name) !== entry) return;
        registrations.delete(name);
        controller.abort();
        manager.cleanup();
        const closing = entry.stop();
        retiring.add(closing);
        void closing.then(() => retiring.delete(closing), () => {});
      };
    },
    /**
     * `theaterScoped` 서버들의 도구를 작업 디렉터리 하나(호스트가 정한 Theater 루트)에 묶는다. 부르는 쪽이 넘긴 cwd 는 버리고
     * 이 루트로 부른다 — 모델이나 세션 자리가 다른 Theater 를 고를 수 없다. 호출자는 싣지 않는다(fail-closed).
     */
    bindTheater(root: string): PluginMcpServerTools[] {
      if (disposed) return [];
      return [...registrations].flatMap(([name, entry]) => entry.theaterTools ? [{
        name,
        tools: entry.theaterTools.map(({ tool, run }): PluginMcpTool => ({
          name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
          execute: (args, context) => run(args, { cwd: root, ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}), ...(context.signal ? { signal: context.signal } : {}) }),
        })),
      }] : []);
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
            labels.delete(request.label.trim());
            throw error;
          }
        },
        releaseSessionToken(label) {
          for (const { manager } of labels.get(label.trim()) ?? []) manager.releaseSessionToken(scopedLabel(label));
          labels.delete(label.trim());
        },
        cleanup() {
          for (const [label, active] of labels) {
            for (const { manager } of active) manager.releaseSessionToken(scopedLabel(label));
          }
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
