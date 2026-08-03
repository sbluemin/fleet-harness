import { describe, expect, it, vi } from "vitest";

import type { AgentTerminalSessionInfo } from "../server/agent-api/types.js";
import {
  CARRIER_JOB_FINALIZED_GRACE_MS,
  isCarrierJobActiveForIdle,
  sweepIdleAgentSessions,
  startIdleAgentDormantSweeper,
} from "../server/agent-idle-dormant-sweeper.js";

describe("idle agent dormant sweeper", () => {
  it("returns immediately when auto-dormant is disabled (null)", () => {
    const terminate = vi.fn();
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: null }),
      listTerminalSessions: () => [liveSession()],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      hasActiveCarrierJob: () => false,
      terminate,
      now: () => 60 * 60_000,
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("skips sessions that are working or turn-running without OSC opinion", () => {
    const terminate = vi.fn();
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: 60 }),
      listTerminalSessions: () => [
        liveSession({ sessionId: "working", modelActivity: "working" }),
        liveSession({ sessionId: "running", turnState: "running" }),
      ],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      hasActiveCarrierJob: () => false,
      terminate,
      now: () => 60 * 60_000,
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("skips sessions with pending background subagent work", () => {
    const terminate = vi.fn();
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: 60 }),
      listTerminalSessions: () => [
        liveSession({ sessionId: "background", modelActivity: "not-working", turnState: "ended", backgroundPending: true }),
      ],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      hasActiveCarrierJob: () => false,
      terminate,
      now: () => 60 * 60_000,
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("terminates not-working sessions even when turnState is still running", () => {
    const terminate = vi.fn(() => true);
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: 60 }),
      listTerminalSessions: () => [
        liveSession({
          sessionId: "stale-turn",
          modelActivity: "not-working",
          turnState: "running",
        }),
      ],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      hasActiveCarrierJob: () => false,
      terminate,
      now: () => 60 * 60_000,
    });
    expect(terminate).toHaveBeenCalledWith("stale-turn");
  });

  it("skips when modelActivity is undefined and turnState is running", () => {
    const terminate = vi.fn();
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: 60 }),
      listTerminalSessions: () => [
        liveSession({ sessionId: "fallback-running", turnState: "running" }),
      ],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      hasActiveCarrierJob: () => false,
      terminate,
      now: () => 60 * 60_000,
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("terminates when modelActivity is undefined and turnState is not running", () => {
    const terminate = vi.fn(() => true);
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: 60 }),
      listTerminalSessions: () => [
        liveSession({ sessionId: "no-osc-ended", turnState: "ended" }),
        liveSession({ sessionId: "no-osc-none", turnState: "none" }),
      ],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      hasActiveCarrierJob: () => false,
      terminate,
      now: () => 60 * 60_000,
    });
    expect(terminate).toHaveBeenCalledWith("no-osc-ended");
    expect(terminate).toHaveBeenCalledWith("no-osc-none");
  });

  it("treats non-terminal carrier jobs as active regardless of grace", () => {
    expect(isCarrierJobActiveForIdle({ status: "active", updatedAt: 0 }, 60_000)).toBe(true);
  });

  it("treats recently finalized carrier jobs as active within grace", () => {
    const finalizedAt = 10_000;
    expect(isCarrierJobActiveForIdle(
      { status: "done", updatedAt: finalizedAt },
      finalizedAt + CARRIER_JOB_FINALIZED_GRACE_MS - 1,
    )).toBe(true);
    expect(isCarrierJobActiveForIdle(
      { status: "error", updatedAt: finalizedAt },
      finalizedAt + CARRIER_JOB_FINALIZED_GRACE_MS - 1,
    )).toBe(true);
    expect(isCarrierJobActiveForIdle(
      { status: "aborted", updatedAt: finalizedAt },
      finalizedAt + CARRIER_JOB_FINALIZED_GRACE_MS - 1,
    )).toBe(true);
  });

  it("treats finalized carrier jobs as inactive after grace elapses", () => {
    const finalizedAt = 10_000;
    expect(isCarrierJobActiveForIdle(
      { status: "done", updatedAt: finalizedAt },
      finalizedAt + CARRIER_JOB_FINALIZED_GRACE_MS,
    )).toBe(false);
  });

  it("skips sessions with an active carrier job", () => {
    const terminate = vi.fn();
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: 60 }),
      listTerminalSessions: () => [liveSession({ sessionId: "carrier-live" })],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      hasActiveCarrierJob: (sessionId) => sessionId === "carrier-live",
      terminate,
      now: () => 60 * 60_000,
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("skips sessions whose carrier job finalized inside the grace window", () => {
    const terminate = vi.fn();
    const finalizedAt = 1_000;
    const wallNow = finalizedAt + 250;
    const jobs = [{ status: "done", updatedAt: finalizedAt }];
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: 60 }),
      listTerminalSessions: () => [liveSession({ sessionId: "just-finalized" })],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      hasActiveCarrierJob: () => jobs.some((job) => isCarrierJobActiveForIdle(job, wallNow)),
      terminate,
      now: () => 60 * 60_000,
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("terminates idle sessions after finalize grace when jobs are terminal-only", () => {
    const terminate = vi.fn(() => true);
    const finalizedAt = 1_000;
    const wallNow = finalizedAt + CARRIER_JOB_FINALIZED_GRACE_MS;
    const jobs = [{ status: "done", updatedAt: finalizedAt }];
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: 60 }),
      listTerminalSessions: () => [liveSession({ sessionId: "carrier-done" })],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      hasActiveCarrierJob: () => jobs.some((job) => isCarrierJobActiveForIdle(job, wallNow)),
      terminate,
      now: () => 60 * 60_000,
    });
    expect(terminate).toHaveBeenCalledWith("carrier-done");
  });

  it("skips non-terminal carrier jobs even when updatedAt is old", () => {
    const terminate = vi.fn();
    const jobs = [{ status: "active", updatedAt: 0 }];
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: 60 }),
      listTerminalSessions: () => [liveSession({ sessionId: "carrier-active" })],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      hasActiveCarrierJob: () => jobs.some((job) => isCarrierJobActiveForIdle(job, 60 * 60_000)),
      terminate,
      now: () => 60 * 60_000,
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("keeps terminating jobless idle sessions", () => {
    const terminate = vi.fn(() => true);
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: 60 }),
      listTerminalSessions: () => [liveSession({ sessionId: "no-jobs" })],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      hasActiveCarrierJob: () => false,
      terminate,
      now: () => 60 * 60_000,
    });
    expect(terminate).toHaveBeenCalledWith("no-jobs");
  });

  it("skips sessions without a providerSession capture", () => {
    const terminate = vi.fn();
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: 60 }),
      listTerminalSessions: () => [liveSession()],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => false,
      hasActiveCarrierJob: () => false,
      terminate,
      now: () => 60 * 60_000,
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("skips sessions that have not yet reached the idle threshold", () => {
    const terminate = vi.fn();
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: 60 }),
      listTerminalSessions: () => [liveSession()],
      getSessionLastActivityAt: () => 30 * 60_000,
      hasProviderSessionCapture: () => true,
      hasActiveCarrierJob: () => false,
      terminate,
      now: () => 60 * 60_000,
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("skips dormant/starting/closed/error sessions", () => {
    const terminate = vi.fn();
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1 }),
      listTerminalSessions: () => [
        liveSession({ sessionId: "dormant", status: "dormant" }),
        liveSession({ sessionId: "starting", status: "starting" }),
        liveSession({ sessionId: "closed", status: "closed" }),
        liveSession({ sessionId: "error", status: "error" }),
      ],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      hasActiveCarrierJob: () => false,
      terminate,
      now: () => 60 * 60_000,
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("terminates idle live sessions once the threshold elapses", () => {
    const terminate = vi.fn(() => true);
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: 30 }),
      listTerminalSessions: () => [
        liveSession({ sessionId: "idle-registered", status: "registered" }),
        liveSession({ sessionId: "idle-terminal-only", status: "terminal-only" }),
      ],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      hasActiveCarrierJob: () => false,
      terminate,
      now: () => 30 * 60_000,
    });
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(terminate).toHaveBeenCalledWith("idle-registered");
    expect(terminate).toHaveBeenCalledWith("idle-terminal-only");
  });

  it("uses the default 60-minute threshold when the setting key is absent", () => {
    const terminate = vi.fn(() => true);
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1 }),
      listTerminalSessions: () => [liveSession({ sessionId: "default-idle" })],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      hasActiveCarrierJob: () => false,
      terminate,
      now: () => 59 * 60_000,
    });
    expect(terminate).not.toHaveBeenCalled();
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1 }),
      listTerminalSessions: () => [liveSession({ sessionId: "default-idle" })],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      hasActiveCarrierJob: () => false,
      terminate,
      now: () => 60 * 60_000,
    });
    expect(terminate).toHaveBeenCalledWith("default-idle");
  });

  it("registers an injectable interval and clears it on cleanup", () => {
    const callbacks: Array<() => void> = [];
    const clearIntervalFn = vi.fn();
    const setIntervalFn = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return 42 as unknown as ReturnType<typeof setInterval>;
    });
    const terminate = vi.fn(() => true);
    const cleanups: Array<() => void> = [];
    startIdleAgentDormantSweeper({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: 1 }),
      listTerminalSessions: () => [liveSession({ sessionId: "tick" })],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      hasActiveCarrierJob: () => false,
      terminate,
      now: () => 60_000,
      intervalMs: 1_000,
      setIntervalFn: setIntervalFn as unknown as typeof setInterval,
      clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
      registerCleanup: (cleanup) => { cleanups.push(cleanup); },
    });
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 1_000);
    expect(cleanups).toHaveLength(1);
    callbacks[0]?.();
    expect(terminate).toHaveBeenCalledWith("tick");
    cleanups[0]?.();
    expect(clearIntervalFn).toHaveBeenCalledWith(42);
  });
});

function liveSession(overrides: Partial<AgentTerminalSessionInfo> = {}): AgentTerminalSessionInfo {
  return {
    sessionId: "session-a",
    terminalSessionId: "session-a",
    cwdLabel: "work",
    status: "registered",
    turnState: "ended",
    createdAt: 1,
    theaterId: "theater-a",
    resumeAvailable: true,
    ...overrides,
  };
}
