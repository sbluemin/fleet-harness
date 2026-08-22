import type { GlobalOptionsData } from "@dotobokuri/core-infra";

import type { AgentTerminalSessionInfo } from "./agent-api/types.js";
import { resolveAgentIdleDormantMinutes } from "./settings-routes.js";

const AGENT_IDLE_DORMANT_SWEEP_INTERVAL_MS = 60_000;

export interface IdleAgentDormantSweepDeps {
  readonly loadGlobalOptions: () => GlobalOptionsData;
  readonly listTerminalSessions: () => readonly AgentTerminalSessionInfo[];
  readonly getSessionLastActivityAt: (sessionId: string) => number | null;
  readonly hasProviderSessionCapture: (sessionId: string) => boolean;
  readonly terminate: (sessionId: string) => boolean;
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
