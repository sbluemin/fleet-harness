import { describe, expect, it } from "vitest";

import { buildOperationSearchEntries, filterOperationSearchEntries, groupOperationSearchEntries } from "../core/client/src/operation-search.js";
import type { ConsoleState, OperationNode, TheaterInfo } from "../core/client/src/types.js";

const THEATER_ALPHA: TheaterInfo = { id: "theater-alpha", label: "Alpha Harbor", createdAt: "2026-06-16T00:00:00.000Z", lastOpenedAt: "2026-06-16T00:00:00.000Z", hasWiki: true, activeAdmiralCount: 1 };
const THEATER_BETA: TheaterInfo = { id: "theater-beta", label: "Beta Dock", createdAt: "2026-06-16T00:00:00.000Z", lastOpenedAt: "2026-06-16T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 0 };
const THEATER_GAMMA: TheaterInfo = { id: "theater-gamma", label: "Alpha Harbor", createdAt: "2026-06-16T00:00:00.000Z", lastOpenedAt: "2026-06-16T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 0 };

function makeOperation(id: string, theaterId: string, title: string, pluginId = "agent"): OperationNode {
  return {
    id,
    theaterId,
    parentId: null,
    type: pluginId,
    pluginId,
    title,
    payload: {},
    geometry: null,
    state: { status: "live" },
    ts: { createdAt: 1, updatedAt: 1 },
  };
}

function makeState(operations: readonly OperationNode[], theaters: readonly TheaterInfo[] = [THEATER_ALPHA, THEATER_BETA]): ConsoleState {
  return {
    connection: "connecting",
    connectionError: null,
    activeTheme: "maritime",
    version: "1.8.0",
    updateAvailable: false,
    latestVersion: null,
    portMode: "dynamic",
    requestedPort: null,
    effectivePort: 0,
    portHonored: true,
    theaters,
    operations,
    operationsHydrated: true,
    activeTheaterId: "theater-alpha",
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
    bootstrapped: false,
    pendingOperationFocus: null,
    operationNotifications: {},
    notificationPreferences: { globalMute: false, dnd: false, mutedTheaterIds: {} },
    codexReader: null,
    codexReaderExpanded: false,
  };
}

describe("operation search", () => {
  it("builds entries across all Theaters in operation order", () => {
    const entries = buildOperationSearchEntries(makeState([
      makeOperation("operation-a", "theater-alpha", "Bridge Watch", "agent"),
      makeOperation("operation-b", "theater-beta", "Cargo Sweep", "shell"),
      makeOperation("operation-c", "theater-race", "Night Watch", "agent"),
    ]));

    expect(entries.map((entry) => [entry.operationId, entry.theaterLabel, entry.operationName, entry.pluginId])).toEqual([
      ["operation-a", "Alpha Harbor", "Bridge Watch", "agent"],
      ["operation-b", "Beta Dock", "Cargo Sweep", "shell"],
      ["operation-c", "theater-race", "Night Watch", "agent"],
    ]);
  });

  it("matches case-insensitive AND tokens across operation, Theater, and plugin labels", () => {
    const entries = buildOperationSearchEntries(makeState([
      makeOperation("operation-a", "theater-alpha", "Bridge Watch", "agent"),
      makeOperation("operation-b", "theater-beta", "Cargo Sweep", "shell"),
    ]));

    expect(filterOperationSearchEntries(entries, "bridge agent").map((entry) => entry.operationId)).toEqual(["operation-a"]);
    expect(filterOperationSearchEntries(entries, "BETA shell").map((entry) => entry.operationId)).toEqual(["operation-b"]);
    expect(filterOperationSearchEntries(entries, "bridge shell")).toEqual([]);
    expect(filterOperationSearchEntries(entries, "")).toEqual(entries);
  });

  it("groups filtered entries by Theater id without merging duplicate labels", () => {
    const entries = buildOperationSearchEntries(makeState([
      makeOperation("operation-a", "theater-alpha", "Bridge Watch"),
      makeOperation("operation-b", "theater-beta", "Cargo Sweep"),
      makeOperation("operation-c", "theater-alpha", "Anchor Prep"),
      makeOperation("operation-d", "theater-gamma", "Night Watch"),
    ], [THEATER_ALPHA, THEATER_BETA, THEATER_GAMMA]));

    expect(groupOperationSearchEntries(entries).map((group) => [group.theaterId, group.theaterLabel, group.entries.map((entry) => entry.operationName)])).toEqual([
      ["theater-alpha", "Alpha Harbor", ["Bridge Watch", "Anchor Prep"]],
      ["theater-beta", "Beta Dock", ["Cargo Sweep"]],
      ["theater-gamma", "Alpha Harbor", ["Night Watch"]],
    ]);
  });
});
