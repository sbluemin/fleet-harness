import type { GlobalOptionsData } from "@dotobokuri/core-infra";

import type { AgentTerminalSessionInfo } from "./agent-api/types.js";
import { resolveAgentIdleDormantMinutes } from "./settings-routes.js";

export const AGENT_IDLE_DORMANT_SWEEP_INTERVAL_MS = 60_000;

/** 클라이언트 isTerminalJobStatus와 동일 어휘 — 이 집합 밖은 활성(non-terminal) job이다. */
const TERMINAL_CARRIER_JOB_STATUSES = new Set(["done", "error", "aborted"]);

export interface IdleAgentDormantSweepDeps {
  readonly loadGlobalOptions: () => GlobalOptionsData;
  readonly listTerminalSessions: () => readonly AgentTerminalSessionInfo[];
  readonly getSessionLastActivityAt: (sessionId: string) => number | null;
  readonly hasProviderSessionCapture: (sessionId: string) => boolean;
  /** 세션에 종료되지 않은 carrier job이 있으면 true(주입). */
  readonly hasActiveCarrierJob: (sessionId: string) => boolean;
  readonly terminate: (sessionId: string) => boolean;
  readonly now?: () => number;
}

export interface IdleAgentDormantSweeperDeps extends IdleAgentDormantSweepDeps {
  readonly registerCleanup: (cleanup: () => void) => unknown;
  readonly intervalMs?: number;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
}

export function isTerminalCarrierJobStatus(status: string): boolean {
  return TERMINAL_CARRIER_JOB_STATUSES.has(status);
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
    // detached carrier job이 돌면 reminder 주입용 live PTY를 유지해야 한다.
    if (deps.hasActiveCarrierJob(session.sessionId)) continue;
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
