import { promises as fs } from "node:fs";
import path from "node:path";
import { createClaudeExecutionLoop, createClaudeGatewaySdk, createEmbeddedMcpServer, defineTool, type ClaudeGatewayMcpServer } from "@dotobokuri/core-agent/claude";
import type { AgentHost, AgentSession, AgentSessionOptions } from "@fleet-console/sdk/agent";
import { FLEET_AI_GATEWAY_MCP_SERVER, FLEET_CONSOLE_USE_MCP_SERVER, type AiGatewayMcpHost, type ConsoleUseMcpHost } from "@fleet-console/sdk/mcp";
import { z } from "zod";
import { stripConsoleInternalEnv } from "../terminal/launch-env.js";

export interface PluginAgentDeps {
  readonly baseUrl: () => string | null;
  readonly dataDir: string;
  readonly consoleUse: ConsoleUseMcpHost;
  readonly aiGatewayMcp: Pick<AiGatewayMcpHost, "connect">;
  readonly createSdk?: typeof createClaudeGatewaySdk;
}

/** 리소스 전용 서버를 읽는 데 필요한 Claude Code 내장 도구. `aiGateway`를 요청한 세션에만 열린다. */
const MCP_RESOURCE_TOOLS = ["ListMcpResourcesTool", "ReadMcpResourceTool"] as const;

/** 플러그인 등록 단위로 생성한다. 시작 중인 세션도 이 소유자가 끝날 때 함께 회수한다. */
export function createPluginAgentHost(deps: PluginAgentDeps): AgentHost & { dispose(): Promise<void> } {
  const sessions = new Set<AgentSession>();
  const pending = new Set<Promise<AgentSession>>();
  let disposed = false;
  let disposal: Promise<void> | null = null;

  const createSession = (options: AgentSessionOptions): Promise<AgentSession> => {
    if (disposed) return Promise.reject(new Error("agent_host_disposed"));
    const work = create(options);
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };

  async function create(options: AgentSessionOptions): Promise<AgentSession> {
    validateOptions(options);
    const baseUrl = deps.baseUrl();
    if (!baseUrl) throw new Error("agent_gateway_unavailable");
    if (disposed) throw new Error("agent_host_disposed");
    await fs.mkdir(deps.dataDir, { recursive: true, mode: 0o700 });
    const cwd = await fs.mkdtemp(path.join(deps.dataDir, "session-"));
    if (disposed) { await fs.rm(cwd, { recursive: true, force: true }); throw new Error("agent_host_disposed"); }
    const lifetime = new AbortController();
    let turnController: AbortController | null = null;
    let closed = false;
    let active = false;
    let cancelled = false;
    let closing: Promise<void> | null = null;

    let consoleConnection: ReturnType<ConsoleUseMcpHost["connect"]> | undefined;
    let gatewayConnection: ReturnType<AiGatewayMcpHost["connect"]> | undefined;
    const servers: Record<string, ClaudeGatewayMcpServer> = {};
    const builtins: string[] = [...(options.tools?.builtins ?? []), ...(options.tools?.aiGateway ? MCP_RESOURCE_TOOLS : [])];
    const allowed: string[] = [...builtins];
    const redact = (value: unknown): unknown => {
      if (typeof value === "string") return [...new Set([cwd, cwd.replaceAll("\\", "/"), cwd.replaceAll("/", "\\")])].reduce((text, root) => text.split(root).join("[workspace]"), value);
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
      return value;
    };
    const emit = (event: Parameters<NonNullable<AgentSessionOptions["onEvent"]>>[0]) => {
      if (closed || cancelled) return;
      options.onEvent?.(redact(event) as typeof event);
    };
    const loop = createClaudeExecutionLoop({
      createSdk: async () => {
        const env = stripConsoleInternalEnv(process.env);
        delete env.FLEET_CONSOLE_SESSION_ID;
        return (deps.createSdk ?? createClaudeGatewaySdk)({ baseUrl, models: [options.model], tempRoot: cwd, env });
      },
      buildTurn: () => {
        turnController = new AbortController();
        return {
          model: options.model,
          ...(options.effort ? { effort: options.effort } : {}),
          systemPrompt: { mode: "replace", text: options.systemPrompt },
          cwd,
          tools: [...builtins],
          allowedTools: allowed,
          mcpServers: servers,
          permissionMode: "dontAsk",
          includePartialMessages: true,
          ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
          ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }),
        };
      },
      continuation: { kind: options.continuation === "conversation" ? "resume-child" : "oneshot" },
      settlement: options.settlement === "result-required" ? { kind: "result-required", watchdogMs: options.timeoutMs } : { kind: "result" },
      onEvent: (event) => emit(event),
    });
    let tail: Promise<void> = Promise.resolve();
    let pendingCancel: (() => void) | null = null;
    const session: AgentSession = {
      send(text) {
        if (closed) return Promise.reject(new Error("Session disposed"));
        let skipped = false;
        const cancelQueued = () => { skipped = true; };
        if (!active && pendingCancel === null) { cancelled = false; pendingCancel = cancelQueued; }
        const work = tail.then(async () => {
          if (closed) throw new Error("Session disposed");
          if (pendingCancel === cancelQueued) pendingCancel = null;
          if (skipped) return;
          active = true;
          cancelled = false;
          try { await loop.run(text); }
          finally { active = false; turnController?.abort(); turnController = null; }
        });
        tail = work.catch(() => undefined);
        return work;
      },
      cancel() {
        if (closed || cancelled) return;
        if (!active) {
          if (pendingCancel) { pendingCancel(); pendingCancel = null; options.onEvent?.({ kind: "cancelled" }); }
          return;
        }
        cancelled = true;
        turnController?.abort();
        loop.cancel();
        options.onEvent?.({ kind: "cancelled" });
      },
      dispose() {
        if (closing) return closing;
        closed = true;
        lifetime.abort();
        turnController?.abort();
        closing = (async () => {
          try { await loop.dispose(); await tail; }
          finally {
            try { await Promise.all([consoleConnection?.dispose(), gatewayConnection?.dispose()]); }
            finally { sessions.delete(session); await fs.rm(cwd, { recursive: true, force: true }); }
          }
        })();
        return closing;
      },
    };
    sessions.add(session);
    try {
      for (const group of options.tools?.custom ?? []) {
        const tools = group.tools.map((tool) => {
          const schema = z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
          if (!(schema instanceof z.ZodObject)) throw new Error("agent_tool_schema_must_be_object");
          allowed.push(`mcp__${group.name}__${tool.name}`);
          return defineTool(tool.name, tool.description, schema.shape, async (args, extra) => {
            if (closed || !active || lifetime.signal.aborted || turnController?.signal.aborted) return { content: [{ type: "text", text: "Agent session is unavailable" }], isError: true };
            const parsed = schema.safeParse(args);
            if (!parsed.success) return { content: [{ type: "text", text: "Invalid tool arguments" }], isError: true };
            const signal = AbortSignal.any([lifetime.signal, ...(turnController ? [turnController.signal] : [])]);
            const result = await tool.execute(parsed.data, { cwd, signal, toolCallId: (extra as { toolUseId?: string } | undefined)?.toolUseId });
            if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) throw new Error("agent_tool_result_invalid");
            return result as { content: readonly Readonly<Record<string, unknown>>[]; isError?: boolean };
          });
        });
        servers[group.name] = createEmbeddedMcpServer({ name: group.name, tools });
      }
      if (options.tools?.consoleUse) {
        const consoleOptions = options.tools.consoleUse;
        consoleConnection = deps.consoleUse.connect({ ...consoleOptions, enabled: () => !closed && active && !cancelled && !turnController?.signal.aborted && consoleOptions.enabled?.() !== false });
        servers[FLEET_CONSOLE_USE_MCP_SERVER] = consoleConnection.embeddedServer as ClaudeGatewayMcpServer;
        allowed.push(...options.tools.consoleUse.tools.map((name) => `mcp__${FLEET_CONSOLE_USE_MCP_SERVER}__${name}`));
      }
      if (options.tools?.aiGateway) {
        gatewayConnection = deps.aiGatewayMcp.connect();
        servers[FLEET_AI_GATEWAY_MCP_SERVER] = gatewayConnection.embeddedServer as ClaudeGatewayMcpServer;
      }
      await loop.start();
      if (disposed || closed) throw new Error("agent_host_disposed");
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

  return {
    createSession,
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      disposal = (async () => {
        const early = [...sessions].map((session) => session.dispose());
        const earlyResults = await Promise.allSettled(early);
        await Promise.allSettled([...pending]);
        const results = [...earlyResults, ...await Promise.allSettled([...sessions].map((session) => session.dispose()))];
        const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map((r) => r.reason), "Agent cleanup failed");
      })();
      return disposal;
    },
  };
}

function validateOptions(options: AgentSessionOptions): void {
  if (!options || typeof options.model !== "string" || !options.model.trim() || typeof options.systemPrompt !== "string") throw new Error("agent_options_invalid");
  if (!["conversation", "oneshot"].includes(options.continuation) || !["result", "result-required"].includes(options.settlement)) throw new Error("agent_policy_invalid");
  if (options.effort && !["low", "medium", "high", "xhigh", "max"].includes(options.effort)) throw new Error("agent_effort_invalid");
  for (const value of [options.timeoutMs, options.maxTurns, options.maxBudgetUsd]) if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error("agent_limit_invalid");
  if (options.timeoutMs !== undefined && options.settlement !== "result-required") throw new Error("agent_timeout_requires_result_settlement");
  if (options.maxTurns !== undefined && !Number.isInteger(options.maxTurns)) throw new Error("agent_limit_invalid");
  if (options.tools?.builtins?.some((tool) => tool !== "WebSearch" && tool !== "WebFetch")) throw new Error("agent_builtin_not_allowed");
  const groups = new Set<string>([FLEET_CONSOLE_USE_MCP_SERVER, FLEET_AI_GATEWAY_MCP_SERVER]);
  for (const group of options.tools?.custom ?? []) {
    if (!/^[a-zA-Z0-9_-]+$/.test(group.name) || groups.has(group.name)) throw new Error("agent_tool_group_invalid");
    groups.add(group.name);
    const names = new Set<string>();
    for (const tool of group.tools) {
      if (!/^[a-zA-Z0-9_-]+$/.test(tool.name) || names.has(tool.name)) throw new Error("agent_tool_name_invalid");
      names.add(tool.name);
    }
  }
}
