import type { OperationNode } from "@fleet-console/sdk/operations";
import type { ClientNotificationsCapability, ClientOperationRuntimeCapability, ClientOperationsCapability, OperationActivity, OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { currentTerminalLocale, getT } from "../i18n/index.js";
import { fetchAgentState, fetchOperationsSnapshot, fetchSessions } from "./api.js";
import { createSseFrameParser, interpretAgentSessionFrame } from "./sse.js";
import { applySessionUpdate, hydrateAgentClis, hydrateSessions, setAgentState } from "./store.js";
import type { SessionInfo } from "./types.js";

export interface AgentConnectionOptions {
  readonly operations: ClientOperationsCapability;
  readonly notifications: ClientNotificationsCapability;
  readonly runtime: ClientOperationRuntimeCapability;
  readonly refreshOperations: () => void;
}

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;
// 세션별 직전 보고 activity. idle/awaiting 전이를 감지해 중복 없이 notification을 보내기 위함.
const lastActivity = new Map<string, OperationActivity | "dormant">();
// 채팅이 인수한 Operation의 축도 이제 서버 세션 스냅샷이 진다(chatActive/chatWorking). 그래서
// "채팅 뷰가 열려 있는 동안만 터미널 스냅샷을 막는" 클라이언트 인수 표시는 더 필요하지 않다 —
// 축의 주인이 열려 있다 닫히는 패널이면 패널을 닫는 순간 축이 폴백으로 되돌아 다시 휴면이 된다.

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
      // 스냅샷이 권위로 자리잡은 뒤에야 축을 신뢰할 수 있다고 말한다.
      options.runtime.setHydration("ready");
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      await consumeStream(response.body.getReader(), signal, options);
      if (!signal.aborted) setAgentState({ connection: "connecting", connectionError: null });
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      setAgentState({ connection: "connecting", connectionError: message });
      // 스트림이 끊긴 동안의 상태는 모르는 상태다 — 유휴로 접지 않고 모른다고 말한다.
      options.runtime.setHydration("degraded", message);
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
        applyRuntime(options, interpreted.session.sessionId, sessionRuntime(interpreted.session));
        continue;
      }
      if (interpreted.kind === "attention") {
        applySessionUpdate(interpreted.session);
        // idle_prompt(정상 유휴)는 새 hook matcher에서 제외되지만, 업그레이드 전환기의 in-flight 세션이나
        // 아직 재렌더되지 않은 hooks.json이 옛 matcher로 idle_prompt를 보낼 수 있다. 그 호환성을 위해
        // idle_prompt는 client에서도 명시적으로 드롭한다(awaiting 전이 안 함). 나머지(permission_prompt·
        // elicitation_dialog, 그리고 reason 없는 AskUserQuestion=PreToolUse)는 입력 대기이므로 awaiting로 전이한다.
        if (interpreted.reason !== "idle_prompt") {
          // attention 도 같은 권위 경로를 지난다 — 직행 필자가 남으면 채팅 런타임을 덮어쓴다.
          applyRuntime(options, interpreted.session.sessionId, sessionRuntime({ ...interpreted.session, attentionPending: true }));
        }
      }
    }
  }
}

// 수명주기와 활동은 다른 축이다. dormant는 "PTY가 죽었다"는 수명주기 사실인데, 예전에는 그것이
// 활동 해석의 첫 분기를 차지해 아래 모든 신호를 삼켰다 — Chat Mode가 PTY를 접고 SDK로 같은 세션을
// 이어 돌리는 동안 사이드바가 휴면이라고 말한 원인이다. 이제 실행 표면의 유무를 먼저 묻는다:
// 채팅이 인수한 세션은 PTY가 없어도 live이며, 그 활동은 SDK 턴 경계가 말한다.
//
// 아래 활동 축의 권위 규칙은 종전과 같다. modelActivity(=CLI가 OSC 타이틀로 방송하는 작업 여부)가 running/idle의 권위이고,
// attentionPending(=입력 대기 hook)은 OSC가 유휴와 구분하지 못하는 대기 상태를 담당하므로 그보다 앞선다.
// backgroundPending(=턴 종료·서브에이전트 종료 hook이 실어 오는 살아 있는 백그라운드 작업 목록)은 부모 턴보다 오래 남은 작업을 표시해 false idle을 막지만
// 절대 running으로 주장하지 않는다. turnState는 경쟁 소스가 아니라 OSC 타이틀을 인식하지 못했을 때의 폴백이다 —
// 두 optional 필드가 모두 부재할 때만 도달한다. 미인식 타이틀은 무의견으로 남아야 하며, 그래야 타이틀 어휘가 드리프트해도
// 거짓 idle 대신 hook 기반 동작으로 퇴보한다.
export function sessionRuntime(session: SessionInfo): OperationRuntimeState {
  // 채팅이 인수했으면 PTY의 죽음은 수명주기의 죽음이 아니다. 활동은 SDK 턴 경계가 말하고,
  // 표면 라벨은 호스트가 뜻을 모른 채 표식으로만 그린다.
  if (session.chatActive === true) {
    // 활동 해석은 표면과 무관하다 — 두 어댑터가 같은 필드에 쓰므로 같은 함수가 읽는다.
    // 여기서 갈리는 것은 수명(PTY의 죽음이 수명의 죽음이 아니다)과 표면 표식뿐이다.
    return { lifecycle: "live", activity: sessionActivity(session), surface: CHAT_SURFACE_LABEL };
  }
  if (session.status === "dormant") return { lifecycle: "dormant" };
  return { lifecycle: "live", activity: sessionActivity(session), surface: CLI_SURFACE_LABEL };
}

// 호스트에 넘기는 실행 표면 표식. 뜻을 아는 쪽은 이 플러그인뿐이다.
// 두 표면은 대칭으로 말한다 — 채팅만 표식을 달면 그 표식이 "특이 상태"로 읽히지만, 둘 다 달면
// 사용자가 읽는 것은 "이 Operation이 지금 어느 표면으로 도는가" 하나가 된다.
// 휴면에는 표식이 없다. 어느 표면으로도 돌고 있지 않기 때문이다.
const CHAT_SURFACE_LABEL = "CHAT";
const CLI_SURFACE_LABEL = "CLI";

export function sessionActivity(session: SessionInfo): OperationActivity {
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
export function applyRuntime(options: AgentConnectionOptions, sessionId: string, state: OperationRuntimeState): void {
  const activity: OperationActivity | "dormant" = state.lifecycle === "dormant" ? "dormant" : state.activity;
  const previous = lastActivity.get(sessionId);
  options.runtime.set(sessionId, state);
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
  for (const session of sessions) applyRuntime(options, session.sessionId, sessionRuntime(session));
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
