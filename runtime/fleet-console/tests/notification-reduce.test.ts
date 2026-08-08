import { describe, expect, it } from "vitest";

import {
  computeVisibleOperationIds,
  filterByLiveOperations,
  filterByPreferences,
  groupNotificationsByTheater,
  splitNotificationsByVisibility,
} from "../core/client/src/notification-reduce.js";
import type { ConsoleState, NotificationPreferences, OperationNotification } from "../core/client/src/types.js";


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
    connectionLostAt: null,
    consoleName: "",
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
    operationSearchSeed: null,
    quickLaunchOpen: false,
    quickLaunchDraft: null,
    quickLaunchError: null,
    quickLaunchErrorShortenBy: null,
    pendingQuickLaunch: null,
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
    pendingSideBarAddTheater: false,
    pendingSideBarTheaterLaunch: null,
    launchMenuRequest: null,
    keyboardShortcutsOpen: false,
    operationNotifications: {},
    notificationPreferences: { globalMute: false, dnd: false, mutedTheaterIds: {} },
    ...patch,
    activeOperationAcknowledged: patch.activeOperationAcknowledged ?? true,
    codexReader: patch.codexReader ?? null,
    codexReaderExpanded: patch.codexReaderExpanded ?? false,
  };
}
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
