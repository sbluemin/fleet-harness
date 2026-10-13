import { randomUUID } from "node:crypto";
import { createEmbeddedMcpServer, defineTool, type ClaudeGatewayMcpServer } from "@fleet-console/agent-runtime/claude";
import { createExecutorSessionManager, createServedMcpEndpoint, type McpHttpTransport } from "@fleet-console/agent-runtime/mcp";
import { createMcpToolRegistry, createMcpToolSnapshotStore } from "@fleet-console/agent-runtime/tools";
import { z } from "zod";
import type { AdmiralMcpSession } from "@fleet-console/sdk/mcp";
import type { OperationNode } from "@fleet-console/sdk/operations";
import { GLOBAL_BROWSER_OWNER_ID, invalidTargetMessage, type BrowserService } from "./service.js";
import { createBrowserToolSpecs, type BrowserToolDeps } from "./tools.js";
import { operationIdFromSessionLabel } from "../../computer-use/host/mcp.js";

export const FLEET_BROWSER_MCP_SERVER = "fleet-browser";
export const SESSION_BROWSER_OWNER_PREFIX = "plugin-browser:";

export interface BrowserMcpDeps extends BrowserToolDeps {
  readonly transport?: McpHttpTransport;
  readonly service: BrowserService;
  readonly onFailure?: (kind: string, error: unknown) => void;
  readonly operations: () => readonly OperationNode[];
  readonly resolveOperation?: (id: string) => OperationNode | null;
  readonly language?: () => "en" | "ko" | null;
}

type BrowserRefusal = "caller_unresolved" | "desktop_required" | "shared";

const REFUSAL_INSTRUCTION: Record<BrowserRefusal, string> = {
  caller_unresolved: "This session has no active Console browser binding, so the Session Browser can never answer it. (Note: Fleet Browser is the user's Console-wide browser and is separate from this session-scoped browser). Do not retry and do not ask the user to change a setting. Continue without the browser.",
  desktop_required: "The Session Browser runs only inside the Fleet Desktop app, and no Desktop window is showing this Console right now. Do not retry until the user says they opened this Console in Fleet Desktop.",
  shared: "The Session Browser is paused because this Console is also open in a regular browser tab or on a phone. Do not retry until the user says only Fleet Desktop windows remain.",
};

const REFUSAL_MESSAGE: Record<BrowserRefusal, Record<"en" | "ko", string>> = {
  caller_unresolved: {
    en: "This session has no active Console browser binding, so the Session Browser is unavailable to it. (Fleet Browser is the user's Console-wide browser and is separate from this session-scoped browser).",
    ko: "이 세션에는 활성 Console 브라우저 연결이 없어 Session 브라우저를 쓸 수 없습니다. (전역 Fleet 브라우저는 사람 전용 브라우저이며 이 Session 브라우저와 분리되어 있습니다.)",
  },
  desktop_required: { en: "The Session Browser needs a Fleet Desktop window showing this Console.", ko: "Session 브라우저는 Fleet Desktop 창에서만 열립니다. 지금 이 Console 을 보는 Desktop 창이 없습니다." },
  shared: { en: "The Session Browser is paused while this Console is also open in a browser or on a phone.", ko: "이 Console 이 브라우저·모바일에서도 열려 있어 Session 브라우저가 멈춰 있습니다." },
};

function refuse(reason: BrowserRefusal, operationId: string | null, language: "en" | "ko") {
  const actionable = reason !== "caller_unresolved";
  return { content: [{ type: "text" as const, text: JSON.stringify({
    error: "browser_not_authorized", reason, retryable: actionable, retryAfter: actionable ? "user_action" : "never",
    remedy: { actor: "none", surface: "none", path: [] },
    agentInstruction: REFUSAL_INSTRUCTION[reason], message: REFUSAL_MESSAGE[reason][language],
  }) }], isError: true };
}

function deny(deps: BrowserMcpDeps, sessionLabel: string | undefined) {
  const id = operationIdFromSessionLabel(sessionLabel);
  const fallback = deps.language?.() ?? "en";
  // 전역 Fleet 브라우저의 소유자 id는 어떤 경로로 상태에 들어왔든 Operation으로 풀지 않는다 — 에이전트가 사람의 탭에 닿지 않게.
  const operation = id === GLOBAL_BROWSER_OWNER_ID || id.startsWith(SESSION_BROWSER_OWNER_PREFIX) ? null : deps.resolveOperation?.(id) ?? deps.operations().find((op) => op.id === id);
  if (!operation) return { denied: refuse("caller_unresolved", null, fallback), operationId: null };
  // 브라우저는 Desktop 앱의 것이다 — 창을 든 Desktop 이 있고 브라우저·모바일 화면이 없을 때만 열린다.
  const availability = deps.service.availability();
  if (!availability.available) return { denied: refuse(availability.reason === "shared" ? "shared" : "desktop_required", operation.id, fallback), operationId: operation.id };
  return { denied: null, operationId: operation.id };
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
  // 터미널 Operation 의 CLI 에 붙여넣기를 누르는 손 — PTY 는 실행 런타임이 소유하므로 그쪽이 기동하며 묶는다.
  let terminalPaste: ((operationId: string) => boolean) | null = null;
  return {
    /** 실행 런타임이 PTY 의 Ctrl+V 쓰기를 건다. */
    bindTerminalPaste(paste: (operationId: string) => boolean): () => void { terminalPaste = paste; return () => { if (terminalPaste === paste) terminalPaste = null; }; },
    /** 터미널 Operation 의 CLI 에 붙여넣기를 누른다. PTY 가 없거나 죽었으면 false. */
    pasteIntoTerminal(operationId: string): boolean { return terminalPaste ? terminalPaste(operationId) : false; },
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
          const { denied, operationId } = deny(deps, context.sessionLabel);
          if (denied || !operationId) return Promise.resolve(denied ?? refuse("caller_unresolved", null, "en"));
          const signals = [controller.signal, ...(context.signal ? [context.signal] : [])];
          // 세션 라벨 자리에 Operation id 를 실어 보낸다 — 도구는 Operation 만 안다.
          return spec.execute(parsed.data, { ...context, sessionLabel: operationId, signal: AbortSignal.any(signals) });
        } });
      }
      const server = createServedMcpEndpoint({ transport: deps.transport, serverInfo: { name: FLEET_BROWSER_MCP_SERVER }, toolSnapshotStore: snapshotStore });
      const manager = createExecutorSessionManager({ runtimes: [{ name: FLEET_BROWSER_MCP_SERVER, runtime: { registry, snapshotStore, server, onFailure: deps.onFailure } }] });
      let closed = false;
      let closing: Promise<void> | null = null;
      const connection: BrowserMcpConnection = {
        getEndpoint: async () => { if (closed) throw new Error("Browser MCP disposed"); return manager.getEndpoint(); },
        issueSessionToken: (request) => { if (closed) throw new Error("Browser MCP disposed"); return manager.issueSessionToken(request); },
        cancelSession: (label) => { deps.service.interrupt(operationIdFromSessionLabel(label)); },
        releaseSessionToken: (label) => { deps.service.interrupt(operationIdFromSessionLabel(label)); manager.releaseSessionToken(label); },
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
            // 호출자가 owner를 지정할 수 없다. 전역 Fleet 브라우저와 Operation의 탭은 이 연결에 닿지 않는다.
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
          closing = deps.service.closeOperation(owner).finally(() => { pluginConnections.delete(owner); });
          return closing;
        },
      };
      pluginOwners.set(key, owner);
      pluginConnections.set(owner, connection);
      return connection;
    },
    /** 한 Operation의 허용을 거둘 때 — 진행 중 호출을 끊고 탭·컨텍스트를 닫는다. */
    revokeOperation(operationId: string): Promise<void> {
      const closing = deps.service.closeOperation(operationId);
      // 스크린샷은 사람이 본 페이지의 사본이다 — 브라우저를 거둘 때 함께 거둔다.
      deps.screenshots?.release(operationId);
      return closing;
    },
    /** 턴이 끝났다 — 사용 중 표시를 내린다. 실행 런타임의 턴 종료 훅이 부른다. */
    endAgentSession(operationId: string): void { deps.service.endAgentSession(operationId, "turn"); },
    /** 사용자의 「중단」 — 허용은 남기고 진행 중 호출만 끊는다. */
    interruptOperation(operationId: string): number { return deps.service.interrupt(operationId); },
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
