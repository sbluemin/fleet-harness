import { beforeEach, describe, expect, it } from "vitest";

import {
  applyJobsSnapshot,
  applyObservedEvent,
  applyTenantSnapshot,
  applyTruncation,
  backToCoverList,
  beginCreateTerminalSession,
  completeCreateTerminalSession,
  getState,
  hydrateTerminalSessions,
  resetForToken,
  selectJob,
  selectCoverJob,
  selectTenant,
  selectTerminalSession,
  selectedCoverJob,
  selectedJob,
  setState,
  toggleCover,
} from "../client/src/store.js";
import type { ObservedEvent, ObservedTenant } from "../client/src/types.js";

const TENANT: ObservedTenant = { tenantId: "tenant-1", tenantLabel: "Alpha", cwd: "/repo/alpha", createdAt: 1, sessions: 1 };

function makeEvent(id: number, type: string, event: Record<string, unknown>, tenantId = "tenant-1", jobId = "job-1"): ObservedEvent {
  return { id, tenantId, jobId, type, at: 1_000 + id, event: { type, jobId, ...event } };
}

beforeEach(() => {
  resetForToken("token-a");
  setState({
    tenants: [],
    tenantJobs: {},
    tenantOrder: [],
    selectedTenantId: null,
    selectedJobId: null,
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
  it("selects the first tenant after a tenant snapshot", () => {
    applyTenantSnapshot([TENANT]);
    expect(getState().selectedTenantId).toBe("tenant-1");
  });

  it("builds job views from a jobs snapshot and keeps selection stable across resync", () => {
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
    selectJob("tenant-1", "job-1");
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
    expect(getState().selectedJobId).toBe("job-1");
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

  it("does not let another tenant's live event preempt the job selection", () => {
    applyTenantSnapshot([TENANT]);
    expect(getState().selectedTenantId).toBe("tenant-1");
    applyObservedEvent(makeEvent(1, "track:text", { trackId: "t1", text: "other" }, "tenant-9", "job-9"));
    expect(getState().selectedTenantId).toBe("tenant-1");
    expect(getState().selectedJobId).toBeNull();
    applyObservedEvent(makeEvent(2, "track:text", { trackId: "t1", text: "mine" }, "tenant-1", "job-1"));
    expect(getState().selectedJobId).toBe("job-1");
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

  it("resolves the selected job falling back to the first job of the tenant", () => {
    applyObservedEvent(makeEvent(1, "track:text", { trackId: "t1", text: "x" }));
    selectTenant("tenant-1");
    expect(selectedJob(getState())?.jobId).toBe("job-1");
  });

  it("keeps terminal session selection separate from observer selection", () => {
    hydrateTerminalSessions([{ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", status: "terminal-only", createdAt: 1 }]);
    applyTenantSnapshot([{ ...TENANT, tenantId: "tenant-a", terminalSessionId: "session-a" }]);
    selectTerminalSession("session-a");
    selectJob("tenant-a", "job-a");

    expect(getState().activeTerminalSessionId).toBe("session-a");
    expect(getState().selectedTenantId).toBe("tenant-a");
    expect(getState().selectedJobId).toBe("job-a");
  });

  it("tracks operations landing and session creation state", () => {
    expect(getState().activeTerminalSessionId).toBeNull();
    beginCreateTerminalSession();
    expect(getState()).toMatchObject({ creatingTerminalSession: true, terminalSessionError: null });

    completeCreateTerminalSession({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", status: "terminal-only", createdAt: 1 });

    expect(getState()).toMatchObject({ activeTerminalSessionId: "session-a", creatingTerminalSession: false });
    expect(getState().sessionOrder).toEqual(["session-a"]);
  });

  it("binds hydrated terminal sessions to tenants without changing selected job", () => {
    hydrateTerminalSessions([{ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", status: "starting", createdAt: 1 }]);
    selectTerminalSession("session-a");
    selectJob("tenant-1", "job-1");
    applyTenantSnapshot([{ ...TENANT, terminalSessionId: "session-a", registrationId: "registration-a" }]);

    expect(getState().sessions["session-a"]).toMatchObject({ status: "registered", tenantId: "tenant-1", registrationId: "registration-a" });
    expect(getState().activeTerminalSessionId).toBe("session-a");
    expect(getState().selectedJobId).toBe("job-1");
  });

  it("opens CarrierCover to list and keeps cover detail selection independent", () => {
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
    selectJob("tenant-1", "job-1");

    toggleCover();
    expect(getState()).toMatchObject({ coverOpen: true, coverDepth: "list", coverSelectedJobId: null, selectedJobId: "job-1" });

    selectCoverJob("job-2");
    expect(getState()).toMatchObject({ coverDepth: "detail", coverSelectedJobId: "job-2", selectedJobId: "job-1" });
    expect(selectedCoverJob(getState())?.jobId).toBe("job-2");
    expect(selectedJob(getState())?.jobId).toBe("job-1");

    backToCoverList();
    expect(getState()).toMatchObject({ coverDepth: "list", coverSelectedJobId: null, selectedJobId: "job-1" });
  });
});
