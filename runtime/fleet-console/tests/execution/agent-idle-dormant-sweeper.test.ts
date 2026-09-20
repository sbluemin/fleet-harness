import { describe, expect, it, vi } from "vitest";

import type { AgentTerminalSessionInfo } from "../../features/execution/host/agent/types.js";
import {
  sweepIdleAgentSessions,
  startIdleAgentDormantSweeper,
} from "../../features/execution/host/agent/agent-idle-dormant-sweeper.js";

describe("idle agent dormant sweeper", () => {
  it("returns immediately when auto-dormant is disabled (null)", () => {
    const terminate = vi.fn();
    const sleepChat = vi.fn();
    sweepIdleAgentSessions({
      ...baseDeps({ terminate, sleepChat }),
      loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: null }),
      listTerminalSessions: () => [liveSession(), chatSession()],
      now: () => 60 * 60_000,
    });
    expect(terminate).not.toHaveBeenCalled();
    expect(sleepChat).not.toHaveBeenCalled();
  });

  it("terminates idle live sessions once the threshold elapses", () => {
    const terminate = vi.fn(() => true);
    sweepIdleAgentSessions({
      ...baseDeps({ terminate }),
      listTerminalSessions: () => [
        liveSession({ sessionId: "idle-registered", status: "registered" }),
        liveSession({ sessionId: "idle-terminal-only", status: "terminal-only" }),
      ],
      now: () => 30 * 60_000,
    });
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(terminate).toHaveBeenCalledWith("idle-registered");
    expect(terminate).toHaveBeenCalledWith("idle-terminal-only");
  });

  // 채팅은 PTY의 status 어휘를 쓰지 않는다(인수한 세션의 status는 dormant로 남는다). 유휴만
  // 접고, 진행 중인 일이 서 있는 세션은 그대로 두는 것이 이 표면의 계약이다.
  it("sleeps an idle chat session but never one that is still working", () => {
    const sleepChat = vi.fn();
    const terminate = vi.fn(() => true);
    sweepIdleAgentSessions({
      ...baseDeps({ terminate, sleepChat }),
      listTerminalSessions: () => [
        chatSession({ sessionId: "idle-chat" }),
        chatSession({ sessionId: "working-chat", modelActivity: "working" }),
        chatSession({ sessionId: "awaiting-chat", attentionPending: true }),
        chatSession({ sessionId: "background-chat", backgroundPending: true }),
      ],
      now: () => 30 * 60_000,
    });
    expect(sleepChat.mock.calls).toEqual([["idle-chat"]]);
    expect(terminate).not.toHaveBeenCalled();
  });
});

function baseDeps(overrides: {
  readonly terminate?: (sessionId: string) => boolean;
  readonly sleepChat?: (sessionId: string) => void;
} = {}) {
  return {
    loadGlobalOptions: () => ({ version: 1, agentIdleDormantMinutes: 30 }) as const,
    listTerminalSessions: (): readonly AgentTerminalSessionInfo[] => [],
    getSessionLastActivityAt: () => 0,
    getChatLastActivityAt: () => 0,
    hasProviderSessionCapture: () => true,
    terminate: overrides.terminate ?? (() => true),
    sleepChat: overrides.sleepChat ?? (() => {}),
  };
}

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

function chatSession(overrides: Partial<AgentTerminalSessionInfo> = {}): AgentTerminalSessionInfo {
  return liveSession({ sessionId: "chat-a", status: "dormant", chatActive: true, ...overrides });
}
