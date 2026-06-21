import { beforeEach, describe, expect, it } from "vitest";

import {
  applyJobsSnapshot,
  applyObservedEvent,
  applyObserverStatus,
  applyReleaseNotes,
  applySessionAttention,
  applySessionUpdate,
  applyTenantSnapshot,
  applyTruncation,
  beginCreateTerminalSession,
  completeAddTheater,
  clearSelectedJob,
  closeShortcuts,
  completeCreateTerminalSession,
  closeOperationSearch,
  closeOnboarding,
  closeWhatsNew,
  failResumeTerminalSession,
  focusOperation,
  getState,
  hydrateTerminalSessions,
  hydrateTheaters,
  openOnboarding,
  openOperationSearch,
  openShortcuts,
  openWhatsNew,
  readStoredRenderer,
  removeTerminalSession,
  removeTheater,
  resolveOnboardingOnBootstrap,
  selectJob,
  selectTerminalSession,
  selectedJob,
  sessionJobs,
  setActiveTheater,
  setDnd,
  setGlobalMute,
  setTerminalRenderer,
  setState,
  theaterSessionOrder,
  theaterSessions,
  toggleOperationSearch,
  toggleShortcuts,
  toggleTheaterMute,
} from "../client/src/store.js";
import type { ObservedEvent, ObservedTenant, OperationNotification, TheaterInfo } from "../client/src/types.js";

const TENANT: ObservedTenant = { tenantId: "tenant-1", tenantLabel: "Alpha", createdAt: 1, sessions: 1, theaterId: "theater-a" };
const THEATER_A: TheaterInfo = { id: "theater-a", label: "Alpha", createdAt: "2026-06-13T00:00:00.000Z", lastOpenedAt: "2026-06-13T00:00:00.000Z", hasWiki: true, activeAdmiralCount: 1 };
const THEATER_B: TheaterInfo = { id: "theater-b", label: "Beta", createdAt: "2026-06-13T00:00:00.000Z", lastOpenedAt: "2026-06-13T00:00:01.000Z", hasWiki: false, activeAdmiralCount: 0 };
const RENDERER_STORAGE_KEY = "fleet-console.terminalRenderer";
const COMMISSIONING_SEEN_STORAGE_KEY = "fleet-console.commissioningSeen";
const NOTIFICATION_PREFERENCES_STORAGE_KEY = "fleet-console.notificationPreferences";

function makeEvent(id: number, type: string, event: Record<string, unknown>, tenantId = "tenant-1", jobId = "job-1"): ObservedEvent {
  return { id, tenantId, jobId, type, at: 1_000 + id, event: { type, jobId, ...event } };
}

function mockLocalStorage(storage: Map<string, string>): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
    },
  });
}

function currentNotifications(): readonly OperationNotification[] {
  return Object.values(getState().operationNotifications);
}

beforeEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  setState({
    connection: "connecting",
    connectionError: null,
    terminalRenderer: "webgl",
    updateAvailable: false,
    latestVersion: null,
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
    operationSearchOpen: false,
    shortcutsOpen: false,
    onboardingOpen: false,
    bootstrapped: false,
    pendingOperationFocus: null,
    selectedJobId: null,
    operationsViewActive: false,
    whatsNewOpen: false,
  terminalSessionsHydrated: false,
    releaseNotes: [],
    releaseNotesLoading: false,
    releaseNotesError: null,
    releaseNotesSourceRef: null,
    releaseNotesFetchedAt: null,
    releaseNotesStale: false,
    automaticWhatsNewVersion: null,
    selectedReleaseNoteKey: null,
    operationNotifications: {},
    notificationPreferences: { globalMute: false, dnd: false, mutedTheaterIds: {} },
  });
});

describe("store", () => {
  it("reads the stored terminal renderer with webgl as the default", () => {
    expect(readStoredRenderer()).toBe("webgl");

    const storage = new Map<string, string>();
    mockLocalStorage(storage);

    expect(readStoredRenderer()).toBe("webgl");

    storage.set(RENDERER_STORAGE_KEY, "dom");
    expect(readStoredRenderer()).toBe("dom");

    storage.set(RENDERER_STORAGE_KEY, "canvas");
    expect(readStoredRenderer()).toBe("webgl");
  });

  it("persists terminal renderer changes into state and localStorage", () => {
    const storage = new Map<string, string>();
    mockLocalStorage(storage);

    setTerminalRenderer("dom");

    expect(getState().terminalRenderer).toBe("dom");
    expect(storage.get(RENDERER_STORAGE_KEY)).toBe("dom");
  });

  it("applies observer update status to the global state", () => {
    applyObserverStatus({
      workspaces: 0,
      jobs: 0,
      version: "1.0.0",
      channel: "stable",
      updateAvailable: true,
      latestVersion: "1.1.0",
      port: 1234,
      wikiServerStatus: "unknown",
    });

    expect(getState().updateAvailable).toBe(true);
    expect(getState().latestVersion).toBe("1.1.0");
  });

  it("opens What's new when notes arrive before matching observer status", () => {
    const storage = new Map<string, string>();
    mockLocalStorage(storage);
    applyReleaseNotes({
      notes: [
        { version: "Unreleased", date: null, sections: [{ heading: "Changed", items: [{ packageTags: ["fleet-console"], text: "Draft." }] }] },
        { version: "1.0.0", date: "2026-06-20", sections: [{ heading: "Changed", items: [{ packageTags: ["fleet-console"], text: "Runtime notes." }] }] },
        { version: "1.0.0", date: "2026-06-19", sections: [{ heading: "Fixed", items: [{ packageTags: [], text: "Duplicate version." }] }] },
      ],
      sourceRef: "main",
      fetchedAt: 10,
      stale: false,
    });
    applyObserverStatus({ workspaces: 0, jobs: 0, version: "1.0.0", channel: "stable", updateAvailable: false, port: 1, wikiServerStatus: "unknown" });

    expect(getState()).toMatchObject({ whatsNewOpen: true, automaticWhatsNewVersion: "1.0.0", selectedReleaseNoteKey: "1.0.0:1" });
  });

  it("opens What's new when matching observer status arrives before notes", () => {
    applyObserverStatus({ workspaces: 0, jobs: 0, version: "1.0.0", channel: "stable", updateAvailable: false, port: 1, wikiServerStatus: "unknown" });
    applyReleaseNotes({
      notes: [{ version: "1.0.0", date: "2026-06-20", sections: [{ heading: "Changed", items: [{ packageTags: [], text: "Runtime notes." }] }] }],
      sourceRef: "main",
      fetchedAt: 10,
      stale: false,
    });

    expect(getState().whatsNewOpen).toBe(true);
  });

  it("records the triggering release version when closing automatic What's new", () => {
    const storage = new Map<string, string>();
    mockLocalStorage(storage);
    applyReleaseNotes({
      notes: [{ version: "1.0.0", date: "2026-06-20", sections: [{ heading: "Changed", items: [{ packageTags: [], text: "Runtime notes." }] }] }],
      sourceRef: "main",
      fetchedAt: 10,
      stale: false,
    });
    applyObserverStatus({ workspaces: 0, jobs: 0, version: "1.0.0", channel: "stable", updateAvailable: false, port: 1, wikiServerStatus: "unknown" });

    closeWhatsNew();

    expect(storage.get("fleet-console.whatsNewSeenVersion")).toBe("1.0.0");
    expect(getState().automaticWhatsNewVersion).toBeNull();
  });

  it("does not automatically open What's new without usable data or when already seen", () => {
    const storage = new Map<string, string>([["fleet-console.whatsNewSeenVersion", "1.0.0"]]);
    mockLocalStorage(storage);
    applyObserverStatus({ workspaces: 0, jobs: 0, version: "1.0.0", channel: "stable", updateAvailable: false, port: 1, wikiServerStatus: "unknown" });
    applyReleaseNotes({
      notes: [{ version: "1.0.0", date: "2026-06-20", sections: [{ heading: "Changed", items: [{ packageTags: [], text: "Runtime notes." }] }] }],
      sourceRef: "main",
      fetchedAt: 10,
      stale: false,
    });

    expect(getState().whatsNewOpen).toBe(false);
    openWhatsNew();
    expect(getState().whatsNewOpen).toBe(true);
  });

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
    beginCreateTerminalSession();
    expect(getState()).toMatchObject({ creatingTerminalSession: true, terminalSessionError: null });

    hydrateTheaters([THEATER_A]);
    completeCreateTerminalSession({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, status: "terminal-only", createdAt: 1, theaterId: "theater-a" });

    expect(getState()).toMatchObject({ activeTerminalSessionId: "session-a", creatingTerminalSession: false });
    expect(getState().sessionOrder).toEqual(["session-a"]);
  });

  it("keeps restored dormant operations visible without auto-selecting them", () => {
    hydrateTheaters([THEATER_A]);
    hydrateTerminalSessions([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, status: "dormant", createdAt: 1, theaterId: "theater-a", resumeAvailable: true },
    ]);

    expect(theaterSessions(getState()).map((session) => session.sessionId)).toEqual(["session-a"]);
    expect(getState().activeTerminalSessionId).toBeNull();

    applySessionUpdate({ sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, status: "dormant", createdAt: 2, theaterId: "theater-a", resumeAvailable: true });
    expect(getState().sessionOrder).toEqual(["session-b", "session-a"]);
    expect(getState().activeTerminalSessionId).toBeNull();
  });

  it("continues auto-selecting live terminal sessions", () => {
    hydrateTheaters([THEATER_A]);
    hydrateTerminalSessions([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, status: "terminal-only", createdAt: 1, theaterId: "theater-a", resumeAvailable: false },
    ]);

    expect(getState().activeTerminalSessionId).toBe("session-a");
  });

  it("keeps a dormant operation intact when resume fails and activates only after success", () => {
    hydrateTheaters([THEATER_A]);
    hydrateTerminalSessions([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, status: "dormant", createdAt: 1, theaterId: "theater-a", resumeAvailable: true },
    ]);

    failResumeTerminalSession("resume_unavailable");
    expect(getState().sessions["session-a"]).toMatchObject({ status: "dormant", resumeAvailable: true });
    expect(getState().activeTerminalSessionId).toBeNull();

    applySessionUpdate({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, status: "registered", createdAt: 1, theaterId: "theater-a", resumeAvailable: true });
    selectTerminalSession("session-a");
    expect(getState().activeTerminalSessionId).toBe("session-a");
    expect(getState().sessions["session-a"]).toMatchObject({ status: "registered", resumeAvailable: true });
  });

  it("keeps a session card when the server reports dormant after terminal close", () => {
    hydrateTheaters([THEATER_A]);
    hydrateTerminalSessions([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, status: "registered", createdAt: 1, theaterId: "theater-a", resumeAvailable: true },
    ]);
    expect(getState().activeTerminalSessionId).toBe("session-a");

    applySessionUpdate({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, status: "dormant", createdAt: 1, theaterId: "theater-a", resumeAvailable: true });

    expect(getState().sessions["session-a"]).toMatchObject({ status: "dormant", resumeAvailable: true });
    expect(getState().sessionOrder).toEqual(["session-a"]);
    expect(getState().activeTerminalSessionId).toBeNull();
  });

  it("toggles and closes the operation search modal state", () => {
    expect(getState().operationSearchOpen).toBe(false);

    openOperationSearch();
    expect(getState().operationSearchOpen).toBe(true);

    toggleOperationSearch();
    expect(getState().operationSearchOpen).toBe(false);

    toggleOperationSearch();
    expect(getState().operationSearchOpen).toBe(true);

    closeOperationSearch();
    expect(getState().operationSearchOpen).toBe(false);
  });

  it("opens, closes, and toggles the keyboard shortcuts overlay", () => {
    expect(getState().shortcutsOpen).toBe(false);

    openShortcuts();
    expect(getState().shortcutsOpen).toBe(true);

    openShortcuts();
    expect(getState().shortcutsOpen).toBe(true);

    closeShortcuts();
    expect(getState().shortcutsOpen).toBe(false);

    closeShortcuts();
    expect(getState().shortcutsOpen).toBe(false);

    toggleShortcuts();
    expect(getState().shortcutsOpen).toBe(true);

    toggleShortcuts();
    expect(getState().shortcutsOpen).toBe(false);
  });

  it("opens commissioning automatically after bootstrap only when no Theaters are registered and it has not been seen", () => {
    const storage = new Map<string, string>();
    mockLocalStorage(storage);

    hydrateTheaters([]);
    expect(getState()).toMatchObject({ bootstrapped: false, onboardingOpen: false });

    resolveOnboardingOnBootstrap();

    expect(getState()).toMatchObject({ bootstrapped: true, onboardingOpen: true });
  });

  it("does not open commissioning automatically when Theaters exist", () => {
    const storage = new Map<string, string>();
    mockLocalStorage(storage);

    hydrateTheaters([THEATER_A]);
    resolveOnboardingOnBootstrap();

    expect(getState()).toMatchObject({ bootstrapped: true, onboardingOpen: false });
  });

  it("does not open commissioning automatically after it has been dismissed", () => {
    const storage = new Map<string, string>([[COMMISSIONING_SEEN_STORAGE_KEY, "1"]]);
    mockLocalStorage(storage);

    hydrateTheaters([]);
    resolveOnboardingOnBootstrap();

    expect(getState()).toMatchObject({ bootstrapped: true, onboardingOpen: false });
  });

  it("opens and closes commissioning manually while persisting the dismissed marker", () => {
    const storage = new Map<string, string>();
    mockLocalStorage(storage);

    expect(getState().onboardingOpen).toBe(false);

    openOnboarding();
    expect(getState().onboardingOpen).toBe(true);

    closeOnboarding();
    expect(getState().onboardingOpen).toBe(false);
    expect(storage.get(COMMISSIONING_SEEN_STORAGE_KEY)).toBe("1");
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

  it("merges input-waiting notifications by session and keeps visible sessions in the normalized map", () => {
    setState({ operationNotifications: {} });
    hydrateTheaters([THEATER_A, THEATER_B]);
    hydrateTerminalSessions([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a" },
      { sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, label: "Aux", status: "registered", createdAt: 2, theaterId: "theater-b" },
    ]);
    setActiveTheater("theater-a");
    selectTerminalSession("session-a");
    // Operations 뷰(/operations)에서 session-a를 보고 있는 상태.
    setState({ operationsViewActive: true });

    // 비활성 Operation(session-b, 다른 Theater) → 입력 대기 알림 발행.
    applySessionAttention({ sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, label: "Aux", status: "registered", createdAt: 2, theaterId: "theater-b" });
    expect(currentNotifications()).toHaveLength(1);
    const firstRaisedSeq = getState().operationNotifications["session-b"]?.lastRaisedSeq;
    expect(getState().operationNotifications["session-b"]).toMatchObject({ kind: "input-waiting", sessionId: "session-b", theaterLabel: "Beta", count: 1 });

    // 같은 세션 재알림(AskUserQuestion의 PreToolUse+Notification 동시 발화 등) → count 병합 + seq 갱신.
    applySessionAttention({ sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, label: "Aux", status: "registered", createdAt: 2, theaterId: "theater-b" });
    expect(currentNotifications()).toHaveLength(1);
    expect(getState().operationNotifications["session-b"]).toMatchObject({ count: 2 });
    expect(getState().operationNotifications["session-b"]?.lastRaisedSeq).toBeGreaterThan(firstRaisedSeq ?? 0);

    // Operations 뷰에서 보고 있는 활성 Operation(session-a)도 맵에 남기고, 렌더 selector에서 visible로 분리한다.
    applySessionAttention({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a" });
    expect(currentNotifications()).toHaveLength(2);
    expect(getState().operationNotifications["session-a"]).toMatchObject({ kind: "input-waiting", sessionId: "session-a" });

    // Operations 뷰를 벗어난 상태의 재알림도 같은 sessionId에 병합된다.
    setState({ operationsViewActive: false });
    applySessionAttention({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a" });
    expect(currentNotifications()).toHaveLength(2);
    expect(getState().operationNotifications["session-a"]).toMatchObject({ kind: "input-waiting", sessionId: "session-a", count: 2 });
  });

  it("never raises a carrier-call toast when a fresh carrier job appears on an inactive operation", () => {
    setState({ operationNotifications: {},
  notificationPreferences: { globalMute: false, dnd: false, mutedTheaterIds: {} }, tenantJobs: {}, tenantOrder: [] });
    hydrateTheaters([THEATER_A, THEATER_B]);
    hydrateTerminalSessions([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a" },
      { sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, label: "Aux", status: "registered", createdAt: 2, theaterId: "theater-b" },
    ]);
    // session-b를 보고 있는 상태 → session-a는 비활성 Operation(예전이라면 carrier-call 토스트 대상).
    setActiveTheater("theater-b");
    selectTerminalSession("session-b");
    applyTenantSnapshot([{ ...TENANT, terminalSessionId: "session-a", registrationId: "registration-a" }]);

    // 갓 발생한(최신 타임스탬프) 새 carrier job — carrier-call 토스트가 폐지됐으므로 어떤 토스트도 뜨지 않는다.
    applyObservedEvent({ id: 1, tenantId: "tenant-1", jobId: "job-1", type: "job:registered", at: Date.now(), event: { type: "job:registered", jobId: "job-1" } });

    expect(currentNotifications()).toHaveLength(0);
  });

  it("suppresses the ended toast while a carrier job is in flight and emits none on bare job finalization", () => {
    setState({ operationNotifications: {},
  notificationPreferences: { globalMute: false, dnd: false, mutedTheaterIds: {} }, tenantJobs: {}, tenantOrder: [] });
    hydrateTheaters([THEATER_A, THEATER_B]);
    hydrateTerminalSessions([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a" },
      { sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, label: "Aux", status: "registered", createdAt: 2, theaterId: "theater-b" },
    ]);
    // session-b를 보고 있으므로 session-a는 비활성 Operation.
    setActiveTheater("theater-b");
    selectTerminalSession("session-b");
    applyTenantSnapshot([{ ...TENANT, terminalSessionId: "session-a", registrationId: "registration-a" }]);

    // 턴 처리 시작 + 미완료 carrier job 발생.
    applySessionUpdate({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a", turnState: "running" });
    applyObservedEvent({ id: 1, tenantId: "tenant-1", jobId: "job-1", type: "job:registered", at: Date.now(), event: { type: "job:registered", jobId: "job-1" } });

    // 턴 종료 — job이 진행 중이므로 ended 토스트 억제.
    applySessionUpdate({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a", turnState: "ended" });
    expect(currentNotifications()).toHaveLength(0);

    // 출격 작업의 완료(job:finalized)만으로는 완료 토스트를 발행하지 않는다 — 라이브 Operation 패널이 표시.
    applyObservedEvent({ id: 2, tenantId: "tenant-1", jobId: "job-1", type: "job:finalized", at: Date.now(), event: { type: "job:finalized", jobId: "job-1", status: "done" } });
    expect(currentNotifications()).toHaveLength(0);
  });

  it("suppresses an idle_prompt attention toast while a carrier job is in flight, but keeps permission/absent reasons", () => {
    setState({ operationNotifications: {},
  notificationPreferences: { globalMute: false, dnd: false, mutedTheaterIds: {} }, tenantJobs: {}, tenantOrder: [] });
    hydrateTheaters([THEATER_A, THEATER_B]);
    hydrateTerminalSessions([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a" },
      { sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, label: "Aux", status: "registered", createdAt: 2, theaterId: "theater-b" },
    ]);
    // session-b를 보고 있으므로 session-a는 비활성(백그라운드) Operation.
    setActiveTheater("theater-b");
    selectTerminalSession("session-b");
    setState({ operationsViewActive: true });
    applyTenantSnapshot([{ ...TENANT, terminalSessionId: "session-a", registrationId: "registration-a" }]);

    // 캐리어 출격 중(미완료 job).
    applyObservedEvent({ id: 1, tenantId: "tenant-1", jobId: "job-1", type: "job:registered", at: Date.now(), event: { type: "job:registered", jobId: "job-1" } });

    // idle_prompt는 입력 대기가 아니라 비동기 작업 대기 → 출격 중 억제.
    applySessionAttention({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a" }, "idle_prompt");
    expect(currentNotifications()).toHaveLength(0);

    // 권한 요청은 출격 중에도 실제 입력 대기 → 알림.
    applySessionAttention({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a" }, "permission_prompt");
    expect(currentNotifications()).toHaveLength(1);
    expect(currentNotifications()[0]).toMatchObject({ kind: "input-waiting", sessionId: "session-a" });

    // reason 부재(예: AskUserQuestion=PreToolUse)는 idle로 추정하지 않고 알림을 유지한다.
    setState({ operationNotifications: {},
  notificationPreferences: { globalMute: false, dnd: false, mutedTheaterIds: {} } });
    applySessionAttention({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a" });
    expect(currentNotifications()).toHaveLength(1);
  });

  it("treats a snapshot-restored finished job without finishedAt as inactive so a later turn end still fires", () => {
    setState({ operationNotifications: {},
  notificationPreferences: { globalMute: false, dnd: false, mutedTheaterIds: {} }, tenantJobs: {}, tenantOrder: [] });
    hydrateTheaters([THEATER_A, THEATER_B]);
    hydrateTerminalSessions([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a" },
      { sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, label: "Aux", status: "registered", createdAt: 2, theaterId: "theater-b" },
    ]);
    setActiveTheater("theater-b");
    selectTerminalSession("session-b");
    applyTenantSnapshot([{ ...TENANT, terminalSessionId: "session-a", registrationId: "registration-a" }]);

    // finalize 이벤트가 보존 한도로 잘려 status는 done이지만 finishedAt이 없는 스냅샷 복원 job.
    applyJobsSnapshot([
      {
        tenantId: "tenant-1",
        tenantLabel: "Alpha",
        truncation: { droppedCount: 0 },
        jobs: [{ jobId: "job-1", status: "done", updatedAt: 1_001, events: [] }],
      },
    ]);

    // 출격은 이미 종결(done)이므로 턴 종료 시 stop 토스트가 정상 발행돼야 한다(영구 억제 회귀 방지).
    applySessionUpdate({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a", turnState: "running" });
    applySessionUpdate({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a", turnState: "ended" });
    expect(currentNotifications()).toHaveLength(1);
    expect(currentNotifications()[0]).toMatchObject({ kind: "ended", sessionId: "session-a" });
  });

  it("fires the ended toast on turn end when the carrier job already finished first", () => {
    setState({ operationNotifications: {},
  notificationPreferences: { globalMute: false, dnd: false, mutedTheaterIds: {} }, tenantJobs: {}, tenantOrder: [] });
    hydrateTheaters([THEATER_A, THEATER_B]);
    hydrateTerminalSessions([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a" },
      { sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, label: "Aux", status: "registered", createdAt: 2, theaterId: "theater-b" },
    ]);
    setActiveTheater("theater-b");
    selectTerminalSession("session-b");
    applyTenantSnapshot([{ ...TENANT, terminalSessionId: "session-a", registrationId: "registration-a" }]);

    // job이 턴보다 먼저 끝나는 흐름: 등록→완료(턴은 아직 running) — job 완료만으로는 토스트 없음.
    applySessionUpdate({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a", turnState: "running" });
    applyObservedEvent({ id: 1, tenantId: "tenant-1", jobId: "job-1", type: "job:registered", at: Date.now(), event: { type: "job:registered", jobId: "job-1" } });
    applyObservedEvent({ id: 2, tenantId: "tenant-1", jobId: "job-1", type: "job:finalized", at: Date.now(), event: { type: "job:finalized", jobId: "job-1", status: "done" } });
    expect(currentNotifications()).toHaveLength(0);

    // 턴 종료 시점엔 미완료 job이 없으므로 turn 전이 경로가 완료 토스트를 발행한다.
    applySessionUpdate({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a", turnState: "ended" });
    expect(currentNotifications()).toHaveLength(1);
    expect(currentNotifications()[0]).toMatchObject({ kind: "ended", sessionId: "session-a" });
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

  it("focuses an operation across Theater boundaries in one state update", () => {
    const storage = new Map<string, string>();
    mockLocalStorage(storage);
    hydrateTheaters([THEATER_A, THEATER_B]);
    hydrateTerminalSessions([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, status: "terminal-only", createdAt: 1, theaterId: "theater-a" },
      { sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, status: "terminal-only", createdAt: 2, theaterId: "theater-b" },
    ]);
    selectJob("job-a");

    focusOperation("session-b");

    expect(getState()).toMatchObject({
      activeTheaterId: "theater-b",
      activeTerminalSessionId: "session-b",
      selectedJobId: null,
    });
    expect(storage.get("fleet-console.activeTheaterId")).toBe("theater-b");
  });

  it("dismisses notifications only from user-intent focus paths", () => {
    hydrateTheaters([THEATER_A, THEATER_B]);
    hydrateTerminalSessions([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a" },
      { sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, label: "Aux", status: "registered", createdAt: 2, theaterId: "theater-b" },
    ]);

    applySessionAttention({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a" });
    expect(getState().operationNotifications["session-a"]).toBeDefined();

    selectTerminalSession("session-a");
    expect(getState().operationNotifications["session-a"]).toBeUndefined();

    applySessionAttention({ sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, label: "Aux", status: "registered", createdAt: 2, theaterId: "theater-b" });
    focusOperation("session-b");
    expect(getState().operationNotifications["session-b"]).toBeUndefined();
  });

  it("clears a session notification when its turn resumes", () => {
    setState({ operationNotifications: {} });
    hydrateTheaters([THEATER_A]);
    hydrateTerminalSessions([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a" },
    ]);
    applySessionAttention({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a" });
    expect(getState().operationNotifications["session-a"]).toBeDefined();
    // 입력 대기 응답 후 턴이 재개(running)되면 stale 알림(보이는 패널 awaiting + 클러스터 행)을 자동 정리한다.
    applySessionUpdate({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a", turnState: "running" });
    expect(getState().operationNotifications["session-a"]).toBeUndefined();
  });

  it("prunes notifications when a session or its Theater is removed", () => {
    setState({ operationNotifications: {} });
    hydrateTheaters([THEATER_A, THEATER_B]);
    hydrateTerminalSessions([
      { sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a" },
      { sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, label: "Aux", status: "registered", createdAt: 2, theaterId: "theater-b" },
    ]);
    applySessionAttention({ sessionId: "session-a", terminalSessionId: "session-a", cwdLabel: "alpha", sequence: 1, label: "Bridge", status: "registered", createdAt: 1, theaterId: "theater-a" });
    applySessionAttention({ sessionId: "session-b", terminalSessionId: "session-b", cwdLabel: "beta", sequence: 2, label: "Aux", status: "registered", createdAt: 2, theaterId: "theater-b" });

    // 세션 삭제 — 해당 세션 알림만 제거되고 다른 세션 알림은 유지된다.
    removeTerminalSession("session-a");
    expect(getState().operationNotifications["session-a"]).toBeUndefined();
    expect(getState().operationNotifications["session-b"]).toBeDefined();

    // Theater 삭제 — 그 Theater의 모든 Operation 알림이 제거된다.
    removeTheater("theater-b");
    expect(getState().operationNotifications["session-b"]).toBeUndefined();
  });

  it("persists notification preferences as one versioned localStorage blob", () => {
    const storage = new Map<string, string>();
    mockLocalStorage(storage);

    setGlobalMute(true);
    setDnd(true);
    toggleTheaterMute("theater-a");

    expect(getState().notificationPreferences).toEqual({
      globalMute: true,
      dnd: true,
      mutedTheaterIds: { "theater-a": true },
    });
    expect(JSON.parse(storage.get(NOTIFICATION_PREFERENCES_STORAGE_KEY) ?? "{}")).toEqual({
      version: 1,
      preferences: {
        globalMute: true,
        dnd: true,
        mutedTheaterIds: { "theater-a": true },
      },
    });
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
