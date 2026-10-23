import { randomUUID } from "node:crypto";
import { createEmbeddedMcpServer, defineTool, type ClaudeGatewayMcpServer } from "@fleet-console/agent-runtime/claude";
import { createExecutorSessionManager, createServedMcpEndpoint, type McpHttpTransport } from "@fleet-console/agent-runtime/mcp";
import { createMcpToolRegistry, createMcpToolSnapshotStore } from "@fleet-console/agent-runtime/tools";
import { z } from "zod";
import type { AdmiralMcpSession } from "../../execution/shared/admiral-mcp.js";
import type { ObjectiveRecord } from "../../objectives/shared/records/types.js";
import { GLOBAL_BROWSER_OWNER_ID, invalidTargetMessage, type BrowserService } from "./service.js";
import { createBrowserToolSpecs, type BrowserToolCtx, type BrowserToolDeps } from "./tools.js";
import { objectiveIdFromSessionLabel } from "../../computer-use/host/mcp.js";

export const FLEET_BROWSER_MCP_SERVER = "fleet-browser";
export const SESSION_BROWSER_OWNER_PREFIX = "plugin-browser:";

export interface BrowserMcpDeps extends BrowserToolDeps {
  readonly transport?: McpHttpTransport;
  readonly service: BrowserService;
  readonly onFailure?: (kind: string, error: unknown) => void;
  readonly objectiveRecords: () => readonly ObjectiveRecord[];
  readonly resolveObjective?: (id: string) => ObjectiveRecord | null;
  /**
   * 호출한 세션 → 사용 컨텍스트. 자식 세션은 루트(contextId)의 브라우저를 함께 쓰고, 턴 종료·중단은 그 세션(participantId)의
   * 호출만 끊는다. 없으면 두 값이 호출한 Objective 자신이다. 실행 도메인이 계보로 풀고 부트스트랩이 주입한다.
   */
  readonly useContext?: (objectiveId: string) => { readonly contextId: string; readonly participantId: string } | null;
  readonly language?: () => "en" | "ko" | null;
}

/** 호출한 세션의 사용 범위 — 주인(contextId)과 참가자(participantId). */
function scopeOf(deps: BrowserMcpDeps, objectiveId: string): { readonly contextId: string; readonly participantId: string } {
  return deps.useContext?.(objectiveId) ?? { contextId: objectiveId, participantId: objectiveId };
}

type BrowserRefusal = "caller_unresolved" | "desktop_required" | "shared";

const REFUSAL_INSTRUCTION: Record<BrowserRefusal, string> = {
  caller_unresolved: "This session has no active Console browser binding, so the Fleet Browser can never answer it. Do not retry and do not ask the user to change a setting. Continue without the browser.",
  desktop_required: "The Fleet Browser runs only inside the Fleet Desktop app, and no Desktop window is showing this Console right now. Do not retry until the user says they opened this Console in Fleet Desktop.",
  shared: "The Fleet Browser is paused because this Console is also open in a regular browser tab or on a phone. Do not retry until the user says only Fleet Desktop windows remain.",
};

const REFUSAL_MESSAGE: Record<BrowserRefusal, Record<"en" | "ko", string>> = {
  caller_unresolved: {
    en: "This session has no active Console browser binding, so the Fleet Browser is unavailable to it.",
    ko: "이 세션에는 활성 Console 브라우저 연결이 없어 플릿 브라우저를 쓸 수 없습니다.",
  },
  desktop_required: { en: "The Fleet Browser needs a Fleet Desktop window showing this Console.", ko: "플릿 브라우저는 Fleet Desktop 창에서만 열립니다. 지금 이 Console 을 보는 Desktop 창이 없습니다." },
  shared: { en: "The Fleet Browser is paused while this Console is also open in a browser or on a phone.", ko: "이 Console 이 브라우저·모바일에서도 열려 있어 플릿 브라우저가 멈춰 있습니다." },
};

function refuse(reason: BrowserRefusal, objectiveId: string | null, language: "en" | "ko") {
  const actionable = reason !== "caller_unresolved";
  return { content: [{ type: "text" as const, text: JSON.stringify({
    error: "browser_not_authorized", reason, retryable: actionable, retryAfter: actionable ? "user_action" : "never",
    remedy: { actor: "none", surface: "none", path: [] },
    agentInstruction: REFUSAL_INSTRUCTION[reason], message: REFUSAL_MESSAGE[reason][language],
  }) }], isError: true };
}

function deny(deps: BrowserMcpDeps, sessionLabel: string | undefined) {
  const id = objectiveIdFromSessionLabel(sessionLabel);
  const fallback = deps.language?.() ?? "en";
  // 예약 id "global" 은 Objective으로 풀지 않는다 — 옛 전역 요청이 이 Session의 탭에 닿지 않게.
  const objectiveRecord = id === GLOBAL_BROWSER_OWNER_ID || id.startsWith(SESSION_BROWSER_OWNER_PREFIX) ? null : deps.resolveObjective?.(id) ?? deps.objectiveRecords().find((op) => op.id === id);
  if (!objectiveRecord) return { denied: refuse("caller_unresolved", null, fallback), objectiveId: null, participantId: null };
  // 자식 세션은 루트의 브라우저를 쓴다 — 같은 탭 집합·같은 세션.
  const scope = scopeOf(deps, objectiveRecord.id);
  // 브라우저는 Desktop 앱의 것이다 — 창을 든 Desktop 이 있고 브라우저·모바일 화면이 없을 때만 열린다.
  const availability = deps.service.availability();
  if (!availability.available) return { denied: refuse(availability.reason === "shared" ? "shared" : "desktop_required", scope.contextId, fallback), objectiveId: scope.contextId, participantId: scope.participantId };
  return { denied: null, objectiveId: scope.contextId, participantId: scope.participantId };
}

/**
 * 대상의 모든 갈래가 어긋나면 zod 는 그 자리에 「Invalid input」만 남긴다. 모델이 무엇을 섞었는지 알도록
 * 받은 필드를 담은 문구로 바꾼다. 거부 여부는 그대로다.
 */
function describeArgumentIssue(args: unknown, issue: { code: string; path: PropertyKey[]; message: string }): string {
  const path = issue.path.map(String);
  const last = path.at(-1);
  if (issue.code === "invalid_union" && (last === "target" || last === "within")) {
    let value: unknown = args;
    for (const key of issue.path) value = typeof value === "object" && value !== null ? (value as Record<PropertyKey, unknown>)[key] : undefined;
    return `${path.join(".")}: ${invalidTargetMessage(value, last === "within" && path.at(-2) === "target")}`;
  }
  return `${path.join(".")}: ${issue.message}`;
}

export interface BrowserPluginOptions {
  readonly pluginId: string;
  readonly scopeId: string;
  readonly enabled: () => boolean;
}

export interface BrowserPluginConnection {
  readonly embeddedServer: ClaudeGatewayMcpServer;
  readonly toolNames: readonly string[];
  endTurn(): void;
  dispose(): Promise<void>;
}

export interface BrowserMcpConnection extends AdmiralMcpSession {
  cancelSession(label: string): void;
  dispose(): Promise<void>;
}

/**
 * Session Browser MCP 서버. 도구는 세션이 열릴 때부터 실려 있고, 로컬 전용 여부만 호출마다 다시 판정한다.
 */
export function createBrowserMcpHost(deps: BrowserMcpDeps) {
  const connections = new Set<BrowserMcpConnection>();
  // 화면 좌표는 Console 실행 동안 유지하되, 에이전트 연결과 탭은 세션이 끝날 때 회수한다.
  const pluginOwners = new Map<string, string>();
  const pluginConnections = new Map<string, BrowserPluginConnection>();
  const ownerKey = (pluginId: string, scopeId: string) => JSON.stringify([pluginId, scopeId]);
  const specs = createBrowserToolSpecs(deps);
  let disposed = false;
  // 터미널 Objective 의 CLI 에 붙여넣기를 누르는 손 — PTY 는 실행 런타임이 소유하므로 그쪽이 기동하며 묶는다.
  let terminalPaste: ((objectiveId: string) => boolean) | null = null;
  return {
    /** 실행 런타임이 PTY 의 Ctrl+V 쓰기를 건다. */
    bindTerminalPaste(paste: (objectiveId: string) => boolean): () => void { terminalPaste = paste; return () => { if (terminalPaste === paste) terminalPaste = null; }; },
    /** 터미널 Objective 의 CLI 에 붙여넣기를 누른다. PTY 가 없거나 죽었으면 false. */
    pasteIntoTerminal(objectiveId: string): boolean { return terminalPaste ? terminalPaste(objectiveId) : false; },
    connect(): BrowserMcpConnection {
      if (disposed) throw new Error("Browser MCP host is disposed");
      const controller = new AbortController();
      const registry = createMcpToolRegistry();
      const snapshotStore = createMcpToolSnapshotStore();
      for (const spec of specs) {
        const schema = z.fromJSONSchema(spec.parameters as Parameters<typeof z.fromJSONSchema>[0]);
        registry.registerAgentTool({ ...spec, execute: (args, context) => {
          const parsed = schema.safeParse(args);
          if (!parsed.success || !context.sessionLabel || controller.signal.aborted) return Promise.resolve({ content: [{ type: "text", text: JSON.stringify({ error: "browser_arguments_invalid", issues: parsed.success ? [] : parsed.error.issues.map((issue) => describeArgumentIssue(args, issue)) }) }], isError: true });
          const { denied, objectiveId, participantId } = deny(deps, context.sessionLabel);
          if (denied || !objectiveId || !participantId) return Promise.resolve(denied ?? refuse("caller_unresolved", null, "en"));
          const signals = [controller.signal, ...(context.signal ? [context.signal] : [])];
          // 세션 라벨 자리에 브라우저의 주인(Objective id)을 실어 보낸다 — 도구는 Objective 만 안다. 부른 참가자는 따로 싣는다.
          const toolContext: BrowserToolCtx = { ...context, sessionLabel: objectiveId, participantId, signal: AbortSignal.any(signals) };
          return spec.execute(parsed.data, toolContext);
        } });
      }
      const server = createServedMcpEndpoint({ transport: deps.transport, serverInfo: { name: FLEET_BROWSER_MCP_SERVER }, toolSnapshotStore: snapshotStore });
      const manager = createExecutorSessionManager({ runtimes: [{ name: FLEET_BROWSER_MCP_SERVER, runtime: { registry, snapshotStore, server, onFailure: deps.onFailure } }] });
      let closed = false;
      let closing: Promise<void> | null = null;
      const connection: BrowserMcpConnection = {
        getEndpoint: async () => { if (closed) throw new Error("Browser MCP disposed"); return manager.getEndpoint(); },
        issueSessionToken: (request) => { if (closed) throw new Error("Browser MCP disposed"); return manager.issueSessionToken(request); },
        // 이 세션(참가자)의 턴이 끝났다 — 그 참가자의 호출만 끊는다. 같은 브라우저를 쓰는 다른 참가자의 호출은 그대로 간다.
        cancelSession: (label) => { const scope = scopeOf(deps, objectiveIdFromSessionLabel(label)); deps.service.interrupt(scope.contextId, scope.participantId); },
        releaseSessionToken: (label) => { const scope = scopeOf(deps, objectiveIdFromSessionLabel(label)); deps.service.interrupt(scope.contextId, scope.participantId); manager.releaseSessionToken(label); },
        cleanup: () => { manager.cleanup(); },
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
    resolveSessionOwner(pluginId: string, scopeId: string): string | null { return pluginOwners.get(ownerKey(pluginId, scopeId)) ?? null; },
    isSessionOwner(id: string): boolean { return id !== GLOBAL_BROWSER_OWNER_ID && [...pluginOwners.values()].includes(id); },
    connectPlugin(options: BrowserPluginOptions): BrowserPluginConnection {
      if (disposed) throw new Error("Browser MCP host is disposed");
      if (!options.pluginId || !options.scopeId || options.scopeId.length > 256) throw new Error("browser_scope_invalid");
      const key = ownerKey(options.pluginId, options.scopeId);
      const owner = pluginOwners.get(key) ?? `${SESSION_BROWSER_OWNER_PREFIX}${randomUUID()}`;
      if (pluginConnections.has(owner)) throw new Error("browser_scope_in_use");
      const controller = new AbortController();
      const calls = new Set<AbortController>();
      let closed = false;
      let closing: Promise<void> | null = null;
      const language = () => deps.language?.() ?? "en";
      const endTurn = () => {
        for (const call of calls) call.abort();
        calls.clear();
        deps.service.interrupt(owner);
        deps.service.endAgentSession(owner, "turn");
      };
      const tools = createBrowserToolSpecs({ ...deps, screenshotDelivery: "inline" }).map((spec) => {
        const schema = z.fromJSONSchema(spec.parameters as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodObject;
        return defineTool(spec.id, spec.description, schema.shape, async (args) => {
          if (closed || controller.signal.aborted || !options.enabled()) return refuse("caller_unresolved", null, language());
          const availability = deps.service.availability();
          if (!availability.available) return refuse(availability.reason === "shared" ? "shared" : "desktop_required", owner, language());
          const parsed = schema.safeParse(args);
          if (!parsed.success) return { content: [{ type: "text", text: JSON.stringify({ error: "browser_arguments_invalid", issues: parsed.error.issues.map((issue) => describeArgumentIssue(args, issue)) }) }], isError: true };
          const call = new AbortController();
          calls.add(call);
          try {
            // 호출자가 owner를 지정할 수 없다. 다른 Session·Objective의 탭은 이 연결에 닿지 않는다.
            const result = await spec.execute(parsed.data, { cwd: "", sessionLabel: owner, signal: AbortSignal.any([controller.signal, call.signal]) });
            if (closed || call.signal.aborted || !options.enabled()) return refuse("caller_unresolved", null, language());
            return result as { content: readonly Readonly<Record<string, unknown>>[]; isError?: boolean };
          } finally { calls.delete(call); }
        });
      });
      const connection: BrowserPluginConnection = {
        embeddedServer: createEmbeddedMcpServer({ name: FLEET_BROWSER_MCP_SERVER, tools }),
        toolNames: specs.map((spec) => spec.id),
        endTurn,
        dispose() {
          if (closing) return closing;
          closed = true;
          controller.abort();
          endTurn();
          deps.screenshots?.release(owner);
          closing = deps.service.closeObjective(owner).finally(() => { pluginConnections.delete(owner); });
          return closing;
        },
      };
      pluginOwners.set(key, owner);
      pluginConnections.set(owner, connection);
      return connection;
    },
    /** 한 Objective의 허용을 거둘 때 — 진행 중 호출을 끊고 탭·컨텍스트를 닫는다. */
    revokeObjective(objectiveId: string): Promise<void> {
      const closing = deps.service.closeObjective(objectiveId);
      // 스크린샷은 사람이 본 페이지의 사본이다 — 브라우저를 거둘 때 함께 거둔다.
      deps.screenshots?.release(objectiveId);
      return closing;
    },
    /** 턴이 끝났다 — 그 참가자를 사용 세션에서 빼고, 남은 참가자가 없을 때만 표시를 내린다. 실행 런타임의 턴 종료 훅이 부른다. */
    endAgentSession(objectiveId: string): void { const scope = scopeOf(deps, objectiveId); deps.service.endAgentSession(scope.contextId, "turn", scope.participantId); },
    /** 사용자의 「중단」 — 허용은 남기고 진행 중 호출만 끊는다. 공유 브라우저면 모든 참가자의 호출을 끊는다. */
    interruptObjective(objectiveId: string): number { return deps.service.interrupt(scopeOf(deps, objectiveId).contextId); },
    toolNames: specs.map((spec) => spec.id),
    async dispose(): Promise<void> {
      disposed = true;
      await Promise.all([...connections, ...pluginConnections.values()].map((connection) => connection.dispose()));
      pluginOwners.clear();
      await deps.service.dispose();
      deps.screenshots?.cleanup();
    },
  };
}

export type BrowserMcpHost = ReturnType<typeof createBrowserMcpHost>;
