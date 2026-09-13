import { randomUUID } from "node:crypto";
import { createExecutorSessionManager, createMcpToolRegistry, createMcpToolSnapshotStore, createServedMcpEndpoint, type McpHttpTransport } from "@dotobokuri/core-agent";
import type { AdmiralMcpSession } from "@fleet-console/sdk/mcp";
import { z } from "zod";
import type { OperationNode } from "@fleet-console/sdk/operations";
import type { ComputerUseService } from "../agent/computer-use.js";

export const FLEET_COMPUTER_USE_MCP_SERVER = "fleet-computer-use";

export interface ComputerUseMcpDeps {
  readonly transport?: McpHttpTransport;
  readonly service: ComputerUseService;
  /**
   * 호출자 Operation 단위 판정의 재료. 주어지면 조회·정리를 포함한 **모든** 도구가 실험 플래그와
   * 그 Operation의 토글을 둘 다 요구한다 — 콘솔 사용과 같은 정책이다. 없으면(테스트·플러그인 없는
   * 구성) 실험 플래그만 본다.
   */
  readonly operations?: () => readonly OperationNode[];
  readonly experimentEnabled?: () => boolean;
  readonly language?: () => "en" | "ko" | null;
}

export function readComputerUseFlag(payload: Record<string, unknown> | undefined): { readonly enabled: true; readonly language: "en" | "ko" } | null {
  const value = payload?.computerUse;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.enabled !== true) return null;
  return { enabled: true, language: record.language === "ko" ? "ko" : "en" };
}

/** 세션 라벨 → 호출자 Operation id. Chat 세션은 `chat:` 접두를 단다(콘솔 사용과 같은 규약). */
export function operationIdFromSessionLabel(label: string | undefined): string {
  const value = label ?? "";
  return value.startsWith("chat:") ? value.slice(5) : value;
}

type ComputerUseRefusal = "experiment_disabled" | "operation_not_authorized" | "caller_unresolved";

const REFUSAL_REMEDY = {
  experiment_disabled: { actor: "user", surface: "settings", path: ["Settings", "Experiments", "Computer Use"] },
  operation_not_authorized: { actor: "user", surface: "operation_panel", path: ["Operation menu", "Computer Use"] },
  caller_unresolved: { actor: "none", surface: "none", path: [] },
} as const satisfies Record<ComputerUseRefusal, { readonly actor: string; readonly surface: string; readonly path: readonly string[] }>;

const REFUSAL_INSTRUCTION: Record<ComputerUseRefusal, string> = {
  experiment_disabled: "Computer Use is turned off for this Console, so the host refused this call. This is not a transient failure. Do not retry and do not look for another route to the user's computer. Ask the user to turn on Settings > Experiments > Computer Use, then stop and wait for them. Once they do, repeat this exact call: it succeeds with no restart and no reconnection.",
  operation_not_authorized: "This Operation has not been authorized to use the computer, so the host refused this call. This is not a transient failure. Do not retry and do not look for another route to the user's computer. Ask the user to turn on Computer Use in this Operation's own menu (the ··· button in its caption, or right-click in the sidebar), then stop and wait for them. Once they do, repeat this exact call: it succeeds with no restart and no reconnection.",
  caller_unresolved: "This session is not bound to a Console Operation, so Computer Use can never answer it. Do not retry and do not ask the user to change a setting — nothing they can turn on fixes this. Continue without the computer.",
};

const REFUSAL_MESSAGE: Record<ComputerUseRefusal, Record<"en" | "ko", string>> = {
  experiment_disabled: {
    en: "Computer Use is turned off. Turn on Settings > Experiments > Computer Use — it applies immediately, with no restart.",
    ko: "컴퓨터 사용이 꺼져 있습니다. 설정 > 실험 기능 > 컴퓨터 사용을 켜 주세요. 켜면 다시 연결하지 않아도 곧바로 이어집니다.",
  },
  operation_not_authorized: {
    en: "This Operation is not allowed to use the computer. Turn on Computer Use in this Operation's ··· menu — it applies immediately, with no restart.",
    ko: "이 Operation에 컴퓨터 사용이 허용되지 않았습니다. 이 Operation의 ··· 메뉴에서 「컴퓨터 사용」을 켜 주세요. 켜면 다시 연결하지 않아도 곧바로 이어집니다.",
  },
  caller_unresolved: {
    en: "This session is not bound to a Console Operation, so Computer Use is unavailable to it.",
    ko: "이 세션은 Console Operation에 묶여 있지 않아 컴퓨터 사용을 쓸 수 없습니다.",
  },
};

function refuse(reason: ComputerUseRefusal, operationId: string | null, language: "en" | "ko") {
  const actionable = reason !== "caller_unresolved";
  return { content: [{ type: "text" as const, text: JSON.stringify({
    error: "computer_use_not_authorized", reason,
    retryable: actionable, retryAfter: actionable ? "user_action" : "never",
    remedy: { ...REFUSAL_REMEDY[reason], ...(operationId ? { operationId } : {}) },
    agentInstruction: REFUSAL_INSTRUCTION[reason],
    message: REFUSAL_MESSAGE[reason][language],
  }) }], isError: true };
}

/**
 * 호출자 Operation 단위 판정 — 콘솔 사용과 같은 규칙이다. 실험 플래그와 그 Operation의 토글이
 * 둘 다 참일 때만 통과하고, 어느 쪽이 막았는지를 구분해 돌려준다. 신원이 풀리지 않으면 거부한다.
 */
function denyComputerUse(deps: ComputerUseMcpDeps, sessionLabel: string | undefined) {
  if (!deps.operations) return null;
  const id = operationIdFromSessionLabel(sessionLabel);
  const fallback = deps.language?.() ?? "en";
  const operation = deps.operations().find((op) => op.id === id);
  if (!operation) return refuse("caller_unresolved", null, fallback);
  const flag = readComputerUseFlag(operation.payload);
  const language = flag?.language ?? fallback;
  if (deps.experimentEnabled?.() !== true) return refuse("experiment_disabled", operation.id, language);
  if (!flag) return refuse("operation_not_authorized", operation.id, language);
  return null;
}
export interface ComputerUseMcpConnection extends AdmiralMcpSession {
  cancelSession(label: string): void;
  dispose(): Promise<void>;
}

/** Console 조회 MCP와 도구·토큰·소유권을 공유하지 않는 기기 조작 서버. */
export function createComputerUseMcpHost(deps: ComputerUseMcpDeps) {
  const connections = new Set<ComputerUseMcpConnection>();
  let disposed = false;
  return {
    connect(): ComputerUseMcpConnection {
      if (disposed) throw new Error("Computer Use MCP host is disposed");
      const prefix = randomUUID();
      const owner = (label: string) => `${prefix}:${label}`;
      const owners = new Set<string>();
      const controller = new AbortController();
      const registry = createMcpToolRegistry();
      const snapshotStore = createMcpToolSnapshotStore();
      for (const spec of deps.service.specs()) {
        const schema = z.fromJSONSchema(spec.parameters as Parameters<typeof z.fromJSONSchema>[0]);
        registry.registerAgentTool({ ...spec, execute: (args, context) => {
          const parsed = schema.safeParse(args);
          if (!parsed.success || !context.sessionLabel || controller.signal.aborted) return Promise.resolve({ content: [{ type: "text", text: "Computer Use session or arguments unavailable" }], isError: true });
          // 허용은 도구 호출마다 다시 읽는다 — 켜고 끄는 것이 재연결 없이 다음 호출부터 듣는다.
          const denied = denyComputerUse(deps, context.sessionLabel);
          if (denied) return Promise.resolve(denied);
          const sessionLabel = owner(context.sessionLabel);
          owners.add(sessionLabel);
          return spec.execute(parsed.data, { ...context, sessionLabel, signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal });
        } });
      }
      const server = createServedMcpEndpoint({ transport: deps.transport, serverInfo: { name: FLEET_COMPUTER_USE_MCP_SERVER }, toolSnapshotStore: snapshotStore });
      const manager = createExecutorSessionManager({ runtimes: [{ name: FLEET_COMPUTER_USE_MCP_SERVER, runtime: { registry, snapshotStore, server } }] });
      let closed = false;
      let closing: Promise<void> | null = null;
      const release = (label: string) => { const id = owner(label); deps.service.release(id); owners.delete(id); };
      const cleanup = () => { for (const id of owners) deps.service.release(id); owners.clear(); manager.cleanup(); };
      const connection: ComputerUseMcpConnection = {
        getEndpoint: async () => { if (closed) throw new Error("Computer Use MCP disposed"); return manager.getEndpoint(); },
        issueSessionToken: (request) => {
          if (closed) throw new Error("Computer Use MCP disposed");
          // 도구는 세션이 열릴 때부터 실려 있고 허용은 호출 시점에 판정한다(콘솔 사용과 같은 정책) —
          // 실험을 켜고 끄는 데 세션을 다시 열 필요가 없다.
          return manager.issueSessionToken(request);
        },
        cancelSession: release,
        releaseSessionToken: (label) => { release(label); manager.releaseSessionToken(label); },
        cleanup,
        dispose: () => {
          if (closing) return closing;
          closed = true;
          controller.abort();
          cleanup();
          connections.delete(connection);
          closing = server.stop();
          return closing;
        },
      };
      connections.add(connection);
      return connection;
    },
    /**
     * 한 Operation의 허용을 거둘 때 부른다. 그 Operation(터미널·Chat 세션 어느 쪽이든)이 지금
     * 기기를 잡고 있으면 즉시 놓는다 — 다음 호출이 거부되는 것만으로는 진행 중인 조작이 멈추지 않는다.
     */
    revokeOperation(operationId: string): void {
      deps.service.releaseWhere((label) => label.endsWith(`:${operationId}`) || label.endsWith(`:chat:${operationId}`));
    },
    async dispose(): Promise<void> {
      disposed = true;
      await Promise.all([...connections].map((connection) => connection.dispose()));
      await deps.service.stop();
    },
  };
}
