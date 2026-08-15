import { describe, expect, it, vi } from "vitest";

import { applyActivity, claimChatActivityAxis, releaseChatActivityAxis, sessionActivity, type AgentConnectionOptions } from "../client/agent/connection.js";
import { extractStatusDetail } from "../client/shared/status-detail.js";
import { assertSessionInfo } from "../client/agent/api.js";
import type { SessionInfo } from "../client/agent/types.js";

describe("Agent connection activity state machine", () => {
  it("validates and maps additive activity facts from session DTOs", () => {
    expect(assertSessionInfo({
      sessionId: "dto-session",
      cwdLabel: "project",
      status: "registered",
      createdAt: 1_000,
      modelActivity: "working",
      attentionPending: true,
    }, 200)).toMatchObject({
      modelActivity: "working",
      attentionPending: true,
    });
    expect(assertSessionInfo({
      sessionId: "legacy-session",
      cwdLabel: "project",
      status: "registered",
      createdAt: 1_000,
      modelActivity: "unexpected",
      attentionPending: "yes",
      backgroundPending: "yes",
    }, 200)).toMatchObject({
      modelActivity: undefined,
      attentionPending: undefined,
      backgroundPending: undefined,
    });
    expect(assertSessionInfo({
      sessionId: "background-session",
      cwdLabel: "project",
      status: "registered",
      createdAt: 1_000,
      backgroundPending: true,
    }, 200)).toMatchObject({ backgroundPending: true });
  });

  it("composes attention, working, not-working, dormant, and legacy turn state in fixed priority order", () => {
    expect(sessionActivity(makeSession({ status: "dormant", attentionPending: true, modelActivity: "working" }))).toBe("dormant");
    expect(sessionActivity(makeSession({ attentionPending: true, modelActivity: "working" }))).toBe("awaiting");
    expect(sessionActivity(makeSession({ modelActivity: "working", turnState: "ended" }))).toBe("running");
    expect(sessionActivity(makeSession({ modelActivity: "not-working", turnState: "running" }))).toBe("idle");
    expect(sessionActivity(makeSession({ turnState: "running" }))).toBe("running");
    expect(sessionActivity(makeSession({ turnState: "ended" }))).toBe("idle");
  });

  it("maps background-pending ended and not-working sessions to background", () => {
    expect(sessionActivity(makeSession({ backgroundPending: true, turnState: "ended" }))).toBe("background");
    expect(sessionActivity(makeSession({ backgroundPending: true, modelActivity: "not-working" }))).toBe("background");
  });

  it("keeps background-pending working sessions running while the turn is still in flight", () => {
    expect(sessionActivity(makeSession({ backgroundPending: true, modelActivity: "working" }))).toBe("running");
    expect(sessionActivity(makeSession({ backgroundPending: true, modelActivity: "working", turnState: "running" }))).toBe("running");
  });

  // 턴이 끝난 뒤에도 스피너는 돈다 — 백그라운드 서브에이전트·워크플로우가 남아 있기 때문이다. 그 구간의
  // "작업 중"은 호스트의 것이 아니므로 백그라운드로 읽어야 한다. 턴 경계가 유일한 구분자다.
  it("reads a spinning title after turn end as background work, not a running turn", () => {
    expect(sessionActivity(makeSession({ backgroundPending: true, modelActivity: "working", turnState: "ended" }))).toBe("background");
    expect(sessionActivity(makeSession({ attentionPending: true, backgroundPending: true, modelActivity: "working", turnState: "ended" }))).toBe("awaiting");
  });

  it("does not notify when entering background and notifies when it returns idle", () => {
    const { options, notifications } = createOptions();
    const sessionId = "background-transition";

    applyActivity(options, sessionId, "background");
    applyActivity(options, sessionId, "idle");

    expect(notifications.mock.calls.map((call) => call[0].kind)).toEqual(["agent.ended"]);
  });

  it("moves awaiting to running and to idle without duplicate notifications", () => {
    const { options, statusSet, notifications } = createOptions();
    const sessionId = "activity-transitions";

    applyActivity(options, sessionId, "awaiting");
    applyActivity(options, sessionId, "awaiting");
    applyActivity(options, sessionId, "running");
    applyActivity(options, sessionId, "idle");
    applyActivity(options, sessionId, "idle");

    expect(statusSet.mock.calls.map((call) => call[1])).toEqual(["awaiting", "awaiting", "running", "idle", "idle"]);
    expect(notifications.mock.calls.map((call) => call[0].kind)).toEqual(["agent.attention", "agent.ended"]);
  });

  it("sanitizes and caps the latest non-empty output line", () => {
    expect(extractStatusDetail("first\n[31m latest   line [0m\n")).toBe("latest line");
    expect(extractStatusDetail(" \n\t ")).toBeNull();
    expect(extractStatusDetail("x".repeat(180))).toHaveLength(120);
  });

});

describe("Chat Mode activity axis ownership", () => {
  // Chat Mode 전환은 PTY를 접지만 터미널 세션 레코드는 dormant로 남아 스냅샷에 계속 실린다.
  // 채팅 스트림이 축을 인수하지 않으면 resync가 매 주기마다 진행 중인 턴을 휴면으로 덮어쓴다.
  it("stops terminal snapshots from claiming an Operation the chat stream owns", () => {
    const { options, statusSet } = createOptions();
    applyActivity(options, "op-chat", "idle");
    expect(statusSet).toHaveBeenCalledWith("op-chat", "idle");

    statusSet.mockClear();
    claimChatActivityAxis("op-chat");
    applyActivity(options, "op-chat", "dormant");
    applyActivity(options, "op-chat", "idle");
    expect(statusSet).not.toHaveBeenCalled();

    // 다른 Operation은 영향을 받지 않는다 — 주장은 id 단위다.
    applyActivity(options, "op-terminal", "running");
    expect(statusSet).toHaveBeenCalledExactlyOnceWith("op-terminal", "running");
  });

  it("hands the axis back on release so the next frame reports the real state", () => {
    const { options, statusSet } = createOptions();
    claimChatActivityAxis("op-chat");
    releaseChatActivityAxis("op-chat");
    applyActivity(options, "op-chat", "dormant");
    expect(statusSet).toHaveBeenCalledWith("op-chat", "dormant");
  });

  it("forgets the last reported activity on release so a repeat is not swallowed as a no-change", () => {
    const { notifications, options } = createOptions();
    applyActivity(options, "op-chat", "running");
    applyActivity(options, "op-chat", "idle");
    expect(notifications).toHaveBeenCalledTimes(1);

    notifications.mockClear();
    claimChatActivityAxis("op-chat");
    releaseChatActivityAxis("op-chat");
    // 되돌려받은 축은 이전 관측이 없는 상태다. running -> idle을 다시 관측하면 턴 완료 알림도
    // 다시 나가야 한다 — lastActivity를 남겨 두면 두 번째 턴의 종료가 조용히 삼켜진다.
    applyActivity(options, "op-chat", "running");
    applyActivity(options, "op-chat", "idle");
    expect(notifications).toHaveBeenCalledTimes(1);
  });
});

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "session-a",
    terminalSessionId: "session-a",
    cwdLabel: "project",
    status: "registered",
    turnState: "none",
    createdAt: 1_000,
    resumeAvailable: false,
    ...overrides,
  };
}

function createOptions() {
  const statusSet = vi.fn();
  const notifications = vi.fn();
  const options = {
    status: { set: statusSet },
    notifications: { emit: notifications },
    operations: {},
    refreshOperations: vi.fn(),
  } as unknown as AgentConnectionOptions;
  return { notifications, options, statusSet };
}
