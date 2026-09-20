import type { GlobalOptionsData } from "@fleet-console/infra";

import type { AgentTerminalSessionInfo } from "./types.js";
import { resolveAgentIdleDormantMinutes } from "../../../settings/host/execution-settings-routes.js";

const AGENT_IDLE_DORMANT_SWEEP_INTERVAL_MS = 60_000;

export interface IdleAgentDormantSweepDeps {
  readonly loadGlobalOptions: () => GlobalOptionsData;
  readonly listTerminalSessions: () => readonly AgentTerminalSessionInfo[];
  readonly getSessionLastActivityAt: (sessionId: string) => number | null;
  readonly hasProviderSessionCapture: (sessionId: string) => boolean;
  readonly terminate: (sessionId: string) => boolean;
  /** 채팅 세션의 마지막 활동 시각. PTY와 같은 단조 시계 위의 값이며, 세션이 없으면 null이다. */
  readonly getChatLastActivityAt: (sessionId: string) => number | null;
  /** 채팅 표면의 휴면 — PTY의 terminate와 같은 자리다. 전이는 호출된 쪽이 끝낸다. */
  readonly sleepChat: (sessionId: string) => void;
  readonly now?: () => number;
}

export interface IdleAgentDormantSweeperDeps extends IdleAgentDormantSweepDeps {
  readonly registerCleanup: (cleanup: () => void) => unknown;
  readonly intervalMs?: number;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
}

export function sweepIdleAgentSessions(deps: IdleAgentDormantSweepDeps): void {
  const minutes = resolveAgentIdleDormantMinutes(deps.loadGlobalOptions());
  if (minutes === null) return;
  const now = (deps.now ?? (() => performance.now()))();
  const thresholdMs = minutes * 60_000;
  for (const session of deps.listTerminalSessions()) {
    // 채팅 표면은 PTY의 status 어휘를 쓰지 않는다 — 인수한 세션은 status가 dormant로 남으므로
    // 문지기는 chatActive다(활동 해석이 두 어댑터를 가르는 것과 같은 판정).
    if (session.chatActive === true) {
      // 도는 턴·사람의 답을 기다리는 질문·살아 있는 백그라운드 작업은 건드리지 않는다.
      // 휴면은 자식을 거두므로, 그 셋 중 하나라도 서 있으면 진행 중인 일을 죽이는 것이 된다.
      if (session.modelActivity === "working") continue;
      if (session.attentionPending === true) continue;
      if (session.backgroundPending === true) continue;
      const chatActivityAt = deps.getChatLastActivityAt(session.sessionId);
      if (chatActivityAt === null || now - chatActivityAt < thresholdMs) continue;
      deps.sleepChat(session.sessionId);
      continue;
    }
    if (session.status !== "registered" && session.status !== "terminal-only") continue;
    // OSC working은 절대 건드리지 않는다.
    if (session.modelActivity === "working") continue;
    // turnState는 OSC가 의견 없을 때(modelActivity 부재)의 폴백만 쓴다.
    // not-working이 확정되면 turn end hook 지연/유실과 무관하게 후속 가드로 진행한다.
    if (session.modelActivity === undefined && session.turnState === "running") continue;
    // 백그라운드 서브에이전트/워크플로우가 남아있는 세션을 dormant로 내리면 진행 중인 작업째 죽는다.
    if (session.backgroundPending === true) continue;
    if (!deps.hasProviderSessionCapture(session.sessionId)) continue;
    const lastActivityAt = deps.getSessionLastActivityAt(session.sessionId);
    if (lastActivityAt === null || now - lastActivityAt < thresholdMs) continue;
    deps.terminate(session.sessionId);
  }
}

export function startIdleAgentDormantSweeper(deps: IdleAgentDormantSweeperDeps): void {
  const intervalMs = deps.intervalMs ?? AGENT_IDLE_DORMANT_SWEEP_INTERVAL_MS;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const timer = setIntervalFn(() => {
    sweepIdleAgentSessions(deps);
  }, intervalMs);
  deps.registerCleanup(() => {
    clearIntervalFn(timer);
  });
}
