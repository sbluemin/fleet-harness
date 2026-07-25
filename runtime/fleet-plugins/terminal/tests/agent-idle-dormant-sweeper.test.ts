import { describe, expect, it, vi } from "vitest";

import type { AgentTerminalSessionInfo } from "../server/agent-api/types.js";
import { sweepIdleAgentSessions, startIdleAgentDormantSweeper } from "../server/agent-idle-dormant-sweeper.js";

describe("idle agent dormant sweeper", () => {
  it("returns immediately when auto-dormant is disabled (null)", () => {
    const terminate = vi.fn();
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: null }),
      listTerminalSessions: () => [liveSession()],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      terminate,
      now: () => 60 * 60_000,
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("skips sessions that are working or turn-running", () => {
    const terminate = vi.fn();
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: 60 }),
      listTerminalSessions: () => [
        liveSession({ sessionId: "working", modelActivity: "working" }),
        liveSession({ sessionId: "running", turnState: "running" }),
      ],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
      terminate,
      now: () => 60 * 60_000,
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("skips sessions without a providerSession capture", () => {
    const terminate = vi.fn();
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: 60 }),
      listTerminalSessions: () => [liveSession()],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => false,
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
      terminate,
      now: () => 59 * 60_000,
    });
    expect(terminate).not.toHaveBeenCalled();
    sweepIdleAgentSessions({
      loadGlobalOptions: () => ({ version: 1 }),
      listTerminalSessions: () => [liveSession({ sessionId: "default-idle" })],
      getSessionLastActivityAt: () => 0,
      hasProviderSessionCapture: () => true,
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
