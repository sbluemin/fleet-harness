import { describe, expect, it, vi } from "vitest";

import type { AgentTerminalSessionInfo } from "../server/agent-api/types.js";
import {
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
