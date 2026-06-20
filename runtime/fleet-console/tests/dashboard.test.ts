import { describe, expect, it } from "vitest";

import { buildBridgeView, collectTheaterReadiness, summarizeOperationsReadiness } from "../client/src/dashboard.js";
import type { ConsoleState, JobView } from "../client/src/types.js";

const BASE_STATE: ConsoleState = {
  operationNotifications: {},
  notificationPreferences: { globalMute: false, dnd: false, mutedTheaterIds: {} },
  connection: "live",
  connectionError: null,
  activeTheme: "maritime",
  terminalRenderer: "webgl",
  version: "1.8.0",
  updateAvailable: false,
  latestVersion: null,
  tenants: [],
  theaters: [],
  agentClis: [],
  activeTheaterId: null,
  addingTheater: false,
  theaterError: null,
  sessions: {},
  sessionOrder: [],
  activeTerminalSessionId: null,
  operationsViewActive: false,
  creatingTerminalSession: false,
  terminalSessionError: null,
  tenantJobs: {},
  tenantOrder: [],
  timelineOpen: false,
  shellOpen: false,
  operationSearchOpen: false,
  shortcutsOpen: false,
  whatsNewOpen: false,
  onboardingOpen: false,
  bootstrapped: false,
  terminalSessionsHydrated: false,
  pendingOperationFocus: null,
  selectedJobId: null,
  expandedSessionIds: [],
};

describe("dashboard bridge derivation", () => {
  it("summarizes the active Theater without raw path fields", () => {
    const state: ConsoleState = {
      ...BASE_STATE,
      theaters: [
        { id: "theater-a", label: "Alpha", createdAt: "2026-06-13T00:00:00.000Z", lastOpenedAt: "2026-06-13T00:00:02.000Z", hasWiki: true, activeAdmiralCount: 1 },
      ],
      activeTheaterId: "theater-a",
      tenants: [
        { tenantId: "tenant-a", tenantLabel: "Alpha CLI", createdAt: 1_000, sessions: 1, status: "live", theaterId: "theater-a", terminalSessionId: "session-a" },
      ],
      sessions: {
        "session-a": { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, status: "registered", turnState: "none", createdAt: 1_500, theaterId: "theater-a", tenantId: "tenant-a", resumeAvailable: false },
      },
      sessionOrder: ["session-a"],
      activeTerminalSessionId: "session-a",
      tenantJobs: {
        "tenant-a": {
          tenantId: "tenant-a",
          tenantLabel: "Alpha CLI",
          jobOrder: ["job-live", "job-done", "job-error"],
          jobs: {
            "job-live": makeJob("job-live", "active", 2_000),
            "job-done": makeJob("job-done", "done", 2_500),
            "job-error": makeJob("job-error", "error", 3_000),
          },
          truncation: { droppedCount: 0 },
        },
      },
      tenantOrder: ["tenant-a"],
    };

    const view = buildBridgeView(state);

    expect(view.activeTheater).toMatchObject({
      id: "theater-a",
      label: "Alpha",
      hasWiki: true,
      activeAdmiralCount: 1,
      terminalSessionCount: 1,
      registeredTenantCount: 1,
      lastActivityAt: Date.parse("2026-06-13T00:00:02.000Z"),
    });
    expect(view.readiness).toMatchObject({
      activeSessionLabel: "#1 Operation",
      liveJobCount: 1,
      completedJobCount: 1,
      failedJobCount: 1,
      emptyState: null,
    });
    expect(JSON.stringify(view)).not.toContain("/repo");
  });

  it("reports Operations empty states in Wave 0 order", () => {
    expect(summarizeOperationsReadiness(BASE_STATE, null).emptyState).toBe("no-theaters");

    const noSessions: ConsoleState = {
      ...BASE_STATE,
      theaters: [{ id: "theater-a", label: "Alpha", createdAt: "2026-06-13T00:00:00.000Z", lastOpenedAt: "2026-06-13T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 0 }],
      activeTheaterId: "theater-a",
    };
    expect(summarizeOperationsReadiness(noSessions, "theater-a").emptyState).toBe("no-sessions");

    const noJobs: ConsoleState = {
      ...noSessions,
      sessions: {
        "session-a": { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, status: "terminal-only", turnState: "none", createdAt: 1_000, theaterId: "theater-a", resumeAvailable: false },
      },
      sessionOrder: ["session-a"],
    };
    expect(summarizeOperationsReadiness(noJobs, "theater-a").emptyState).toBe("no-jobs");
  });

  it("builds compact Theater capability rows", () => {
    const state: ConsoleState = {
      ...BASE_STATE,
      theaters: [
        { id: "theater-a", label: "Alpha", createdAt: "2026-06-13T00:00:00.000Z", lastOpenedAt: "2026-06-13T00:00:00.000Z", hasWiki: true, activeAdmiralCount: 1 },
        { id: "theater-b", label: "Beta", createdAt: "2026-06-13T00:00:00.000Z", lastOpenedAt: "2026-06-13T00:00:01.000Z", hasWiki: false, activeAdmiralCount: 0 },
      ],
      activeTheaterId: "theater-b",
      tenants: [{ tenantId: "tenant-b", tenantLabel: "Beta CLI", createdAt: 2_000, sessions: 1, status: "live", theaterId: "theater-b" }],
      tenantJobs: {
        "tenant-b": {
          tenantId: "tenant-b",
          jobOrder: ["job-live"],
          jobs: { "job-live": makeJob("job-live", "active", 3_000) },
          truncation: { droppedCount: 0 },
        },
      },
    };

    expect(collectTheaterReadiness(state)).toEqual([
      expect.objectContaining({ id: "theater-a", active: false, hasWiki: true, liveJobCount: 0 }),
      expect.objectContaining({ id: "theater-b", active: true, hasWiki: false, liveJobCount: 1, lastActivityAt: Date.parse("2026-06-13T00:00:01.000Z") }),
    ]);
  });
});

function makeJob(jobId: string, status: string, updatedAt: number): JobView {
  return {
    jobId,
    tenantId: "tenant-a",
    status,
    updatedAt,
    trackOrder: [],
    tracks: {},
    lastEventId: 0,
    recentEvents: [],
  };
}
