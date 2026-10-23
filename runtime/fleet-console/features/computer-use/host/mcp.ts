import { randomUUID } from "node:crypto";
import { createExecutorSessionManager, createServedMcpEndpoint, type McpHttpTransport } from "@fleet-console/agent-runtime/mcp";
import { createMcpToolRegistry, createMcpToolSnapshotStore } from "@fleet-console/agent-runtime/tools";
import { createEmbeddedMcpServer, defineTool, type ClaudeGatewayMcpServer } from "@fleet-console/agent-runtime/claude";
import type { AdmiralMcpSession } from "../../execution/shared/admiral-mcp.js";
import { z } from "zod";
import type { OperationNode } from "../../execution/shared/operations/types.js";
import type { ComputerUseService } from "./computer-use.js";

export const FLEET_COMPUTER_USE_MCP_SERVER = "fleet-computer-use";

export interface ComputerUseMcpDeps {
  readonly transport?: McpHttpTransport;
  readonly service: ComputerUseService;
  readonly onFailure?: (kind: string, error: unknown) => void;
  /**
   * 호출자 Operation 단위 판정의 재료. 주어지면 조회·정리를 포함한 **모든** 도구가 실험 플래그와
   * 그 Operation의 토글을 둘 다 요구한다 — 콘솔 사용과 같은 정책이다. 없으면(테스트·플러그인 없는
   * 구성) 실험 플래그만 본다.
   */
  readonly operations?: () => readonly OperationNode[];
  readonly resolveOperation?: (id: string) => OperationNode | null;
  readonly experimentEnabled?: () => boolean;
  readonly language?: () => "en" | "ko" | null;
  /**
   * 패널 안 허용 요청 — 콘솔 사용과 같은 요청 브로커를 호스트 조립이 주입한다(이 기능은 콘솔 사용 구현을 모른다).
   * 주어지면 허용받지 않은 Operation 호출은 거부 대신 붙잡혀 그 패널에 카드를 띄우고, 「이번 작업만」 허가도 허용으로 친다.
   */
  readonly requests?: ComputerUseRequestPort;
  /**
   * 호출한 세션 → 사용 컨텍스트. 자식 세션은 루트(contextId)의 허용과 기기를 함께 쓴다. `shared` 는 자식 세션이 있는 묶음이라는
   * 뜻이고, 그때만 기기 소유자를 루트 하나로 정규화해 참가자들이 직렬로 나눠 쓴다. 없으면 호출한 Operation 자신이다.
   */
  readonly useContext?: (operationId: string) => ComputerUseScope | null;
  /** 공유 묶음에서 기기를 쓰는 참가자가 바뀌었다 — 호스트가 사용 스냅숏(조작자)을 다시 흘린다. */
  readonly onActorChange?: () => void;
}

export interface ComputerUseScope {
  readonly contextId: string;
  readonly participantId: string;
  readonly shared: boolean;
}

function scopeOf(deps: ComputerUseMcpDeps, operationId: string): ComputerUseScope {
  return deps.useContext?.(operationId) ?? { contextId: operationId, participantId: operationId, shared: false };
}

/** Operation 호출자에게만 붙는 설명 — 플러그인 호출자는 카드를 띄우지 않는다. */
const OPERATION_REQUEST_NOTE = "Permission: needs this Operation's Computer Use toggle or a per-turn allowance from the request card in the Operation panel. Otherwise the call waits up to four minutes for the person's answer; a per-turn allowance ends with your turn. If declined or unanswered, do not request Computer Use again this turn.";

/** 요청 브로커 중 컴퓨터 사용이 쓰는 몫. */
export interface ComputerUseRequestPort {
  hold(input: {
    readonly operationId: string;
    readonly participantId?: string;
    readonly capability: "computer";
    readonly tool: string;
    readonly signal?: AbortSignal;
    readonly authorized: () => boolean;
    readonly withdrawn?: () => boolean;
  }): Promise<"turn" | "always" | "authorized" | "declined" | "no_response" | "stopped" | "withdrawn">;
  granted(operationId: string, capability: "computer"): boolean;
  touch(operationId: string, capability: "computer"): void;
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

type ComputerUseRefusal = "experiment_disabled" | "operation_not_authorized" | "plugin_not_authorized" | "caller_unresolved" | "declined_by_user" | "no_response";

const REFUSAL_REMEDY = {
  experiment_disabled: { actor: "user", surface: "settings", path: ["Settings", "Experiments", "Computer Use"] },
  operation_not_authorized: { actor: "user", surface: "operation_panel", path: ["Operation menu", "Computer Use"] },
  plugin_not_authorized: { actor: "user", surface: "caller_menu", path: ["Caller menu", "Computer Use"] },
  caller_unresolved: { actor: "none", surface: "none", path: [] },
  declined_by_user: { actor: "user", surface: "operation_panel", path: ["Operation panel", "Computer Use request"] },
  no_response: { actor: "user", surface: "operation_panel", path: ["Operation panel", "Computer Use request"] },
} as const satisfies Record<ComputerUseRefusal, { readonly actor: string; readonly surface: string; readonly path: readonly string[] }>;

const REFUSAL_INSTRUCTION: Record<ComputerUseRefusal, string> = {
  experiment_disabled: "Computer Use is turned off for this Console, so the host refused this call. This is not a transient failure. Do not retry and do not look for another route to the user's computer. Ask the user to turn on Settings > Experiments > Computer Use, then stop and wait for them. Once they do, repeat this exact call: it succeeds with no restart and no reconnection.",
  operation_not_authorized: "This Operation has not been authorized to use the computer, so the host refused this call. This is not a transient failure. Do not retry and do not look for another route to the user's computer. Ask the user to turn on Computer Use (컴퓨터 사용 in the Korean interface) in this Operation's own menu (the ··· button in its caption, or right-click in the sidebar), then stop and wait for them. Once they do, repeat this exact call: it succeeds with no restart and no reconnection.",
  plugin_not_authorized: "You have not been authorized to use the computer, so the host refused this call. This is not a transient failure. Do not retry and do not look for another route to the user's computer. Ask the user to turn on Computer Use in your own ··· menu, then stop and wait for them. Once they do, repeat this exact call: it succeeds with no restart and no reconnection.",
  caller_unresolved: "This session is not bound to a Console Operation, so Computer Use can never answer it. Do not retry and do not ask the user to change a setting — nothing they can turn on fixes this. Continue without the computer.",
  declined_by_user: "The person declined this Computer Use request in the Operation panel. Do not request Computer Use again in this turn and do not look for another route to the user's computer. Continue the task without the computer, and tell the person what you could not do.",
  no_response: "Nobody answered the Computer Use request in the Operation panel within four minutes, so the host refused this call. Do not keep calling Computer Use tools in this turn. Continue without the computer, and tell the person they can allow it from the panel card the next time you ask.",
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
  plugin_not_authorized: {
    en: "Computer Use is not allowed here. Turn on Computer Use in the ··· menu of the one you are talking to — it applies immediately, with no restart.",
    ko: "여기에는 컴퓨터 사용이 허용되지 않았습니다. 대화 상대의 ··· 메뉴에서 「컴퓨터 사용」을 켜 주세요. 켜면 다시 연결하지 않아도 곧바로 이어집니다.",
  },
  caller_unresolved: {
    en: "This session is not bound to a Console Operation, so Computer Use is unavailable to it.",
    ko: "이 세션은 Console Operation에 묶여 있지 않아 컴퓨터 사용을 쓸 수 없습니다.",
  },
  declined_by_user: {
    en: "You declined Computer Use for this Operation. It continues without the computer.",
    ko: "이 Operation의 컴퓨터 사용을 거절했습니다. 컴퓨터 없이 계속합니다.",
  },
  no_response: {
    en: "The Computer Use request got no answer, so it was declined. It continues without the computer.",
    ko: "컴퓨터 사용 요청에 답이 없어 거절로 처리했습니다. 컴퓨터 없이 계속합니다.",
  },
};

function refuse(reason: ComputerUseRefusal, operationId: string | null, language: "en" | "ko") {
  // 거절·무응답은 이번 턴에서 다시 두드릴 길이 아니다.
  const actionable = reason === "experiment_disabled" || reason === "operation_not_authorized" || reason === "plugin_not_authorized";
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
function computerUseDenial(deps: ComputerUseMcpDeps, sessionLabel: string | undefined): { readonly reason: ComputerUseRefusal; readonly operationId: string | null; readonly language: "en" | "ko" } | null {
  if (!deps.operations) return null;
  // 자식 세션의 허용은 루트의 것이다 — 판정은 루트 노드의 payload 와 루트 키의 허가로 한다.
  const id = scopeOf(deps, operationIdFromSessionLabel(sessionLabel)).contextId;
  const fallback = deps.language?.() ?? "en";
  const operation = deps.resolveOperation?.(id) ?? deps.operations().find((op) => op.id === id);
  if (!operation) return { reason: "caller_unresolved", operationId: null, language: fallback };
  const flag = readComputerUseFlag(operation.payload);
  const language = flag?.language ?? fallback;
  if (deps.experimentEnabled?.() !== true) return { reason: "experiment_disabled", operationId: operation.id, language };
  if (!flag && deps.requests?.granted(operation.id, "computer") !== true) return { reason: "operation_not_authorized", operationId: operation.id, language };
  return null;
}

function denyComputerUse(deps: ComputerUseMcpDeps, sessionLabel: string | undefined) {
  const denial = computerUseDenial(deps, sessionLabel);
  return denial ? refuse(denial.reason, denial.operationId, denial.language) : null;
}

/**
 * 허용받지 않은 Operation 호출을 붙잡아 그 패널에 허용 요청 카드를 띄운다. 카드는 그 Operation의 허용만 묻는다 —
 * 실험 스위치를 끈 것은 사람이 이미 내린 답이므로 붙잡지 않고 바로 거부하고, 기다리는 사이 스위치가 꺼지면
 * 카드를 거두고 같은 사유로 거부한다.
 */
async function holdComputerUse(deps: ComputerUseMcpDeps, sessionLabel: string, tool: string, signal: AbortSignal) {
  const denial = computerUseDenial(deps, sessionLabel);
  if (!denial) return null;
  const requests = deps.requests;
  if (!requests || !denial.operationId || denial.reason !== "operation_not_authorized") return refuse(denial.reason, denial.operationId, denial.language);
  const outcome = await requests.hold({
    operationId: denial.operationId,
    participantId: scopeOf(deps, operationIdFromSessionLabel(sessionLabel)).participantId,
    capability: "computer",
    tool,
    signal,
    authorized: () => computerUseDenial(deps, sessionLabel) === null,
    withdrawn: () => deps.experimentEnabled?.() !== true,
  });
  if (outcome === "declined") return refuse("declined_by_user", denial.operationId, denial.language);
  if (outcome === "no_response") return refuse("no_response", denial.operationId, denial.language);
  if (outcome === "withdrawn") return refuse("experiment_disabled", denial.operationId, denial.language);
  if (outcome === "stopped") return refuse(denial.reason, denial.operationId, denial.language);
  return denyComputerUse(deps, sessionLabel);
}
export interface ComputerUseMcpConnection extends AdmiralMcpSession {
  cancelSession(label: string): void;
  dispose(): Promise<void>;
}

/** 플러그인 에이전트 세션 하나에 묻어 들어가는 기기 조작 서버 — Operation 신원이 없는 호출자용. */
export interface ComputerUsePluginConnection {
  readonly embeddedServer: ClaudeGatewayMcpServer;
  readonly toolNames: readonly string[];
  /** 허용을 거둔 순간 — 진행 중 호출을 끊고 잡고 있던 기기를 놓는다. 다음 호출은 `enabled()`가 거부한다. */
  revoke(): void;
  dispose(): Promise<void>;
}

export interface ComputerUsePluginOptions {
  readonly enabled: () => boolean;
  readonly language?: () => "en" | "ko" | null;
}

/** Console 조회 MCP와 도구·토큰·소유권을 공유하지 않는 기기 조작 서버. */
export function createComputerUseMcpHost(deps: ComputerUseMcpDeps) {
  const connections = new Set<ComputerUseMcpConnection>();
  const pluginConnections = new Set<ComputerUsePluginConnection>();
  // 진행 중인 도구 호출을 호출자 Operation별로 기억한다 — 허용을 거둘 때 아직 기기를 잡기 전
  // (대상 풀이 중)인 호출까지 끊어야 한다. 소유자 라벨은 잡은 뒤에만 서므로 그것만으로는 모자란다.
  const inFlight = new Map<string, Set<AbortController>>();
  const operationOwners = new Map<string, string>();
  // 기기를 지금 쓰는(마지막으로 부른) 참가자 — 공유 소유자에서는 루트와 다르다. 캡처 스냅숏의 actor 가 읽는다.
  const ownerActors = new Map<string, string>();
  // 연결마다 공유 묶음을 가진다 — 턴 종료·허용 회수가 모든 연결의 묶음에 닿도록 호스트가 이 고리를 돈다.
  const groupHooks = new Set<{ leave(contextId: string, participantId: string): boolean; revoke(contextId: string): void }>();
  let disposed = false;
  return {
    operationIdForOwner: (owner: string) => operationOwners.get(owner) ?? null,
    /** 그 소유자의 기기를 지금 쓰는 참가자(호출한 세션). 공유 묶음이 아니면 소유 Operation 자신이다. */
    actorForOwner: (owner: string) => ownerActors.get(owner) ?? operationOwners.get(owner) ?? null,
    connect(): ComputerUseMcpConnection {
      if (disposed) throw new Error("Computer Use MCP host is disposed");
      const prefix = randomUUID();
      const owner = (label: string) => `${prefix}:${label}`;
      const owners = new Set<string>();
      const controller = new AbortController();
      const registry = createMcpToolRegistry();
      const snapshotStore = createMcpToolSnapshotStore();
      /**
       * 공유 묶음 — 자식 세션이 있는 컨텍스트의 참가자들이 기기 하나를 나눠 쓴다. 소유자 라벨은 루트 하나(`${prefix}:${contextId}`)라
       * 서비스의 단일 점유 규칙은 묶음 밖과의 경계로만 남는다. 묶음 안에서는:
       * - 호출은 거부 대신 줄을 서 한 번에 하나씩 기기에 닿는다(`tail`).
       * - 한 참가자의 취소(턴 종료·중단)는 그 참가자에게만 곧바로 「취소됨」을 돌려준다. 서비스에 넘기는 신호는 묶음의 수명뿐이라
       *   기기를 놓지 않는다 — 네이티브 호출은 취소 신호를 받지 못하므로(브로커를 멈추는 것만이 취소다) 이미 보낸 조작은 끝까지
       *   돌고 그 결과는 버려지며, 다음 호출은 그것이 끝난 뒤에야 시작한다. 동시에 두 조작이 기기에 닿는 일은 없다.
       * - 기기는 마지막 참가자가 빠질 때(턴 종료·computer_end) 놓는다.
       */
      interface SharedGroup { readonly label: string; readonly lifetime: AbortController; readonly participants: Set<string>; readonly calls: Map<AbortController, string>; tail: Promise<unknown> }
      const groups = new Map<string, SharedGroup>();
      const releaseGroup = (contextId: string) => {
        const group = groups.get(contextId);
        if (!group) return;
        groups.delete(contextId);
        for (const call of group.calls.keys()) call.abort();
        group.calls.clear();
        group.participants.clear();
        group.lifetime.abort();
        deps.service.release(group.label);
        owners.delete(group.label);
        operationOwners.delete(group.label);
        ownerActors.delete(group.label);
      };
      /** 한 참가자가 묶음에서 빠진다 — 그 참가자의 호출만 끊고, 남은 참가자가 없으면 기기를 놓는다. 묶음이 있었으면 true. */
      const leaveGroup = (contextId: string, participantId: string): boolean => {
        const group = groups.get(contextId);
        if (!group) return false;
        for (const [call, participant] of group.calls) if (participant === participantId) { call.abort(); group.calls.delete(call); }
        group.participants.delete(participantId);
        if (group.participants.size === 0) releaseGroup(contextId);
        return true;
      };
      const groupHook = { leave: leaveGroup, revoke: releaseGroup };
      groupHooks.add(groupHook);
      const cancelled = () => ({ content: [{ type: "text", text: JSON.stringify({ error: "computer_use_call_cancelled", hint: "Your turn ended or was stopped, so this call was cancelled for you. The shared Computer Use session stays with the other participants. An action already sent to the app may still complete; read the window again before acting." }) }], isError: true });
      const runShared = async (spec: ReturnType<ComputerUseService["specs"]>[number], args: unknown, context: Parameters<ReturnType<ComputerUseService["specs"]>[number]["execute"]>[1], scope: ComputerUseScope) => {
        let group = groups.get(scope.contextId);
        if (!group) {
          group = { label: owner(scope.contextId), lifetime: new AbortController(), participants: new Set(), calls: new Map(), tail: Promise.resolve() };
          groups.set(scope.contextId, group);
        }
        const shared = group;
        owners.add(shared.label);
        operationOwners.set(shared.label, scope.contextId);
        if (spec.id === "computer_end") {
          // 부른 참가자의 참여만 끝낸다 — 기기는 마지막 참가자가 빠질 때 놓는다.
          leaveGroup(scope.contextId, scope.participantId);
          const deviceReleased = !groups.has(scope.contextId);
          return { content: [{ type: "text", text: JSON.stringify({ ended: true, scope: "participant", deviceReleased, reconnect: "on_next_use", hint: deviceReleased ? "You were the last participant, so the device was released." : "Only your participation ended. Other participants of this conversation keep the shared Computer Use session." }) }], isError: false };
        }
        shared.participants.add(scope.participantId);
        const call = new AbortController();
        shared.calls.set(call, scope.participantId);
        const mine = AbortSignal.any([call.signal, controller.signal, ...(context.signal ? [context.signal] : [])]);
        const run = shared.tail.then(() => {
          if (mine.aborted || shared.lifetime.signal.aborted) return cancelled();
          if (ownerActors.get(shared.label) !== scope.participantId) { ownerActors.set(shared.label, scope.participantId); deps.onActorChange?.(); }
          return spec.execute(args, { ...context, sessionLabel: shared.label, signal: AbortSignal.any([shared.lifetime.signal, controller.signal]) });
        });
        shared.tail = run.then(() => undefined, () => undefined);
        try {
          return await new Promise<Awaited<typeof run>>((resolve, reject) => {
            const onAbort = () => resolve(cancelled());
            if (mine.aborted) { onAbort(); return; }
            mine.addEventListener("abort", onAbort, { once: true });
            run.then((value) => { mine.removeEventListener("abort", onAbort); resolve(mine.aborted ? cancelled() : value); }, (error) => { mine.removeEventListener("abort", onAbort); reject(error); });
          });
        } finally { shared.calls.delete(call); }
      };
      for (const spec of deps.service.specs()) {
        const schema = z.fromJSONSchema(spec.parameters as Parameters<typeof z.fromJSONSchema>[0]);
        registry.registerAgentTool({ ...spec, ...(deps.requests ? { description: `${spec.description} ${OPERATION_REQUEST_NOTE}` } : {}), execute: async (args, context) => {
          const parsed = schema.safeParse(args);
          if (!parsed.success || !context.sessionLabel || controller.signal.aborted) return { content: [{ type: "text", text: "Computer Use session or arguments unavailable" }], isError: true };
          // 허용은 도구 호출마다 다시 읽는다 — Operation 토글과 실험 끄기는 재연결 없이 다음 호출부터 듣는다.
          // Operation의 허용을 받지 않았으면 패널에서 사람의 답을 기다린다.
          const denied = await holdComputerUse(deps, context.sessionLabel, spec.id, AbortSignal.any([controller.signal, ...(context.signal ? [context.signal] : [])]));
          if (denied) return denied;
          if (controller.signal.aborted) return { content: [{ type: "text", text: "Computer Use session unavailable" }], isError: true };
          const scope = scopeOf(deps, operationIdFromSessionLabel(context.sessionLabel));
          deps.requests?.touch(scope.contextId, "computer");
          if (scope.shared) return runShared(spec, parsed.data, context, scope);
          const sessionLabel = owner(context.sessionLabel);
          owners.add(sessionLabel);
          const operationId = operationIdFromSessionLabel(context.sessionLabel);
          operationOwners.set(sessionLabel, operationId);
          const call = new AbortController();
          const calls = inFlight.get(operationId) ?? new Set<AbortController>();
          calls.add(call);
          inFlight.set(operationId, calls);
          const signals = [call.signal, controller.signal, ...(context.signal ? [context.signal] : [])];
          return spec.execute(parsed.data, { ...context, sessionLabel, signal: AbortSignal.any(signals) })
            .finally(() => { calls.delete(call); if (calls.size === 0) inFlight.delete(operationId); });
        } });
      }
      const server = createServedMcpEndpoint({ transport: deps.transport, serverInfo: { name: FLEET_COMPUTER_USE_MCP_SERVER }, toolSnapshotStore: snapshotStore });
      const manager = createExecutorSessionManager({ runtimes: [{ name: FLEET_COMPUTER_USE_MCP_SERVER, runtime: { registry, snapshotStore, server, onFailure: deps.onFailure } }] });
      let closed = false;
      let closing: Promise<void> | null = null;
      const release = (label: string) => {
        const id = owner(label);
        // 터미널(PTY) 루트의 라벨은 루트 id 그대로라 공유 묶음의 소유자 라벨과 같아진다 — 그 기기는 묶음이 마지막 참가자와 함께 놓는다.
        if (![...groups.values()].some((group) => group.label === id)) { deps.service.release(id); owners.delete(id); operationOwners.delete(id); ownerActors.delete(id); }
        // 공유 묶음의 참가자라면 그 참가자만 묶음에서 뺀다 — 같은 기기를 쓰는 다른 참가자의 호출은 그대로 간다.
        const scope = scopeOf(deps, operationIdFromSessionLabel(label));
        leaveGroup(scope.contextId, scope.participantId);
      };
      const cleanup = () => {
        for (const contextId of [...groups.keys()]) releaseGroup(contextId);
        for (const id of owners) { deps.service.release(id); operationOwners.delete(id); ownerActors.delete(id); }
        owners.clear(); manager.cleanup();
      };
      const connection: ComputerUseMcpConnection = {
        getEndpoint: async () => { if (closed) throw new Error("Computer Use MCP disposed"); return manager.getEndpoint(); },
        issueSessionToken: (request) => {
          if (closed) throw new Error("Computer Use MCP disposed");
          // 실험 스위치는 런치가 이 서버를 싣는지를 정한다. 꺼져 있으면 토큰을 내지 않고, 런치는 토큰이 없는
          // 서버를 빼므로 그 세션에는 도구가 없다. 켜진 채 연 세션은 도중에 꺼도 도구가 남지만 호출은 바로
          // 거부되고(호출마다 판정), 꺼진 채 연 세션은 도중에 켜도 다음 자식 런치(새 세션·재개·휴면 해제·
          // 표면 전환)부터 도구를 받는다 — Agent CLI의 MCP 구성은 spawn 시점에 고정된다.
          if (!deps.service.status().enabled) { manager.releaseSessionToken(request.label); return []; }
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
          groupHooks.delete(groupHook);
          connections.delete(connection);
          closing = server.stop();
          return closing;
        },
      };
      connections.add(connection);
      return connection;
    },
    /**
     * Operation이 아닌 호출자(플러그인 에이전트 세션)에게 붙는 서버. HTTP 세션 토큰 대신 세션에
     * 묻어 들어가는 임베디드 서버이고, 허용은 호출마다 `enabled()`와 실험 스위치를 함께 묻는다 —
     * 콘솔 사용의 플러그인 연결과 같은 정책이다. 소유자 라벨은 연결마다 유일해 `revoke()`가 자기
     * 것만 놓는다. 실험 스위치가 꺼져 있으면 서버를 내주지 않는다(null) — Operation 런치와 같이 꺼진 채
     * 연 세션에는 도구가 없다.
     */
    connectPlugin(options: ComputerUsePluginOptions): ComputerUsePluginConnection | null {
      if (disposed) throw new Error("Computer Use MCP host is disposed");
      if (!deps.service.status().enabled) return null;
      const owner = `${randomUUID()}:plugin`;
      const controller = new AbortController();
      const calls = new Set<AbortController>();
      let closed = false;
      const language = () => options.language?.() ?? deps.language?.() ?? "en";
      const tools = deps.service.specs().map((spec) => {
        const schema = z.fromJSONSchema(spec.parameters as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodObject;
        return defineTool(spec.id, spec.description, schema.shape, async (args) => {
          if (closed || controller.signal.aborted) return { content: [{ type: "text", text: "Computer Use session unavailable" }], isError: true };
          // 허용은 도구 호출마다 다시 읽는다 — 부관의 허용과 실험 끄기는 재연결 없이 다음 호출부터 듣는다.
          if (deps.experimentEnabled?.() !== true) return refuse("experiment_disabled", null, language());
          if (!options.enabled()) return refuse("plugin_not_authorized", null, language());
          const parsed = schema.safeParse(args);
          if (!parsed.success) return { content: [{ type: "text", text: "Computer Use arguments invalid" }], isError: true };
          const call = new AbortController();
          calls.add(call);
          try {
            const result = await spec.execute(parsed.data, { cwd: "", sessionLabel: owner, signal: AbortSignal.any([call.signal, controller.signal]) });
            // 호출 중에 허용이 걷혔으면 이미 모은 결과도 내보내지 않는다 — 거부의 의미가 시간에 따라 새면 안 된다.
            if (!options.enabled()) return refuse("plugin_not_authorized", null, language());
            return result as { content: readonly Readonly<Record<string, unknown>>[]; isError?: boolean };
          } finally {
            calls.delete(call);
          }
        });
      });
      const embeddedServer = createEmbeddedMcpServer({ name: FLEET_COMPUTER_USE_MCP_SERVER, tools });
      const revoke = () => {
        for (const call of calls) call.abort();
        calls.clear();
        deps.service.release(owner);
      };
      const connection: ComputerUsePluginConnection = {
        embeddedServer,
        toolNames: deps.service.specs().map((spec) => spec.id),
        revoke,
        dispose: async () => {
          if (closed) return;
          closed = true;
          controller.abort();
          revoke();
          pluginConnections.delete(connection);
        },
      };
      pluginConnections.add(connection);
      return connection;
    },
    /**
     * 한 Operation의 허용을 거둘 때 부른다. 그 Operation(터미널·Chat 세션 어느 쪽이든)의 진행 중
     * 호출을 끊고, 기기를 잡고 있으면 즉시 놓는다 — 다음 호출이 거부되는 것만으로는 이미 인가를
     * 통과해 대상을 풀고 있는 호출이나 진행 중인 조작이 멈추지 않는다.
     */
    revokeOperation(operationId: string): void {
      // 자식 세션의 허용은 루트의 것이라 거두는 것도 루트 전체다(묶음의 모든 참가자 호출과 기기).
      const contextId = scopeOf(deps, operationId).contextId;
      for (const call of inFlight.get(contextId) ?? []) call.abort();
      for (const hook of groupHooks) hook.revoke(contextId);
      deps.service.releaseWhere((label) => label.endsWith(`:${contextId}`) || label.endsWith(`:chat:${contextId}`));
    },
    /**
     * 한 참가자의 턴이 끝났다. 공유 묶음이면 그 참가자의 호출만 끊고 묶음에서 빼며, 기기는 마지막 참가자가 빠질 때 놓는다.
     * 공유 묶음이 아니면 예전처럼 그 Operation 의 허용을 거둘 때와 같다(진행 중 호출을 끊고 기기를 놓는다).
     */
    endParticipant(operationId: string): void {
      const scope = scopeOf(deps, operationId);
      if (scope.shared) { for (const hook of groupHooks) hook.leave(scope.contextId, scope.participantId); return; }
      for (const call of inFlight.get(operationId) ?? []) call.abort();
      deps.service.releaseWhere((label) => label.endsWith(`:${operationId}`) || label.endsWith(`:chat:${operationId}`));
    },
    async dispose(): Promise<void> {
      disposed = true;
      await Promise.all([...connections].map((connection) => connection.dispose()));
      await Promise.all([...pluginConnections].map((connection) => connection.dispose()));
      await deps.service.stop();
    },
  };
}
