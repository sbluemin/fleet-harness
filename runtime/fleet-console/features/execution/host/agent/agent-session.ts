import { CLAUDE_COMPAT_CONTEXT_WINDOW, CLAUDE_DEFAULT_CONTEXT_WINDOW, claudeGatewayModelPolicy, compactThresholdTokens, findGatewayModel, unprojectClaudeContextInputTokens, type CompactCeiling } from "@fleet-console/ai-gateway";
import path from "node:path";
import { createClaudeExecutionLoop, createClaudeGatewaySdk, createClaudeResidentLoop, createEmbeddedMcpServer, defineTool, type ClaudeExecutionTurn, type ClaudeGatewayMcpServer, type ClaudeResidentLoop } from "@fleet-console/agent-runtime/claude";
import type { AgentEvent, AgentInput, AgentSession, AgentSessionOptions } from "@fleet-console/sdk/agent";
import { CONSOLE_USE_TOOLS, FLEET_CONSOLE_USE_MCP_SERVER, type ConsoleUseMcpHost } from "@fleet-console/sdk/mcp";
import { z } from "zod";
import { stripConsoleInternalEnv } from "../terminal/launch-env.js";
import { FLEET_BROWSER_MCP_SERVER, type BrowserPluginConnection, type BrowserPluginOptions } from "../../../browser/host/mcp.js";
import { FLEET_COMPUTER_USE_MCP_SERVER, type ComputerUsePluginConnection, type ComputerUsePluginOptions } from "../../../computer-use/host/mcp.js";

export interface AgentSessionHostDeps {
  readonly baseUrl: () => string | null;
  readonly consoleUse: ConsoleUseMcpHost;
  /** 컴퓨터 사용 서버. 없는 호스트(테스트·실험 없는 구성)나 실험이 꺼진 동안에는 `tools.computerUse` 요청이 조용히 빠진다. */
  readonly computerUseMcp?: { connectPlugin(options: ComputerUsePluginOptions): ComputerUsePluginConnection | null };
  readonly browserMcp?: { connectPlugin(options: Omit<BrowserPluginOptions, "pluginId">): BrowserPluginConnection };
  readonly createSdk?: typeof createClaudeGatewaySdk;
  /** 설치된 Claude Code 실행 파일. 없으면 SDK 동봉본이 떠서 새 모델을 모르는 옛 버전이 될 수 있다. */
  readonly resolveExecutablePath?: () => Promise<string>;
  /**
   * Gateway의 compact 정책(Settings › AI Gateway). Gateway 모델 세션의 문맥 토큰을 실제 공급자 창으로 되돌릴 때 읽는다 —
   * Gateway가 사용량을 투영할 때 읽는 그 값이어야 두 쪽이 같은 자를 쓴다. 없으면 Auto(창 − 16k)다.
   */
  readonly compactCeiling?: () => CompactCeiling | null | undefined;

}

export interface InternalAgentSession extends AgentSession {
  steer?(input: AgentInput, id: string): boolean;
}
export interface InternalSessionOptions extends AgentSessionOptions { readonly cwd?: string }
interface SessionResources {
  readonly cwd: string;
  readonly scratch: string;
  readonly resident: boolean;
  release(): Promise<void>;
}

/** 실행 자원과 도구 수명은 공유하되, 세션 자리의 소유 정책은 호출자가 고른다. */
export function createAgentSessionHost(deps: AgentSessionHostDeps, prepare: (options: InternalSessionOptions) => Promise<SessionResources>) {
  const sessions = new Set<InternalAgentSession>();
  const pending = new Set<Promise<InternalAgentSession>>();
  let disposed = false;
  let disposal: Promise<void> | null = null;

  const createSession = (options: InternalSessionOptions): Promise<InternalAgentSession> => {
    if (disposed) return Promise.reject(new Error("agent_host_disposed"));
    const work = create(options);
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };

  async function create(options: InternalSessionOptions): Promise<InternalAgentSession> {
    validateOptions(options);
    const baseUrl = deps.baseUrl();
    if (!baseUrl) throw new Error("agent_gateway_unavailable");
    if (disposed) throw new Error("agent_host_disposed");
    const resources = await prepare(options);
    const { cwd, scratch } = resources;
    const releaseCwd = () => resources.release();
    if (disposed) { await releaseCwd(); throw new Error("agent_host_disposed"); }
    const lifetime = new AbortController();
    let turnController: AbortController | null = null;
    let closed = false;
    let active = false;
    let cancelled = false;
    let closing: Promise<void> | null = null;

    let consoleConnection: ReturnType<ConsoleUseMcpHost["connect"]> | undefined;
    let computerConnection: ComputerUsePluginConnection | undefined;
    let browserConnection: BrowserPluginConnection | undefined;
    const servers: Record<string, ClaudeGatewayMcpServer> = {};
    const builtins: string[] = [...(options.tools?.builtins ?? [])];
    const allowed: string[] = [...builtins];
    // 대화 자리 전체(홈·작업 디렉터리)를 가린다. 홈 경로가 먼저 가려지도록 긴 뿌리부터 지운다.
    const hidden = [scratch, cwd];
    const redactRoots = [...new Set(hidden.flatMap((root) => [root, root.replaceAll("\\", "/"), root.replaceAll("/", "\\")]))].sort((a, b) => b.length - a.length);
    const redact = (value: unknown): unknown => {
      if (typeof value === "string") return redactRoots.reduce((text, root) => text.split(root).join("[workspace]"), value);
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
      return value;
    };
    const gateway = gatewayModelWindow(options.model);
    const emit = (event: AgentEvent) => {
      // 건넨 말의 행방은 중지 뒤에도 호출자에게 닿아야 한다 — 그래야 모델에 닿지 못한 말을 다시 보낼 수 있다.
      if (closed || (cancelled && event.kind !== "input-cancelled" && event.kind !== "input-started")) return;
      // 좌표를 바꾸는 것은 압축과 사용량을 실은 결과뿐이다 — 스트림 delta마다 Gateway 설정을 읽지 않는다.
      const reframes = event.kind === "compacted" || (event.kind === "result" && event.usage !== undefined);
      const framed = gateway === undefined || !reframes ? event : inGatewayFrame(event, gateway, deps.compactCeiling?.() ?? null);
      options.onEvent?.(redact(framed) as typeof framed);
    };
    const createSdk = async () => {
      const env = stripConsoleInternalEnv(process.env);
      delete env.FLEET_CONSOLE_SESSION_ID;
      const executablePath = await deps.resolveExecutablePath?.();
      if (resources.resident && (typeof executablePath !== "string" || !executablePath.trim())) throw new Error("agent_cli_unavailable");
      const autoCompactWindow = options.compactAt === undefined ? undefined : claudeAutoCompactWindow(options.model, options.compactAt);
      return (deps.createSdk ?? createClaudeGatewaySdk)({
        baseUrl, models: [options.model], env, modelPolicy: claudeGatewayModelPolicy,
        // 상주 대화의 홈은 scratch 안에서만 살아 있고, 세션 폐기가 scratch 전체를 회수한다.
        ...(resources.resident ? { home: { kind: "persistent" as const, configDir: path.join(scratch, "claude") } } : { tempRoot: scratch }),
        ...(executablePath === undefined ? {} : { executablePath }), ...(autoCompactWindow === undefined ? {} : { autoCompactWindow }),
      });
    };
    const buildTurn = (): ClaudeExecutionTurn => ({
      model: options.model,
      ...(options.sessionName === undefined ? {} : { sessionName: options.sessionName }),
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
    });
    const resident: ClaudeResidentLoop | null = resources.resident
      ? createClaudeResidentLoop({ createSdk, buildSession: buildTurn, stateFile: path.join(scratch, "session.json"), settlement: options.settlement, onEvent: (event) => emit(event) })
      : null;
    const loop = resident ?? createClaudeExecutionLoop({
      createSdk,
      buildTurn: () => { turnController = new AbortController(); return buildTurn(); },
      continuation: { kind: options.continuation === "conversation" ? "resume-child" : "oneshot" },
      settlement: options.settlement === "result-required" ? { kind: "result-required", watchdogMs: options.timeoutMs } : { kind: "result" },
      onEvent: (event) => emit(event),
    });
    let tail: Promise<void> = Promise.resolve();
    let pendingCancel: (() => void) | null = null;
    const session: InternalAgentSession = {
      send(input) {
        // SDK 계약을 substrate 값으로 옮긴다. 큐 대기 중 호출자의 변경이 턴을 바꾸지 않는다.
        const text = typeof input === "string" ? input : input.map((block) => block.type === "text"
          ? { type: "text" as const, text: block.text }
          : { type: "image" as const, source: { ...block.source } });
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
          // 상주 자식은 턴마다 조립되지 않는다 — 턴의 중지 신호는 여기서 턴마다 새로 세운다.
          if (resident) turnController = new AbortController();
          try { await loop.run(text); }
          finally { active = false; browserConnection?.endTurn(); computerConnection?.revoke(); turnController?.abort(); turnController = null; }
        });
        tail = work.catch(() => undefined);
        return work;
      },
      revokeComputerUse() {
        computerConnection?.revoke();
      },
      ...(resident ? {
        steer(input: AgentInput, id: string) {
          if (closed || !active || cancelled) return false;
          const text = typeof input === "string" ? input : input.map((block) => block.type === "text"
            ? { type: "text" as const, text: block.text }
            : { type: "image" as const, source: { ...block.source } });
          return resident.steer(text, id);
        },
      } : {}),
      cancel() {
        if (closed || cancelled) return;
        if (!active) {
          if (pendingCancel) { pendingCancel(); pendingCancel = null; options.onEvent?.({ kind: "cancelled" }); }
          return;
        }
        cancelled = true;
        browserConnection?.endTurn();
        computerConnection?.revoke();
        turnController?.abort();
        loop.cancel();
        options.onEvent?.({ kind: "cancelled" });
      },
      dispose() {
        if (closing) return closing;
        closed = true;
        lifetime.abort();
        browserConnection?.endTurn();
        turnController?.abort();
        closing = (async () => {
          try { await loop.dispose(); await tail; }
          finally {
            try { await Promise.all([consoleConnection?.dispose(), computerConnection?.dispose(), browserConnection?.dispose()]); }
            finally {
              sessions.delete(session);
              await releaseCwd();
            }
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
        // 요청한 호스트 도구뿐 아니라 플러그인이 기여한 도구도 허용한다 — 실려 있는데 allowlist 에 없으면 dontAsk 가 거절한다.
        allowed.push(...(consoleConnection.toolNames?.() ?? consoleOptions.tools ?? CONSOLE_USE_TOOLS).map((name) => `mcp__${FLEET_CONSOLE_USE_MCP_SERVER}__${name}`));
      }
      if (options.tools?.computerUse && deps.computerUseMcp) {
        const computerOptions = options.tools.computerUse;
        computerConnection = deps.computerUseMcp.connectPlugin({
          enabled: () => !closed && active && !cancelled && !turnController?.signal.aborted && computerOptions.enabled(),
          ...(computerOptions.language ? { language: computerOptions.language } : {}),
        }) ?? undefined;
        if (computerConnection) {
          servers[FLEET_COMPUTER_USE_MCP_SERVER] = computerConnection.embeddedServer;
          allowed.push(...computerConnection.toolNames.map((name) => `mcp__${FLEET_COMPUTER_USE_MCP_SERVER}__${name}`));
        }
      }
      if (options.tools?.browser) {
        if (!deps.browserMcp) throw new Error("agent_browser_unavailable");
        browserConnection = deps.browserMcp.connectPlugin({
          scopeId: options.tools.browser.scopeId,
          enabled: () => !closed && active && !cancelled && !turnController?.signal.aborted,
        });
        servers[FLEET_BROWSER_MCP_SERVER] = browserConnection.embeddedServer;
        allowed.push(...browserConnection.toolNames.map((name) => `mcp__${FLEET_BROWSER_MCP_SERVER}__${name}`));
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

/**
 * Claude Code가 자동 압축 창에서 빼는 몫 — 출력 예약 `min(maxOutputTokens, 20k)`과 여유 13k.
 * 압축 지점은 `창 − 33k`다(2.1.293 바이너리 판독, 2.1.296 실측: 창 100k에서 67k). 출력 상한이 20k보다
 * 작은 모델만 그 차이만큼 늦게 압축한다.
 */
const CLAUDE_AUTO_COMPACT_RESERVE = 33_000;
/** Claude Code가 받는 자동 압축 창의 범위. 밖의 값은 자식이 이 끝으로 clamp한다. */
const CLAUDE_AUTO_COMPACT_WINDOW_MIN = 100_000;
const CLAUDE_AUTO_COMPACT_WINDOW_MAX = 1_000_000;

/**
 * 플러그인이 고른 압축 지점(문맥 토큰)을 자식의 자동 압축 창으로 옮긴다. 네이티브 Claude 모델만 옮긴다.
 *
 * Gateway 카탈로그 모델(discovery 항목이 있는 비-Claude)은 Gateway가 사용량을 공급자 창에서 Claude 좌표(200k/1M)로
 * 비례 투영하고, 자기 compact 정책(공급자 창 − 16k 또는 compact-ceiling)이 압축 시점이 되도록 맞춘다. 거기에 창을 덮으면
 * 투영된 좌표 위에서 판정이 바뀌어 실제 압축 지점이 어긋난다 — 128k 모델은 64k(50%)에서 압축하고, 200k를 넘는 모델은 좌표에
 * 막혀 아무것도 바뀌지 않는다. 그래서 그 모델들은 Gateway 정책을 그대로 따른다.
 */
function claudeAutoCompactWindow(model: string, compactAt: number): number | undefined {
  let catalog: boolean;
  try { catalog = claudeGatewayModelPolicy.resolve(model).discovery !== undefined; }
  catch { return undefined; }
  if (catalog) return undefined;
  return Math.min(CLAUDE_AUTO_COMPACT_WINDOW_MAX, Math.max(CLAUDE_AUTO_COMPACT_WINDOW_MIN, compactAt + CLAUDE_AUTO_COMPACT_RESERVE));
}

/**
 * Gateway 카탈로그 모델(비-Claude)이면 그 실제 창(모르면 `null`), 아니면 `undefined`.
 *
 * 그런 세션의 자식은 Gateway가 공급자 창에서 Claude 좌표(200k, 1M 이상이면 1M)로 비례 투영한 사용량을 말하고, Gateway의 compact
 * 정책 지점에서 압축한다(`compactAt`은 적용되지 않는다). 창은 Gateway가 투영할 때 읽는 그 카탈로그 조회다.
 */
function gatewayModelWindow(model: string): number | null | undefined {
  try { if (claudeGatewayModelPolicy.resolve(model).discovery === undefined) return undefined; }
  catch { return undefined; }
  const window = findGatewayModel(model)?.contextWindow;
  return typeof window === "number" && Number.isFinite(window) && window > 0 ? window : null;
}

/**
 * Gateway 모델 세션의 사건을 호출자의 좌표로 옮긴다 — 문맥 토큰은 실제 공급자 토큰으로 되돌리고, 그 단위의 창과 실제 압축 지점을
 * `usage.context`로 싣는다. 창을 모르면 되돌릴 자가 없으므로 토큰은 그대로 두고 지점은 모른다(`null`)고 말한다.
 * 역투영은 Chat의 문맥 표시와 같은 함수·같은 정책 값이다.
 */
function inGatewayFrame(event: AgentEvent, window: number | null, ceiling: CompactCeiling | null): AgentEvent {
  if (window === null) {
    return event.kind === "result" && event.usage ? { ...event, usage: { ...event.usage, context: { window: null, compactAt: null } } } : event;
  }
  const coordinate = window >= CLAUDE_COMPAT_CONTEXT_WINDOW ? CLAUDE_COMPAT_CONTEXT_WINDOW : CLAUDE_DEFAULT_CONTEXT_WINDOW;
  const real = (tokens: number) => unprojectClaudeContextInputTokens(tokens, window, coordinate, ceiling);
  if (event.kind === "compacted") {
    return { ...event, preTokens: real(event.preTokens), ...(event.postTokens === undefined ? {} : { postTokens: real(event.postTokens) }) };
  }
  if (event.kind === "result" && event.usage) {
    const { contextTokens } = event.usage;
    return { ...event, usage: { ...event.usage, ...(contextTokens === undefined ? {} : { contextTokens: real(contextTokens) }), context: { window, compactAt: compactThresholdTokens(window, ceiling) } } };
  }
  return event;
}

function validateOptions(options: AgentSessionOptions): void {
  if (!options || typeof options.model !== "string" || !options.model.trim() || typeof options.systemPrompt !== "string") throw new Error("agent_options_invalid");
  if (!["conversation", "oneshot"].includes(options.continuation) || !["result", "result-required"].includes(options.settlement)) throw new Error("agent_policy_invalid");
  if (options.effort && !["low", "medium", "high", "xhigh", "max"].includes(options.effort)) throw new Error("agent_effort_invalid");
  for (const value of [options.timeoutMs, options.maxTurns, options.maxBudgetUsd]) if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error("agent_limit_invalid");
  if (options.timeoutMs !== undefined && options.settlement !== "result-required") throw new Error("agent_timeout_requires_result_settlement");
  if (options.maxTurns !== undefined && !Number.isInteger(options.maxTurns)) throw new Error("agent_limit_invalid");
  if (options.compactAt !== undefined && (!Number.isSafeInteger(options.compactAt) || options.compactAt <= 0)) throw new Error("agent_limit_invalid");
  if (options.sessionName !== undefined && (typeof options.sessionName !== "string" || !options.sessionName.trim() || options.sessionName.length > 160 || /[\r\n]/.test(options.sessionName))) throw new Error("agent_session_name_invalid");
  if (options.tools?.builtins?.some((tool) => !["WebSearch", "WebFetch", "SendMessage", "ListAgents", "Read"].includes(tool))) throw new Error("agent_builtin_not_allowed");
  if (options.tools?.browser && (typeof options.tools.browser.scopeId !== "string" || !options.tools.browser.scopeId.trim() || options.tools.browser.scopeId.length > 256)) throw new Error("agent_browser_scope_invalid");
  const groups = new Set<string>([FLEET_CONSOLE_USE_MCP_SERVER, FLEET_COMPUTER_USE_MCP_SERVER, FLEET_BROWSER_MCP_SERVER]);
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
