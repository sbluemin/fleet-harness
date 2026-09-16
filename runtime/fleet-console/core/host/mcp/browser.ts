import { createExecutorSessionManager, createMcpToolRegistry, createMcpToolSnapshotStore, createServedMcpEndpoint, type McpHttpTransport } from "@dotobokuri/core-agent";
import { z } from "zod";
import type { AdmiralMcpSession } from "@fleet-console/sdk/mcp";
import type { OperationNode } from "@fleet-console/sdk/operations";
import type { BrowserService } from "../browser/service.js";
import { createBrowserToolSpecs, type BrowserToolDeps } from "../browser/tools.js";
import { operationIdFromSessionLabel } from "./computer-use.js";

export const FLEET_BROWSER_MCP_SERVER = "fleet-browser";

export interface BrowserMcpDeps extends BrowserToolDeps {
  readonly transport?: McpHttpTransport;
  readonly service: BrowserService;
  readonly operations: () => readonly OperationNode[];
  readonly language?: () => "en" | "ko" | null;
}

type BrowserRefusal = "caller_unresolved" | "desktop_required" | "shared";

const REFUSAL_INSTRUCTION: Record<BrowserRefusal, string> = {
  caller_unresolved: "This session is not bound to a Console Operation, so the Browser can never answer it. Do not retry and do not ask the user to change a setting. Continue without the browser.",
  desktop_required: "The Operation Browser runs only inside the Fleet Desktop app, and no Desktop window is showing this Console right now. Do not retry until the user says they opened this Console in Fleet Desktop.",
  shared: "The Operation Browser is paused because this Console is also open in a regular browser tab or on a phone. Do not retry until the user says only Fleet Desktop windows remain.",
};

const REFUSAL_MESSAGE: Record<BrowserRefusal, Record<"en" | "ko", string>> = {
  caller_unresolved: { en: "This session is not bound to a Console Operation, so the Browser is unavailable to it.", ko: "이 세션은 Console Operation에 묶여 있지 않아 브라우저를 쓸 수 없습니다." },
  desktop_required: { en: "The Operation Browser needs a Fleet Desktop window showing this Console.", ko: "Operation 브라우저는 Fleet Desktop 창에서만 열립니다. 지금 이 Console 을 보는 Desktop 창이 없습니다." },
  shared: { en: "The Operation Browser is paused while this Console is also open in a browser or on a phone.", ko: "이 Console 이 브라우저·모바일에서도 열려 있어 Operation 브라우저가 멈춰 있습니다." },
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
  const operation = deps.operations().find((op) => op.id === id);
  if (!operation) return { denied: refuse("caller_unresolved", null, fallback), operationId: null };
  // 브라우저는 Desktop 앱의 것이다 — 창을 든 Desktop 이 있고 브라우저·모바일 화면이 없을 때만 열린다.
  const availability = deps.service.availability();
  if (!availability.available) return { denied: refuse(availability.reason === "shared" ? "shared" : "desktop_required", operation.id, fallback), operationId: operation.id };
  return { denied: null, operationId: operation.id };
}

export interface BrowserMcpConnection extends AdmiralMcpSession {
  cancelSession(label: string): void;
  dispose(): Promise<void>;
}

/**
 * Operation Browser MCP 서버. 도구는 세션이 열릴 때부터 실려 있고, 로컬 전용 여부만 호출마다 다시 판정한다.
 */
export function createBrowserMcpHost(deps: BrowserMcpDeps) {
  const connections = new Set<BrowserMcpConnection>();
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
          if (!parsed.success || !context.sessionLabel || controller.signal.aborted) return Promise.resolve({ content: [{ type: "text", text: JSON.stringify({ error: "browser_arguments_invalid", issues: parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) }) }], isError: true });
          const { denied, operationId } = deny(deps, context.sessionLabel);
          if (denied || !operationId) return Promise.resolve(denied ?? refuse("caller_unresolved", null, "en"));
          const signals = [controller.signal, ...(context.signal ? [context.signal] : [])];
          // 세션 라벨 자리에 Operation id 를 실어 보낸다 — 도구는 Operation 만 안다.
          return spec.execute(parsed.data, { ...context, sessionLabel: operationId, signal: AbortSignal.any(signals) });
        } });
      }
      const server = createServedMcpEndpoint({ transport: deps.transport, serverInfo: { name: FLEET_BROWSER_MCP_SERVER }, toolSnapshotStore: snapshotStore });
      const manager = createExecutorSessionManager({ runtimes: [{ name: FLEET_BROWSER_MCP_SERVER, runtime: { registry, snapshotStore, server } }] });
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
    /** 한 Operation의 허용을 거둘 때 — 진행 중 호출을 끊고 탭·컨텍스트를 닫는다. */
    revokeOperation(operationId: string): void { void deps.service.closeOperation(operationId); },
    /** 턴이 끝났다 — 사용 중 표시를 내린다. 실행 런타임의 턴 종료 훅이 부른다. */
    endAgentSession(operationId: string): void { deps.service.endAgentSession(operationId, "turn"); },
    /** 사용자의 「중단」 — 허용은 남기고 진행 중 호출만 끊는다. */
    interruptOperation(operationId: string): number { return deps.service.interrupt(operationId); },
    toolNames: specs.map((spec) => spec.id),
    async dispose(): Promise<void> {
      disposed = true;
      await Promise.all([...connections].map((connection) => connection.dispose()));
      await deps.service.dispose();
    },
  };
}

export type BrowserMcpHost = ReturnType<typeof createBrowserMcpHost>;
