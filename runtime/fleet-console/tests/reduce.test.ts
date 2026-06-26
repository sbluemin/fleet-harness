import { describe, expect, it } from "vitest";

import {
  applyEvent,
  computeVisibleSessionIds,
  createEmptyJob,
  filterByPreferences,
  groupNotificationsByTheater,
  reduceSnapshotJob,
  splitNotificationsByVisibility,
} from "../client/src/reduce.js";
import { createDefaultTerminalFontSettings } from "../client/src/terminal-font.js";
import type { ConsoleState, NotificationPreferences, ObservedEvent, OperationNotification } from "../client/src/types.js";

function makeEvent(id: number, type: string, event: Record<string, unknown>, jobId = "job-1"): ObservedEvent {
  return { id, tenantId: "tenant-1", jobId, type, at: 1_000 + id, event: { type, jobId, ...event } };
}

function makeNotification(
  sessionId: string,
  theaterId: string | null,
  lastRaisedSeq: number,
  count = 1,
): OperationNotification {
  return {
    kind: "input-waiting",
    sessionId,
    theaterId,
    theaterLabel: theaterId ?? "Unknown",
    operationLabel: sessionId,
    count,
    lastRaisedSeq,
  };
}

function makeConsoleSnap(patch: Partial<ConsoleState> = {}): ConsoleState {
  return {
    connection: "live",
    connectionError: null,
    activeTheme: "maritime",
    terminalRenderer: "webgl",
    terminalFont: createDefaultTerminalFontSettings(),
    version: "1.8.0",
    updateAvailable: false,
    latestVersion: null,
    portMode: "dynamic",
    requestedPort: null,
    effectivePort: 0,
    portHonored: true,
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
    operationSearchOpen: false,
    shortcutsOpen: false,
    whatsNewOpen: false,
    releaseNotes: [],
    releaseNotesLoading: false,
    releaseNotesError: null,
    releaseNotesSourceRef: null,
    releaseNotesFetchedAt: null,
    releaseNotesStale: false,
    automaticWhatsNewVersion: null,
    selectedReleaseNoteKey: null,
    onboardingOpen: false,
    bootstrapped: true,
    terminalSessionsHydrated: true,
    pendingOperationFocus: null,
    selectedJobId: null,
    operationNotifications: {},
    notificationPreferences: { globalMute: false, dnd: false, mutedTheaterIds: {} },
    ...patch,
  };
}

describe("applyEvent", () => {
  it("registers job metadata and track order from job:registered", () => {
    const job = applyEvent(
      createEmptyJob("tenant-1", "job-1", 1_000),
      makeEvent(1, "job:registered", {
        label: "Refactor sweep",
        ownerCarrierId: "nimitz",
        kind: "taskforce",
        startedAt: 900,
        tracks: [
          { trackId: "t1", displayName: "Claude", displayCli: "claude", model: "opus" },
          { trackId: "t2", displayName: "Codex", displayCli: "codex" },
        ],
      }),
    );
    expect(job.label).toBe("Refactor sweep");
    expect(job.ownerCarrierId).toBe("nimitz");
    expect(job.startedAt).toBe(900);
    expect(job.trackOrder).toEqual(["t1", "t2"]);
    expect(job.tracks.t1?.displayName).toBe("Claude");
    expect(job.tracks.t1?.model).toBe("opus");
  });

  it("accumulates streaming text deltas per track", () => {
    let job = createEmptyJob("tenant-1", "job-1", 1_000);
    job = applyEvent(job, makeEvent(1, "track:text", { trackId: "t1", text: "Hello" }));
    job = applyEvent(job, makeEvent(2, "track:text", { trackId: "t1", text: ", world" }));
    job = applyEvent(job, makeEvent(3, "track:thought", { trackId: "t1", text: "pondering" }));
    expect(job.tracks.t1?.text).toBe("Hello, world");
    expect(job.tracks.t1?.thought).toBe("pondering");
    expect(job.tracks.t1?.status).toBe("stream");
  });

  it("tracks emitted length separately so clamped retention is detectable", () => {
    let job = createEmptyJob("tenant-1", "job-1", 1_000);
    job = applyEvent(job, makeEvent(1, "track:text", { trackId: "t1", text: "short", textLength: 10_000 }));
    expect(job.tracks.t1?.text).toBe("short");
    expect(job.tracks.t1?.sentTextLength).toBe(10_000);
  });

  it("ignores events whose id does not advance", () => {
    let job = createEmptyJob("tenant-1", "job-1", 1_000);
    job = applyEvent(job, makeEvent(5, "track:text", { trackId: "t1", text: "once" }));
    const replayed = applyEvent(job, makeEvent(5, "track:text", { trackId: "t1", text: "once" }));
    expect(replayed).toBe(job);
    expect(replayed.tracks.t1?.text).toBe("once");
  });

  it("merges tool call updates by toolCallId", () => {
    let job = createEmptyJob("tenant-1", "job-1", 1_000);
    job = applyEvent(job, makeEvent(1, "track:tool", { trackId: "t1", toolCallId: "c1", title: "Read file", status: "running" }));
    job = applyEvent(job, makeEvent(2, "track:tool", { trackId: "t1", toolCallId: "c1", title: "Read file", status: "done" }));
    job = applyEvent(job, makeEvent(3, "track:tool", { trackId: "t1", title: "Grep", status: "running" }));
    expect(job.tracks.t1?.tools).toHaveLength(2);
    expect(job.tracks.t1?.tools[0]).toMatchObject({ title: "Read file", status: "done" });
    expect(job.tracks.t1?.tools[1]).toMatchObject({ title: "Grep", status: "running" });
  });

  it("finalizes tracks and jobs with status, error, and fallback text", () => {
    let job = createEmptyJob("tenant-1", "job-1", 1_000);
    job = applyEvent(job, makeEvent(1, "track:finalized", { trackId: "t1", status: "done", fallbackText: "final answer" }));
    job = applyEvent(job, makeEvent(2, "job:finalized", { status: "done", finishedAt: 2_000, summary: "All carriers reported." }));
    expect(job.tracks.t1?.status).toBe("done");
    expect(job.tracks.t1?.text).toBe("final answer");
    expect(job.status).toBe("done");
    expect(job.finishedAt).toBe(2_000);
    expect(job.summary).toBe("All carriers reported.");
  });

  it("does not overwrite streamed text with a shorter fallback text", () => {
    let job = createEmptyJob("tenant-1", "job-1", 1_000);
    job = applyEvent(job, makeEvent(1, "track:text", { trackId: "t1", text: "streamed full body" }));
    job = applyEvent(job, makeEvent(2, "track:finalized", { trackId: "t1", status: "done", fallbackText: "fallback" }));
    expect(job.tracks.t1?.text).toBe("streamed full body");
  });

  it("prefers the head-complete fallback body over a truncated delta tail", () => {
    // 잡 이벤트 보존 한도로 prefix 델타가 잘린 스냅샷: 꼬리 조각만 누적된 상태.
    let job = createEmptyJob("tenant-1", "job-1", 1_000);
    job = applyEvent(job, makeEvent(1, "track:text", { trackId: "t1", text: "tail fragment" }));
    job = applyEvent(job, makeEvent(2, "track:finalized", {
      trackId: "t1",
      status: "done",
      fallbackText: "full head-complete body (clamped)",
      fallbackTextLength: 20_000,
    }));
    expect(job.tracks.t1?.text).toBe("full head-complete body (clamped)");
    expect(job.tracks.t1?.sentTextLength).toBe(20_000);
  });

  it("keeps retention clamping visible through fallback length metadata for text and thought", () => {
    let job = createEmptyJob("tenant-1", "job-1", 1_000);
    job = applyEvent(job, makeEvent(1, "track:finalized", {
      trackId: "t1",
      status: "done",
      fallbackText: "clamped text",
      fallbackTextLength: 10_000,
      fallbackThought: "clamped thought",
      fallbackThoughtLength: 9_000,
    }));
    expect(job.tracks.t1?.text).toBe("clamped text");
    expect(job.tracks.t1?.sentTextLength).toBe(10_000);
    expect(job.tracks.t1?.thought).toBe("clamped thought");
    expect(job.tracks.t1?.sentThoughtLength).toBe(9_000);
  });
});

describe("reduceSnapshotJob", () => {
  it("rebuilds a job view from a snapshot event list", () => {
    const job = reduceSnapshotJob("tenant-1", {
      jobId: "job-1",
      status: "active",
      updatedAt: 1_010,
      events: [
        makeEvent(1, "job:registered", { label: "Sweep", tracks: [{ trackId: "t1", displayName: "Claude" }] }),
        makeEvent(2, "track:text", { trackId: "t1", text: "partial" }),
      ],
    });
    expect(job.label).toBe("Sweep");
    expect(job.tracks.t1?.text).toBe("partial");
    expect(job.lastEventId).toBe(2);
  });

  it("trusts the snapshot terminal status when finalize events were truncated", () => {
    const job = reduceSnapshotJob("tenant-1", {
      jobId: "job-1",
      status: "done",
      updatedAt: 1_010,
      events: [makeEvent(1, "track:text", { trackId: "t1", text: "tail" })],
    });
    expect(job.status).toBe("done");
  });
});

describe("notification selectors", () => {
  it("computes no visible sessions outside Operations", () => {
    expect([...computeVisibleSessionIds(makeConsoleSnap({
      operationsViewActive: false,
      activeTerminalSessionId: "session-a",
    }))]).toEqual([]);
  });

  it("treats every canvas operation as hidden so alerts surface regardless of minimized state", () => {
    // canvas 모드는 가시성에 의한 알림 억제를 하지 않는다 — 최소화하지 않은 패널도 ALERTS로 알림이 간다.
    const visible = computeVisibleSessionIds(makeConsoleSnap({ operationsViewActive: true }));
    expect([...visible]).toEqual([]);
  });

  it("splits hidden and visible notifications by session id", () => {
    const sessionA = makeNotification("session-a", "theater-a", 1);
    const sessionB = makeNotification("session-b", "theater-b", 2);

    expect(splitNotificationsByVisibility([sessionA, sessionB], new Set(["session-a"]))).toEqual({
      hidden: [sessionB],
      visible: [sessionA],
    });
  });

  it("groups notifications by Theater and sorts by last raised sequence", () => {
    const groups = groupNotificationsByTheater([
      makeNotification("session-a", "theater-a", 1, 2),
      makeNotification("session-b", "theater-b", 5),
      makeNotification("session-c", "theater-a", 3),
    ]);

    expect(groups.map((group) => [group.theaterId, group.totalCount, group.notifications.map((item) => item.sessionId)])).toEqual([
      ["theater-b", 1, ["session-b"]],
      ["theater-a", 3, ["session-c", "session-a"]],
    ]);
  });

  it("filters notifications by global mute, DND, and Theater mute preferences", () => {
    const notifications = [
      makeNotification("session-a", "theater-a", 1),
      makeNotification("session-b", "theater-b", 2),
    ];
    const base: NotificationPreferences = { globalMute: false, dnd: false, mutedTheaterIds: {} };

    expect(filterByPreferences(notifications, { ...base, globalMute: true })).toEqual([]);
    expect(filterByPreferences(notifications, { ...base, dnd: true })).toEqual([]);
    expect(filterByPreferences(notifications, { ...base, mutedTheaterIds: { "theater-a": true } }).map((item) => item.sessionId)).toEqual(["session-b"]);
  });
});
