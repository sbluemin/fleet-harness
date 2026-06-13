import { beforeEach, describe, expect, it } from "vitest";

import {
  activeSessionActiveJobs,
  applyJobsSnapshot,
  applyObservedEvent,
  applyTenantSnapshot,
  applyTruncation,
  backToCoverList,
  beginCreateTerminalSession,
  completeCreateTerminalSession,
  getState,
  hydrateTerminalSessions,
  selectCoverJob,
  selectTerminalSession,
  selectedCoverJob,
  setState,
  toggleCover,
} from "../client/src/store.js";
import type { ObservedEvent, ObservedTenant } from "../client/src/types.js";

const TENANT: ObservedTenant = { tenantId: "tenant-1", tenantLabel: "Alpha", cwd: "/repo/alpha", createdAt: 1, sessions: 1 };

function makeEvent(id: number, type: string, event: Record<string, unknown>, tenantId = "tenant-1", jobId = "job-1"): ObservedEvent {
  return { id, tenantId, jobId, type, at: 1_000 + id, event: { type, jobId, ...event } };
}

beforeEach(() => {
  setState({
    connection: "connecting",
    connectionError: null,
    tenants: [],
    tenantJobs: {},
    tenantOrder: [],
    sessions: {},
    sessionOrder: [],
    activeTerminalSessionId: null,
    creatingTerminalSession: false,
    terminalSessionError: null,
    timelineOpen: false,
    coverOpen: false,
    coverDepth: "list",
    coverSelectedJobId: null,
  });
});

describe("store", () => {
  it("applies a tenant snapshot without creating legacy selection state", () => {
    applyTenantSnapshot([TENANT]);

    expect(getState().tenants).toEqual([TENANT]);
    expect(getState().tenantOrder).toEqual(["tenant-1"]);
  });

  it("binds a tenant snapshot to the active terminal session", () => {
    hydrateTerminalSessions([{ sessionId: "tenant-1", terminalSessionId: "tenant-1", cwdLabel: "alpha", status: "starting", createdAt: 1 }]);
    selectTerminalSession("tenant-1");
    applyTenantSnapshot([{ ...TENANT, terminalSessionId: "tenant-1" }]);

    expect(getState().sessions["tenant-1"]).toMatchObject({ status: "registered", tenantId: "tenant-1" });
    expect(getState().activeTerminalSessionId).toBe("tenant-1");
  });

  it("builds job views from a jobs snapshot and refreshes them across resync", () => {
    hydrateTerminalSessions([{ sessionId: "tenant-1", terminalSessionId: "tenant-1", cwdLabel: "alpha", status: "terminal-only", createdAt: 1 }]);
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
    expect(getState().tenantJobs["tenant-1"]?.jobOrder).toEqual(["job-2", "job-1"]);
    expect(activeSessionActiveJobs(getState()).map(({ job }) => job.jobId)).toEqual(["job-2"]);
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
    hydrateTerminalSessions([{ sessionId: "tenant-1", terminalSessionId: "tenant-1", cwdLabel: "alpha", status: "terminal-only", createdAt: 1 }]);
    selectTerminalSession("tenant-1");
    applyTenantSnapshot([{ ...TENANT, terminalSessionId: "tenant-1" }]);
    applyObservedEvent(makeEvent(1, "track:text", { trackId: "t1", text: "other" }, "tenant-9", "job-9"));
    expect(activeSessionActiveJobs(getState())).toEqual([]);
    applyObservedEvent(makeEvent(2, "track:text", { trackId: "t1", text: "mine" }, "tenant-1", "job-1"));
    expect(activeSessionActiveJobs(getState()).map(({ job }) => job.jobId)).toEqual(["job-1"]);
  });

  it("keeps active jobs ahead of finished jobs in the rail order", () => {
    applyObservedEvent(makeEvent(1, "track:text", { trackId: "t1", text: "x" }, "tenant-1", "job-old"));
    applyObservedEvent(makeEvent(2, "job:finalized", { status: "done", finishedAt: 1_003, summary: "ok" }, "tenant-1", "job-old"));
    applyObservedEvent(makeEvent(3, "track:text", { trackId: "t1", text: "y" }, "tenant-1", "job-live"));
    expect(getState().tenantJobs["tenant-1"]?.jobOrder[0]).toBe("job-live");
  });

  it("records truncation for tenants that only arrive via truncation frames", () => {
    applyTruncation("tenant-2", "Beta", { droppedCount: 4 });
    expect(getState().tenantJobs["tenant-2"]?.truncation.droppedCount).toBe(4);
  });

  it("keeps terminal session selection separate from tenant binding", () => {
    hydrateTerminalSessions([{ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", status: "terminal-only", createdAt: 1 }]);
    applyTenantSnapshot([{ ...TENANT, tenantId: "tenant-a", terminalSessionId: "session-a" }]);
    selectTerminalSession("session-a");

    expect(getState().activeTerminalSessionId).toBe("session-a");
    expect(getState().sessions["session-a"]?.tenantId).toBe("tenant-a");
  });

  it("lists active jobs only for the active terminal session", () => {
    hydrateTerminalSessions([
      { sessionId: "tenant-a", terminalSessionId: "tenant-a", cwdLabel: "alpha", status: "terminal-only", createdAt: 1 },
      { sessionId: "tenant-b", terminalSessionId: "tenant-b", cwdLabel: "beta", status: "terminal-only", createdAt: 2 },
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

    expect(activeSessionActiveJobs(getState()).map(({ job }) => job.jobId)).toEqual(["job-a-live"]);

    selectTerminalSession("tenant-b");
    expect(activeSessionActiveJobs(getState()).map(({ job }) => job.jobId)).toEqual(["job-b-live"]);
  });

  it("tracks operations landing and session creation state", () => {
    expect(getState().activeTerminalSessionId).toBeNull();
    beginCreateTerminalSession();
    expect(getState()).toMatchObject({ creatingTerminalSession: true, terminalSessionError: null });

    completeCreateTerminalSession({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", status: "terminal-only", createdAt: 1 });

    expect(getState()).toMatchObject({ activeTerminalSessionId: "session-a", creatingTerminalSession: false });
    expect(getState().sessionOrder).toEqual(["session-a"]);
  });

  it("binds hydrated terminal sessions to tenants without changing the active session", () => {
    hydrateTerminalSessions([{ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", status: "starting", createdAt: 1 }]);
    selectTerminalSession("session-a");
    applyTenantSnapshot([{ ...TENANT, terminalSessionId: "session-a", registrationId: "registration-a" }]);

    expect(getState().sessions["session-a"]).toMatchObject({ status: "registered", tenantId: "tenant-1", registrationId: "registration-a" });
    expect(getState().activeTerminalSessionId).toBe("session-a");
  });

  it("opens CarrierCover to list and keeps cover detail selection independent", () => {
    hydrateTerminalSessions([{ sessionId: "tenant-1", terminalSessionId: "tenant-1", cwdLabel: "alpha", status: "terminal-only", createdAt: 1 }]);
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
    toggleCover();
    expect(getState()).toMatchObject({ coverOpen: true, coverDepth: "list", coverSelectedJobId: null });

    selectCoverJob("job-2");
    expect(getState()).toMatchObject({ coverOpen: true, coverDepth: "detail", coverSelectedJobId: "job-2" });
    expect(selectedCoverJob(getState())?.jobId).toBe("job-2");

    backToCoverList();
    expect(getState()).toMatchObject({ coverDepth: "list", coverSelectedJobId: null });
  });

  it("does not resolve cover detail jobs outside the active terminal session", () => {
    hydrateTerminalSessions([
      { sessionId: "tenant-a", terminalSessionId: "tenant-a", cwdLabel: "alpha", status: "terminal-only", createdAt: 1 },
      { sessionId: "tenant-b", terminalSessionId: "tenant-b", cwdLabel: "beta", status: "terminal-only", createdAt: 2 },
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

    selectCoverJob("job-b");
    expect(selectedCoverJob(getState())).toBeNull();
  });
});
