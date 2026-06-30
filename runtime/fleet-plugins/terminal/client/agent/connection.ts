import type { OperationNode } from "@fleet-console/sdk/operations";
import type { ClientNotificationsCapability, ClientOperationStatusCapability, ClientOperationsCapability, OperationActivity } from "@fleet-console/sdk/plugin";

import { fetchAgentState, fetchJobs, fetchOperationsSnapshot, fetchSessions, fetchTenants } from "./api.js";
import { isTerminalJobStatus } from "./reduce.js";
import { createSseFrameParser, interpretObserverFrame } from "./sse.js";
import { applyJobsSnapshot, applyObservedEvent, applySessionAttention, applySessionUpdate, applyTenantSnapshot, applyTruncation, getAgentState, hydrateAgentClis, hydrateSessions, sessionJobs, setAgentState } from "./store.js";
import type { SessionInfo } from "./types.js";

interface AgentConnectionOptions {
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
      const interpreted = interpretObserverFrame(frame);
      if (!interpreted) continue;
      if (interpreted.kind === "truncation" && interpreted.truncation) {
        applyTruncation(interpreted.tenantId, interpreted.tenantLabel, interpreted.truncation);
        continue;
      }
      if (interpreted.kind === "session" && interpreted.session) {
        applySessionUpdate(interpreted.session);
        applyActivity(options, interpreted.session.sessionId, sessionActivity(interpreted.session));
        continue;
      }
      if (interpreted.kind === "attention" && interpreted.session) {
        applySessionAttention(interpreted.session, interpreted.reason);
        if (interpreted.reason && interpreted.reason !== "idle_prompt") {
          applyActivity(options, interpreted.session.sessionId, "awaiting");
        }
        continue;
      }
      if (interpreted.event) {
        applyObservedEvent(interpreted.event, interpreted.tenantLabel);
        // 캐리어 job 상태 변화는 세션 activity(턴 종료 + 스트리밍 = running)에 영향을 주므로 재평가한다.
        reevaluateSessionsForTenant(options, interpreted.event.tenantId);
      }
    }
  }
}

function sessionActivity(session: SessionInfo): OperationActivity {
  if (session.status === "dormant") return "dormant";
  if (session.turnState === "running") return "running";
  // 턴이 종료(ended)됐어도 캐리어 스트리밍이 진행 중이면 running을 유지한다.
  if (session.turnState === "ended") return hasActiveCarrierStream(session) ? "running" : "idle";
  return "idle";
}

// 해당 세션에 종료되지 않은(스트리밍 중인) 캐리어 job이 하나라도 있으면 true.
function hasActiveCarrierStream(session: SessionInfo): boolean {
  return sessionJobs(session).some((job) => !isTerminalJobStatus(job.status));
}

// status를 반영하고, idle/awaiting로 전이될 때만 notification을 보낸다.
// 같은 상태 반복은 알리지 않는다. idle 종료 알림은 실제 턴 완료(running/awaiting -> idle)에서만 보내며,
// dormant -> idle(세션 재개)이나 초기 관측(undefined -> idle)은 턴 완료가 아니므로 제외한다.
function applyActivity(options: AgentConnectionOptions, sessionId: string, activity: OperationActivity): void {
  const previous = lastActivity.get(sessionId);
  options.status.set(sessionId, activity);
  lastActivity.set(sessionId, activity);
  if (previous === activity) return;
  if (activity === "awaiting") {
    options.notifications.emit({ kind: "agent.attention", operationId: sessionId, message: "Agent is waiting for input" });
  } else if (activity === "idle" && (previous === "running" || previous === "awaiting")) {
    options.notifications.emit({ kind: "agent.ended", operationId: sessionId, message: "Agent turn ended" });
  }
}

// 특정 테넌트의 캐리어 job 상태가 바뀌면, 그 테넌트에 연결된 세션의 activity를 다시 계산해 반영한다.
// (예: 턴 종료 후 마지막 스트리밍 job이 끝나면 running -> idle로 전이)
function reevaluateSessionsForTenant(options: AgentConnectionOptions, tenantId: string): void {
  const { sessions } = getAgentState();
  for (const session of Object.values(sessions)) {
    if (session.tenantId !== tenantId) continue;
    // attention으로 설정된 awaiting는 transient 신호로 turnState에 반영되지 않는다.
    // 캐리어 job 이벤트 재평가가 이를 running으로 덮어쓰면 입력 대기 표시가 사라지므로 보존한다.
    // (다음 session:updated 프레임이나 turn 전이가 awaiting를 해소한다.)
    if (lastActivity.get(session.sessionId) === "awaiting") continue;
    applyActivity(options, session.sessionId, sessionActivity(session));
  }
}

async function resyncSnapshots(signal: AbortSignal, options: AgentConnectionOptions): Promise<void> {
  const [agentClis, sessions, tenants, jobs, operationsSnapshot] = await Promise.all([
    fetchAgentState(signal),
    fetchSessions(signal),
    fetchTenants(signal),
    fetchJobs(signal),
    fetchOperationsSnapshot(signal),
  ]);
  hydrateAgentClis(agentClis);
  hydrateSessions(sessions);
  applyTenantSnapshot(tenants);
  applyJobsSnapshot(jobs);
  // activity 평가는 job 스냅샷 적용 이후에 한다 — tenantJobs가 비어있으면 hasActiveCarrierStream이
  // 항상 false가 되어, 스트리밍 중인 세션이 재연결 직후 idle로 오판되고 허위 알림이 발생한다.
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
