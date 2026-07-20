import { describe, expect, it } from "vitest";

import {
  applyEvent,
  createEmptyJob,
  reduceSnapshotJob,
} from "../../fleet-plugins/terminal/client/agent/reduce.js";
import {
  computeVisibleOperationIds,
  filterByLiveOperations,
  filterByPreferences,
  groupNotificationsByTheater,
  splitNotificationsByVisibility,
} from "../core/client/src/notification-reduce.js";
import type { ObservedEvent } from "../../fleet-plugins/terminal/client/agent/types.js";
import type { ConsoleState, NotificationPreferences, OperationNotification } from "../core/client/src/types.js";

function makeEvent(id: number, type: string, event: Record<string, unknown>, jobId = "job-1"): ObservedEvent {
  return { id, tenantId: "tenant-1", jobId, type, at: 1_000 + id, event: { type, jobId, ...event } };
}

function makeNotification(
  operationId: string,
  theaterId: string | null,
  lastRaisedSeq: number,
): OperationNotification {
  return {
    kind: "input-waiting",
    operationId,
    theaterId,
    theaterLabel: theaterId ?? "Unknown",
    operationLabel: operationId,
    lastRaisedSeq,
  };
}

function makeConsoleSnap(patch: Partial<ConsoleState> = {}): ConsoleState {
  return {
    connection: "live",
    connectionError: null,
    channel: "unknown",
    activeTheme: "maritime",
    version: "1.8.0",
    updateAvailable: false,
    latestVersion: null,
    portMode: "dynamic",
    requestedPort: null,
    effectivePort: 0,
    portHonored: true,
    theaters: [],
    operations: [],
    operationsHydrated: true,
    groups: [],
    activeTheaterId: null,
    activeOperationId: null,
    operationStatus: {},
    addingTheater: false,
    theaterError: null,
    operationsViewActive: false,
    operationSearchOpen: false,
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
    pendingOperationFocus: null,
    keyboardFocusRequest: null,
    operationNotifications: {},
    notificationPreferences: { globalMute: false, dnd: false, mutedTheaterIds: {} },
    ...patch,
    codexReader: patch.codexReader ?? null,
    codexReaderExpanded: patch.codexReaderExpanded ?? false,
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
    job = applyEvent(job, makeEvent(1, "track:tool", { trackId: "t1", toolId: "c1", name: "Read file", status: "running" }));
    job = applyEvent(job, makeEvent(2, "track:tool", { trackId: "t1", toolId: "c1", name: "Read file", status: "done" }));
    job = applyEvent(job, makeEvent(3, "track:tool", { trackId: "t1", toolId: "c2", name: "Grep", status: "running" }));
    expect(job.tracks.t1?.tools).toHaveLength(2);
    expect(job.tracks.t1?.tools[0]).toMatchObject({ name: "Read file", status: "done" });
    expect(job.tracks.t1?.tools[1]).toMatchObject({ name: "Grep", status: "running" });
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
  it("computes no visible operations outside Operations", () => {
    expect([...computeVisibleOperationIds(makeConsoleSnap({
      operationsViewActive: false,
    }))]).toEqual([]);
  });

  it("computes only the active operation as visible while Operations is mounted", () => {
    const visible = computeVisibleOperationIds(makeConsoleSnap({
      operationsViewActive: true,
      activeTheaterId: "theater-a",
      activeOperationId: "operation-a",
      operations: [
        {
          id: "operation-a",
          theaterId: "theater-a",
          type: "shell",
          pluginId: "terminal",
          title: "Shell",
          payload: {},
          geometry: null,
          ts: { createdAt: 1, updatedAt: 1 },
        },
        {
          id: "operation-b",
          theaterId: "theater-b",
          type: "shell",
          pluginId: "terminal",
          title: "Shell",
          payload: {},
          geometry: null,
          ts: { createdAt: 1, updatedAt: 1 },
        },
      ],
    }));
    // active 패널만 visible — 같은/다른 Theater의 비active 패널은 ALERTS로 노출되도록 hidden 처리한다.
    expect([...visible]).toEqual(["operation-a"]);
  });

  it("computes no visible operations when no operation is active", () => {
    expect([...computeVisibleOperationIds(makeConsoleSnap({
      operationsViewActive: true,
      activeOperationId: null,
      operations: [{
        id: "operation-a",
        theaterId: "theater-a",
        type: "shell",
        pluginId: "terminal",
        title: "Shell",
        payload: {},
        geometry: null,
        ts: { createdAt: 1, updatedAt: 1 },
      }],
    }))]).toEqual([]);
  });

  it("treats a stale active operation in another Theater as not visible", () => {
    const op = (id: string, theaterId: string) => ({
      id,
      theaterId,
      type: "shell",
      pluginId: "terminal",
      title: "Shell",
      payload: {},
      geometry: null,
      ts: { createdAt: 1, updatedAt: 1 },
    });
    // Theater 전환 후 activeOperationId가 이전 Theater 패널을 가리키면(stale) 보임이 아니라 알림으로 노출되어야 한다.
    expect([...computeVisibleOperationIds(makeConsoleSnap({
      operationsViewActive: true,
      activeTheaterId: "theater-a",
      activeOperationId: "operation-b",
      operations: [op("operation-a", "theater-a"), op("operation-b", "theater-b")],
    }))]).toEqual([]);
  });

  it("treats a closed active operation as not visible", () => {
    expect([...computeVisibleOperationIds(makeConsoleSnap({
      operationsViewActive: true,
      activeTheaterId: "theater-a",
      activeOperationId: "ghost",
      operations: [],
    }))]).toEqual([]);
  });

  it("drops notifications for operations that no longer exist", () => {
    const live = makeNotification("operation-a", "theater-a", 1);
    const closed = makeNotification("operation-ghost", "theater-a", 2);
    expect(filterByLiveOperations([live, closed], [{ id: "operation-a" }])).toEqual([live]);
  });

  it("splits hidden and visible notifications by operation id", () => {
    const operationA = makeNotification("operation-a", "theater-a", 1);
    const operationB = makeNotification("operation-b", "theater-b", 2);

    expect(splitNotificationsByVisibility([operationA, operationB], new Set(["operation-a"]))).toEqual({
      hidden: [operationB],
      visible: [operationA],
    });
  });

  it("groups notifications by Theater and sorts by last raised sequence", () => {
    const groups = groupNotificationsByTheater([
      makeNotification("session-a", "theater-a", 1),
      makeNotification("session-b", "theater-b", 5),
      makeNotification("session-c", "theater-a", 3),
    ]);

    expect(groups.map((group) => [group.theaterId, group.notifications.map((item) => item.operationId)])).toEqual([
      ["theater-b", ["session-b"]],
      ["theater-a", ["session-c", "session-a"]],
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
    expect(filterByPreferences(notifications, { ...base, mutedTheaterIds: { "theater-a": true } }).map((item) => item.operationId)).toEqual(["session-b"]);
  });
});
