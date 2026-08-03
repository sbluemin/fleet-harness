import { describe, expect, it, vi } from "vitest";

import { applyActivity, reevaluateSessionsForTenant, sessionActivity, type AgentConnectionOptions } from "../client/agent/connection.js";
import { extractStatusDetail } from "../client/shared/status-detail.js";
import { assertSessionInfo } from "../client/agent/api.js";
import { applyJobsSnapshot, hydrateSessions } from "../client/agent/store.js";
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
    }, 200)).toMatchObject({
      modelActivity: undefined,
      attentionPending: undefined,
    });
  });

  it("composes attention, working, not-working, dormant, and legacy turn state in fixed priority order", () => {
    expect(sessionActivity(makeSession({ status: "dormant", attentionPending: true, modelActivity: "working" }))).toBe("dormant");
    expect(sessionActivity(makeSession({ attentionPending: true, modelActivity: "working" }))).toBe("awaiting");
    expect(sessionActivity(makeSession({ modelActivity: "working", turnState: "ended" }))).toBe("running");
    expect(sessionActivity(makeSession({ modelActivity: "not-working", turnState: "running" }))).toBe("idle");
    expect(sessionActivity(makeSession({ turnState: "running" }))).toBe("running");
    expect(sessionActivity(makeSession({ turnState: "ended" }))).toBe("idle");
  });

  it("keeps not-working sessions running while a Carrier stream is active", () => {
    const session = makeSession({ sessionId: "carrier-active", tenantId: "tenant-carrier", modelActivity: "not-working" });
    applyJobsSnapshot([{
      tenantId: "tenant-carrier",
      jobs: [{ jobId: "job-a", status: "active", updatedAt: 1_000, events: [] }],
    }]);

    expect(sessionActivity(session)).toBe("running");
  });

  it("moves awaiting to running on working and to idle on not-working without duplicate notifications", () => {
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

  it("does not let Carrier job reevaluation overwrite awaiting", () => {
    const { options, statusSet } = createOptions();
    const session = makeSession({ sessionId: "awaiting-carrier", tenantId: "tenant-awaiting", turnState: "running" });
    hydrateSessions([session]);
    applyJobsSnapshot([{
      tenantId: "tenant-awaiting",
      jobs: [{ jobId: "job-a", status: "active", updatedAt: 1_000, events: [] }],
    }]);
    applyActivity(options, session.sessionId, "awaiting");

    reevaluateSessionsForTenant(options, "tenant-awaiting");

    expect(statusSet).toHaveBeenCalledTimes(1);
    expect(statusSet).toHaveBeenLastCalledWith(session.sessionId, "awaiting");
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
