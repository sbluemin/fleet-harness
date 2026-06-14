import { beforeEach, describe, expect, it } from "vitest";

import {
  applyJobsSnapshot,
  applyObservedEvent,
  applySessionUpdate,
  applyTenantSnapshot,
  applyTruncation,
  beginCreateTerminalSession,
  completeAddTheater,
  clearSelectedJob,
  closeShell,
  completeCreateTerminalSession,
  getState,
  hydrateTerminalSessions,
  hydrateTheaters,
  selectJob,
  selectTerminalSession,
  selectedJob,
  sessionJobs,
  setActiveTheater,
  setState,
  theaterSessionOrder,
  theaterSessions,
  toggleShell,
} from "../client/src/store.js";
import type { ObservedEvent, ObservedTenant, TheaterInfo } from "../client/src/types.js";

const TENANT: ObservedTenant = { tenantId: "tenant-1", tenantLabel: "Alpha", createdAt: 1, sessions: 1, theaterId: "theater-a" };
const THEATER_A: TheaterInfo = { id: "theater-a", label: "Alpha", createdAt: "2026-06-13T00:00:00.000Z", lastOpenedAt: "2026-06-13T00:00:00.000Z", hasWiki: true, activeAdmiralCount: 1 };
const THEATER_B: TheaterInfo = { id: "theater-b", label: "Beta", createdAt: "2026-06-13T00:00:00.000Z", lastOpenedAt: "2026-06-13T00:00:01.000Z", hasWiki: false, activeAdmiralCount: 0 };

function makeEvent(id: number, type: string, event: Record<string, unknown>, tenantId = "tenant-1", jobId = "job-1"): ObservedEvent {
  return { id, tenantId, jobId, type, at: 1_000 + id, event: { type, jobId, ...event } };
}

beforeEach(() => {
  setState({
    connection: "connecting",
    connectionError: null,
    tenants: [],
    theaters: [],
    activeTheaterId: null,
    addingTheater: false,
    theaterError: null,
    tenantJobs: {},
    tenantOrder: [],
    sessions: {},
    sessionOrder: [],
    activeTerminalSessionId: null,
    creatingTerminalSession: false,
    terminalSessionError: null,
    timelineOpen: false,
    shellOpen: false,
    selectedJobId: null,
  });
});

describe("store", () => {
  it("applies a tenant snapshot without creating legacy selection state", () => {
    applyTenantSnapshot([TENANT]);

    expect(getState().tenants).toEqual([TENANT]);
    expect(getState().tenantOrder).toEqual(["tenant-1"]);
  });

  it("binds a tenant snapshot to the active terminal session", () => {
    hydrateTheaters([THEATER_A]);
    hydrateTerminalSessions([{ sessionId: "tenant-1", terminalSessionId: "tenant-1", cwdLabel: "alpha", sequence: 1, status: "starting", createdAt: 1, theaterId: "theater-a" }]);
    selectTerminalSession("tenant-1");
    applyTenantSnapshot([{ ...TENANT, terminalSessionId: "tenant-1" }]);

    expect(getState().sessions["tenant-1"]).toMatchObject({ status: "registered", tenantId: "tenant-1" });
    expect(getState().activeTerminalSessionId).toBe("tenant-1");
  });

  it("builds job views from a jobs snapshot and refreshes them across resync", () => {
    hydrateTerminalSessions([{ sessionId: "tenant-1", terminalSessionId: "tenant-1", cwdLabel: "alpha", sequence: 1, status: "terminal-only", createdAt: 1 }]);
    selectTerminalSession("tenant-1");
    applyJobsSnapshot([
      {
        tenantId: "tenant-1",
        tenantLabel: "Alpha",
        truncation: { droppedCount: 0 },
        jobs: [
          { jobId: "job-1", status: "done", updatedAt: 1_001, events: [makeEvent(1, "track:text", { trackId: "t1", text: "a" })] },
          { jobId: "job-2", status: "active", updatedAt: 1_002, events: [] },
        ],
      },
    ]);
    applyJobsSnapshot([
      {
        tenantId: "tenant-1",
        tenantLabel: "Alpha",
        truncation: { droppedCount: 0 },
        jobs: [
          { jobId: "job-1", status: "done", updatedAt: 1_001, events: [] },
          { jobId: "job-2", status: "active", updatedAt: 1_005, events: [] },
        ],
      },
    ]);
    expect(getState().tenantJobs["tenant-1"]?.jobOrder).toEqual(["job-1", "job-2"]);
    expect(sessionJobs(getState(), getState().sessions["tenant-1"]!).map(({ job }) => job.jobId)).toEqual(["job-1", "job-2"]);
  });

  it("applies live events incrementally and reports unknown tenants", () => {
    applyTenantSnapshot([TENANT]);
    const known = applyObservedEvent(makeEvent(1, "track:text", { trackId: "t1", text: "hi" }));
    expect(known.unknownTenant).toBe(false);
    const unknown = applyObservedEvent(makeEvent(2, "track:text", { trackId: "t1", text: "yo" }, "tenant-9", "job-9"));
    expect(unknown.unknownTenant).toBe(true);
    expect(getState().tenantJobs["tenant-1"]?.jobs["job-1"]?.tracks.t1?.text).toBe("hi");
    expect(getState().tenantJobs["tenant-9"]?.jobs["job-9"]).toBeDefined();
    expect(getState().connection).toBe("live");
  });

  it("keeps live jobs scoped to the active terminal session when another tenant streams", () => {
    hydrateTerminalSessions([{ sessionId: "tenant-1", terminalSessionId: "tenant-1", cwdLabel: "alpha", sequence: 1, status: "terminal-only", createdAt: 1 }]);
    selectTerminalSession("tenant-1");
    applyTenantSnapshot([{ ...TENANT, terminalSessionId: "tenant-1" }]);
    applyObservedEvent(makeEvent(1, "track:text", { trackId: "t1", text: "other" }, "tenant-9", "job-9"));
    expect(sessionJobs(getState(), getState().sessions["tenant-1"]!)).toEqual([]);
    applyObservedEvent(makeEvent(2, "track:text", { trackId: "t1", text: "mine" }, "tenant-1", "job-1"));
    expect(sessionJobs(getState(), getState().sessions["tenant-1"]!).map(({ job }) => job.jobId)).toEqual(["job-1"]);
  });

  it("keeps jobs in registration order", () => {
    applyObservedEvent(makeEvent(1, "track:text", { trackId: "t1", text: "x" }, "tenant-1", "job-old"));
    applyObservedEvent(makeEvent(2, "job:finalized", { status: "done", finishedAt: 1_003, summary: "ok" }, "tenant-1", "job-old"));
    applyObservedEvent(makeEvent(3, "track:text", { trackId: "t1", text: "y" }, "tenant-1", "job-live"));
    expect(getState().tenantJobs["tenant-1"]?.jobOrder).toEqual(["job-old", "job-live"]);
  });

  it("records truncation for tenants that only arrive via truncation frames", () => {
    applyTruncation("tenant-2", "Beta", { droppedCount: 4 });
    expect(getState().tenantJobs["tenant-2"]?.truncation.droppedCount).toBe(4);
  });

  it("keeps terminal session selection separate from tenant binding", () => {
    hydrateTerminalSessions([{ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, status: "terminal-only", createdAt: 1 }]);
    applyTenantSnapshot([{ ...TENANT, tenantId: "tenant-a", terminalSessionId: "session-a" }]);
    selectTerminalSession("session-a");

    expect(getState().activeTerminalSessionId).toBe("session-a");
    expect(getState().sessions["session-a"]?.tenantId).toBe("tenant-a");
  });

  it("lists jobs only for the active terminal session", () => {
    hydrateTerminalSessions([
      { sessionId: "tenant-a", terminalSessionId: "tenant-a", cwdLabel: "alpha", sequence: 1, status: "terminal-only", createdAt: 1 },
      { sessionId: "tenant-b", terminalSessionId: "tenant-b", cwdLabel: "beta", sequence: 2, status: "terminal-only", createdAt: 2 },
    ]);
    selectTerminalSession("tenant-a");
    applyJobsSnapshot([
      {
        tenantId: "tenant-a",
        tenantLabel: "Alpha",
        truncation: { droppedCount: 0 },
        jobs: [
          { jobId: "job-a-live", status: "active", updatedAt: 1_004, events: [] },
          { jobId: "job-a-done", status: "done", updatedAt: 1_005, events: [] },
        ],
      },
      {
        tenantId: "tenant-b",
        tenantLabel: "Beta",
        truncation: { droppedCount: 0 },
        jobs: [{ jobId: "job-b-live", status: "active", updatedAt: 1_006, events: [] }],
      },
    ]);

    expect(sessionJobs(getState(), getState().sessions["tenant-a"]!).map(({ job }) => job.jobId)).toEqual(["job-a-live", "job-a-done"]);

    selectTerminalSession("tenant-b");
    expect(sessionJobs(getState(), getState().sessions["tenant-b"]!).map(({ job }) => job.jobId)).toEqual(["job-b-live"]);
  });

  it("tracks operations landing and session creation state", () => {
    expect(getState().activeTerminalSessionId).toBeNull();
    expect(getState().shellOpen).toBe(false);
    beginCreateTerminalSession();
    expect(getState()).toMatchObject({ creatingTerminalSession: true, terminalSessionError: null });

    hydrateTheaters([THEATER_A]);
    completeCreateTerminalSession({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, status: "terminal-only", createdAt: 1, theaterId: "theater-a" });

    expect(getState()).toMatchObject({ activeTerminalSessionId: "session-a", creatingTerminalSession: false });
    expect(getState().sessionOrder).toEqual(["session-a"]);
  });

  it("toggles and closes the free shell overlay", () => {
    expect(getState().shellOpen).toBe(false);

    toggleShell();
    expect(getState().shellOpen).toBe(true);

    closeShell();
    expect(getState().shellOpen).toBe(false);
  });

  it("binds hydrated terminal sessions to tenants without changing the active session", () => {
    hydrateTerminalSessions([{ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, status: "starting", createdAt: 1 }]);
    selectTerminalSession("session-a");
    applyTenantSnapshot([{ ...TENANT, terminalSessionId: "session-a", registrationId: "registration-a" }]);

    expect(getState().sessions["session-a"]).toMatchObject({ status: "registered", tenantId: "tenant-1", registrationId: "registration-a" });
    expect(getState().activeTerminalSessionId).toBe("session-a");
  });

  it("applies terminal session rename updates without losing tenant bindings", () => {
    hydrateTerminalSessions([{ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, status: "starting", createdAt: 1, theaterId: "theater-a" }]);
    applyTenantSnapshot([{ ...TENANT, terminalSessionId: "session-a", registrationId: "registration-a" }]);

    applySessionUpdate({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "terminal-only", createdAt: 1 });
    applyTenantSnapshot([{ ...TENANT, terminalSessionId: "session-a", registrationId: "registration-a" }]);

    expect(getState().sessions["session-a"]).toMatchObject({ label: "Bridge", tenantId: "tenant-1", registrationId: "registration-a", theaterId: "theater-a" });
  });

  it("selects a job into the centered overlay and toggles it closed", () => {
    hydrateTerminalSessions([{ sessionId: "tenant-1", terminalSessionId: "tenant-1", cwdLabel: "alpha", sequence: 1, status: "terminal-only", createdAt: 1 }]);
    selectTerminalSession("tenant-1");
    applyJobsSnapshot([
      {
        tenantId: "tenant-1",
        tenantLabel: "Alpha",
        truncation: { droppedCount: 0 },
        jobs: [
          { jobId: "job-1", status: "active", updatedAt: 1_001, events: [makeEvent(1, "track:text", { trackId: "t1", text: "a" })] },
          { jobId: "job-2", status: "active", updatedAt: 1_002, events: [makeEvent(2, "track:text", { trackId: "t1", text: "b" }, "tenant-1", "job-2")] },
        ],
      },
    ]);

    selectJob("job-2");
    expect(getState().selectedJobId).toBe("job-2");
    expect(selectedJob(getState())?.jobId).toBe("job-2");

    selectJob("job-2");
    expect(getState().selectedJobId).toBeNull();

    selectJob("job-1");
    expect(getState().selectedJobId).toBe("job-1");
    clearSelectedJob();
    expect(getState().selectedJobId).toBeNull();
  });

  it("does not resolve overlay jobs outside the active terminal session", () => {
    hydrateTerminalSessions([
      { sessionId: "tenant-a", terminalSessionId: "tenant-a", cwdLabel: "alpha", sequence: 1, status: "terminal-only", createdAt: 1 },
      { sessionId: "tenant-b", terminalSessionId: "tenant-b", cwdLabel: "beta", sequence: 2, status: "terminal-only", createdAt: 2 },
    ]);
    selectTerminalSession("tenant-a");
    applyJobsSnapshot([
      {
        tenantId: "tenant-a",
        tenantLabel: "Alpha",
        truncation: { droppedCount: 0 },
        jobs: [{ jobId: "job-a", status: "active", updatedAt: 1_001, events: [] }],
      },
      {
        tenantId: "tenant-b",
        tenantLabel: "Beta",
        truncation: { droppedCount: 0 },
        jobs: [{ jobId: "job-b", status: "active", updatedAt: 1_002, events: [] }],
      },
    ]);

    selectJob("job-b");
    expect(selectedJob(getState())).toBeNull();
  });

  it("clears selected overlay job when switching terminal sessions", () => {
    hydrateTerminalSessions([
      { sessionId: "tenant-a", terminalSessionId: "tenant-a", cwdLabel: "alpha", sequence: 1, status: "terminal-only", createdAt: 1 },
      { sessionId: "tenant-b", terminalSessionId: "tenant-b", cwdLabel: "beta", sequence: 2, status: "terminal-only", createdAt: 2 },
    ]);
    selectTerminalSession("tenant-a");
    applyJobsSnapshot([
      {
        tenantId: "tenant-a",
        tenantLabel: "Alpha",
        truncation: { droppedCount: 0 },
        jobs: [{ jobId: "job-a", status: "active", updatedAt: 1_001, events: [] }],
      },
      {
        tenantId: "tenant-b",
        tenantLabel: "Beta",
        truncation: { droppedCount: 0 },
        jobs: [{ jobId: "job-b", status: "active", updatedAt: 1_002, events: [] }],
      },
    ]);

    selectJob("job-a");
    expect(getState().selectedJobId).toBe("job-a");

    selectTerminalSession("tenant-b");
    expect(getState().selectedJobId).toBeNull();
  });

  it("clears the selected overlay job when a newly created session becomes active", () => {
    hydrateTheaters([THEATER_A]);
    hydrateTerminalSessions([{ sessionId: "tenant-1", terminalSessionId: "tenant-1", cwdLabel: "alpha", sequence: 1, status: "terminal-only", createdAt: 1, theaterId: "theater-a" }]);
    selectTerminalSession("tenant-1");
    applyJobsSnapshot([
      {
        tenantId: "tenant-1",
        tenantLabel: "Alpha",
        truncation: { droppedCount: 0 },
        jobs: [{ jobId: "job-1", status: "active", updatedAt: 1_001, events: [] }],
      },
    ]);
    selectJob("job-1");
    expect(getState().selectedJobId).toBe("job-1");

    completeCreateTerminalSession({ sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, status: "terminal-only", createdAt: 2, theaterId: "theater-a" });
    expect(getState().activeTerminalSessionId).toBe("session-b");
    expect(getState().selectedJobId).toBeNull();
  });

  it("hydrates Theaters and keeps hasWiki while choosing the active Theater", () => {
    hydrateTheaters([THEATER_A, THEATER_B]);

    expect(getState().activeTheaterId).toBe("theater-a");
    expect(getState().theaters.map((theater) => theater.hasWiki)).toEqual([true, false]);

    setActiveTheater("theater-b");
    hydrateTheaters([THEATER_A, THEATER_B]);

    expect(getState().activeTheaterId).toBe("theater-b");
  });

  it("activates newly added Theaters and preserves hasWiki", () => {
    hydrateTheaters([THEATER_A]);
    completeAddTheater(THEATER_B);

    expect(getState().activeTheaterId).toBe("theater-b");
    expect(getState().theaters[0]).toMatchObject({ id: "theater-b", hasWiki: false });
  });

  it("filters terminal sessions to the active Theater", () => {
    hydrateTheaters([THEATER_A, THEATER_B]);
    hydrateTerminalSessions([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, status: "terminal-only", createdAt: 1, theaterId: "theater-a" },
      { sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, status: "terminal-only", createdAt: 2, theaterId: "theater-b" },
    ]);

    expect(theaterSessionOrder(getState())).toEqual(["session-a"]);
    expect(theaterSessions(getState()).map((session) => session.sessionId)).toEqual(["session-a"]);

    setActiveTheater("theater-b");
    expect(theaterSessionOrder(getState())).toEqual(["session-b"]);
    expect(getState().activeTerminalSessionId).toBe("session-b");
  });

  it("preserves theaterId across tenant snapshots and hides jobs from other Theaters", () => {
    hydrateTheaters([THEATER_A, THEATER_B]);
    hydrateTerminalSessions([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, status: "terminal-only", createdAt: 1, theaterId: "theater-a" },
      { sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, status: "terminal-only", createdAt: 2, theaterId: "theater-b" },
    ]);
    applyTenantSnapshot([
      { ...TENANT, tenantId: "tenant-a", terminalSessionId: "session-a", theaterId: "theater-a" },
      { ...TENANT, tenantId: "tenant-b", terminalSessionId: "session-b", theaterId: "theater-b" },
    ]);
    applyJobsSnapshot([
      { tenantId: "tenant-a", tenantLabel: "Alpha", truncation: { droppedCount: 0 }, jobs: [{ jobId: "job-a", status: "active", updatedAt: 1, events: [] }] },
      { tenantId: "tenant-b", tenantLabel: "Beta", truncation: { droppedCount: 0 }, jobs: [{ jobId: "job-b", status: "active", updatedAt: 2, events: [] }] },
    ]);

    selectJob("job-b");

    expect(getState().sessions["session-a"]?.theaterId).toBe("theater-a");
    expect(getState().sessions["session-b"]?.theaterId).toBe("theater-b");
    expect(selectedJob(getState())).toBeNull();
  });

  it("retains the most recent jobs in registration order once the per-tenant limit is exceeded", () => {
    const total = 205;
    for (let index = 0; index < total; index += 1) {
      applyObservedEvent(makeEvent(index + 1, "track:text", { trackId: "t1", text: "x" }, "tenant-1", `job-${index}`));
    }
    const tenant = getState().tenantJobs["tenant-1"]!;
    // 등록순(오래된→최신)은 유지하되 보존은 최신 200개여야 한다.
    expect(tenant.jobOrder).toHaveLength(200);
    expect(tenant.jobOrder[0]).toBe("job-5");
    expect(tenant.jobOrder[199]).toBe("job-204");
    // 가장 오래된 Job은 떨어져 나가고, 최신 Job은 조회 가능해야 한다.
    expect(tenant.jobs["job-0"]).toBeUndefined();
    expect(tenant.jobs["job-204"]).toBeDefined();
  });
});
