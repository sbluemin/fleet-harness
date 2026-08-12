import { describe, expect, it, vi } from "vitest";

import { applyActivity, sessionActivity, type AgentConnectionOptions } from "../client/agent/connection.js";
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
