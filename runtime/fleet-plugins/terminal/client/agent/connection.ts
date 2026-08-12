import type { OperationNode } from "@fleet-console/sdk/operations";
import type { ClientNotificationsCapability, ClientOperationStatusCapability, ClientOperationsCapability, OperationActivity } from "@fleet-console/sdk/plugin";

import { currentTerminalLocale, getT } from "../i18n/index.js";
import { fetchAgentState, fetchOperationsSnapshot, fetchSessions } from "./api.js";
import { createSseFrameParser, interpretAgentSessionFrame } from "./sse.js";
import { applySessionUpdate, hydrateAgentClis, hydrateSessions, setAgentState } from "./store.js";
import type { SessionInfo } from "./types.js";

export interface AgentConnectionOptions {
  readonly operations: ClientOperationsCapability;
  readonly notifications: ClientNotificationsCapability;
  readonly status: ClientOperationStatusCapability;
  readonly refreshOperations: () => void;
}

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;
// 세션별 직전 보고 activity. idle/awaiting 전이를 감지해 중복 없이 notification을 보내기 위함.
const lastActivity = new Map<string, OperationActivity>();

export function startAgentConnection(options: AgentConnectionOptions): () => void {
  const abort = new AbortController();
  void runConnectionLoop(abort.signal, options);
  return () => abort.abort();
}

async function runConnectionLoop(signal: AbortSignal, options: AgentConnectionOptions): Promise<void> {
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  while (!signal.aborted) {
    setAgentState({ connection: "connecting" });
    try {
      await resyncSnapshots(signal, options);
      const response = await fetch("/plugins/terminal/agent/events", { signal });
      if (!response.ok || !response.body) throw new Error(`Agent stream failed: ${response.status}`);
      setAgentState({ connection: "live", connectionError: null });
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      await consumeStream(response.body.getReader(), signal, options);
      if (!signal.aborted) setAgentState({ connection: "connecting", connectionError: null });
    } catch (error) {
      if (signal.aborted) return;
      setAgentState({ connection: "connecting", connectionError: error instanceof Error ? error.message : String(error) });
    }
    if (signal.aborted) return;
    await delay(reconnectDelay, signal);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }
}

async function consumeStream(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal, options: AgentConnectionOptions): Promise<void> {
  const decoder = new TextDecoder();
  const parse = createSseFrameParser();
  while (!signal.aborted) {
    const result = await reader.read();
    if (result.done) return;
    for (const frame of parse(decoder.decode(result.value, { stream: true }))) {
      const interpreted = interpretAgentSessionFrame(frame);
      if (!interpreted) continue;
      if (interpreted.kind === "session") {
        applySessionUpdate(interpreted.session);
        applyActivity(options, interpreted.session.sessionId, sessionActivity(interpreted.session));
        continue;
      }
      if (interpreted.kind === "attention") {
        applySessionUpdate(interpreted.session);
        // idle_prompt(정상 유휴)는 새 hook matcher에서 제외되지만, 업그레이드 전환기의 in-flight 세션이나
        // 아직 재렌더되지 않은 hooks.json이 옛 matcher로 idle_prompt를 보낼 수 있다. 그 호환성을 위해
        // idle_prompt는 client에서도 명시적으로 드롭한다(awaiting 전이 안 함). 나머지(permission_prompt·
        // elicitation_dialog, 그리고 reason 없는 AskUserQuestion=PreToolUse)는 입력 대기이므로 awaiting로 전이한다.
        if (interpreted.reason !== "idle_prompt") {
          applyActivity(options, interpreted.session.sessionId, "awaiting");
        }
      }
    }
  }
}

// 축마다 권위가 하나씩이다. modelActivity(=CLI가 OSC 타이틀로 방송하는 작업 여부)가 running/idle의 권위이고,
// attentionPending(=입력 대기 hook)은 OSC가 유휴와 구분하지 못하는 대기 상태를 담당하므로 그보다 앞선다.
// backgroundPending(=턴 종료·서브에이전트 종료 hook이 실어 오는 살아 있는 백그라운드 작업 목록)은 부모 턴보다 오래 남은 작업을 표시해 false idle을 막지만
// 절대 running으로 주장하지 않는다. turnState는 경쟁 소스가 아니라 OSC 타이틀을 인식하지 못했을 때의 폴백이다 —
// 두 optional 필드가 모두 부재할 때만 도달한다. 미인식 타이틀은 무의견으로 남아야 하며, 그래야 타이틀 어휘가 드리프트해도
// 거짓 idle 대신 hook 기반 동작으로 퇴보한다.
export function sessionActivity(session: SessionInfo): OperationActivity {
  if (session.status === "dormant") return "dormant";
  if (session.attentionPending === true) return "awaiting";
  // 타이틀 스피너는 누구의 작업인지 말해주지 않는다 — 호스트 턴이 도는 동안에도, 턴이 끝나고 백그라운드
  // 서브에이전트·워크플로우만 남은 동안에도 똑같이 돈다(2026-08-12 실측). 그 둘을 가르는 것은 턴 경계다:
  // 턴 종료가 보고된 뒤에 남은 작업은 정의상 백그라운드이므로, 이 구간에서만 backgroundPending이
  // 스피너보다 앞선다. 턴이 도는 동안에는 종전대로 running이 우선이다.
  if (session.turnState === "ended" && session.backgroundPending === true) return "background";
  if (session.modelActivity === "working") return "running";
  if (session.modelActivity === "not-working") return backgroundOrIdle(session);
  if (session.turnState === "running") return "running";
  return backgroundOrIdle(session);
}

function backgroundOrIdle(session: SessionInfo): OperationActivity {
  return session.backgroundPending === true ? "background" : "idle";
}

// status를 반영하고, idle/awaiting로 전이될 때만 notification을 보낸다.
// 같은 상태 반복은 알리지 않는다. idle 종료 알림은 실제 턴 완료(running/awaiting/background -> idle)에서만 보내며,
// dormant -> idle(세션 재개)이나 초기 관측(undefined -> idle)은 턴 완료가 아니므로 제외한다.
export function applyActivity(options: AgentConnectionOptions, sessionId: string, activity: OperationActivity): void {
  const previous = lastActivity.get(sessionId);
  options.status.set(sessionId, activity);
  lastActivity.set(sessionId, activity);
  if (previous === activity) return;
  const t = getT(currentTerminalLocale());
  if (activity === "awaiting") {
    options.notifications.emit({ kind: "agent.attention", operationId: sessionId, message: t("terminal.notifications.agentInputWaitingBody") });
  } else if (activity === "idle" && (previous === "running" || previous === "awaiting" || previous === "background")) {
    options.notifications.emit({ kind: "agent.ended", operationId: sessionId, message: t("terminal.notifications.agentTurnEndedBody") });
  }
}

async function resyncSnapshots(signal: AbortSignal, options: AgentConnectionOptions): Promise<void> {
  const [agentClis, sessions, operationsSnapshot] = await Promise.all([
    fetchAgentState(signal),
    fetchSessions(signal),
    fetchOperationsSnapshot(signal),
  ]);
  hydrateAgentClis(agentClis);
  hydrateSessions(sessions);
  for (const session of sessions) applyActivity(options, session.sessionId, sessionActivity(session));
  // resync 시 이전 agent.streaming orphan 패널을 조용히 제거한다(최선 노력, 실패 무시).
  pruneOrphanStreamingOperations(operationsSnapshot.operations, options);
}

export function pruneOrphanStreamingOperations(operations: readonly OperationNode[], options: AgentConnectionOptions): void {
  for (const op of operations) {
    if (op.pluginId === "terminal" && op.type === "agent.streaming") {
      void options.operations.remove(op.id).catch(() => undefined);
    }
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish);
  });
}
