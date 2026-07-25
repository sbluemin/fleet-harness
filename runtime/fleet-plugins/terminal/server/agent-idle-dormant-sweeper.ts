import type { GlobalOptionsData } from "@dotobokuri/core-infra";

import type { AgentTerminalSessionInfo } from "./agent-api/types.js";
import { resolveAgentIdleDormantMinutes } from "./settings-routes.js";

export const AGENT_IDLE_DORMANT_SWEEP_INTERVAL_MS = 60_000;

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
    if (session.modelActivity === "working") continue;
    if (session.turnState === "running") continue;
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
