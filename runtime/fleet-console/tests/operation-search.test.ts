import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { buildOperationSearchEntries, filterOperationSearchEntries, groupOperationSearchEntries } from "../core/client/src/operation-search.js";
import type { ConsoleState, OperationNode, TheaterInfo } from "../core/client/src/types.js";

const THEATER_ALPHA: TheaterInfo = { id: "theater-alpha", label: "Alpha Harbor", createdAt: "2026-06-16T00:00:00.000Z", lastOpenedAt: "2026-06-16T00:00:00.000Z", hasWiki: true, activeAdmiralCount: 1 };
const THEATER_BETA: TheaterInfo = { id: "theater-beta", label: "Beta Dock", createdAt: "2026-06-16T00:00:00.000Z", lastOpenedAt: "2026-06-16T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 0 };
const THEATER_GAMMA: TheaterInfo = { id: "theater-gamma", label: "Alpha Harbor", createdAt: "2026-06-16T00:00:00.000Z", lastOpenedAt: "2026-06-16T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 0 };

function makeOperation(id: string, theaterId: string, title: string, pluginId = "agent"): OperationNode {
  return {
    id,
    theaterId,
    type: pluginId,
    pluginId,
    title,
    payload: {},
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
  };
}

function makeState(
  operations: readonly OperationNode[],
  theaters: readonly TheaterInfo[] = [THEATER_ALPHA, THEATER_BETA],
  operationRuntime: Readonly<Record<string, OperationRuntimeState>> = {},
): ConsoleState {
  return {
    connection: "connecting",
    operationRuntimeHydration: "ready",
    operationRuntimeError: null,
    connectionLostAt: null,
    controlHolder: null,
    controlCurtainDismissed: false,
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
    theaters,
    operations,
    operationsHydrated: true,
    groups: [],
    activeTheaterId: "theater-alpha",
    activeOperationId: null,
    activeOperationAcknowledged: true,
    operationRuntime,
    addingTheater: false,
    theaterError: null,
    operationsViewActive: false,
    operationSearchOpen: false,
    operationSearchSeed: null,
    quickLaunchOpen: false,
    quickLaunchPinned: false,
    quickLaunchFocusToggle: 0,
    quickLaunchExpandRequest: 0,
    quickLaunchMentionSeed: null,
    quickLaunchDockSuppressed: false,
    quickLaunchDraft: null,
    quickLaunchDraftAttachments: null,
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
    bootstrapped: false,
    pendingOperationFocus: null,
    keyboardFocusRequest: null,
    pendingSideBarAddTheater: false,
    pendingSideBarTheaterLaunch: null,
    launchMenuRequest: null,
    keyboardShortcutsOpen: false,
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

  it("resolves entry activity: live status wins, restored markers fall back to ended, otherwise idle", () => {
    const entries = buildOperationSearchEntries(makeState([
      makeOperation("op-live", "theater-alpha", "Live"),
      { ...makeOperation("op-restored", "theater-alpha", "Restored"), payload: { resumeAvailable: true } },
      makeOperation("op-plain", "theater-alpha", "Plain"),
    ]));
    const state = makeState([
      makeOperation("op-live", "theater-alpha", "Live"),
      { ...makeOperation("op-restored", "theater-alpha", "Restored"), payload: { resumeAvailable: true } },
      makeOperation("op-plain", "theater-alpha", "Plain"),
    ], undefined, { "op-live": { lifecycle: "live", activity: "running" }, "op-restored": { lifecycle: "live", activity: "awaiting" } });
    const withStatus = buildOperationSearchEntries(state);

    expect(entries.map((entry) => [entry.operationId, entry.activity])).toEqual([
      ["op-live", "idle"],
      ["op-restored", "ended"],
      ["op-plain", "idle"],
    ]);
    expect(withStatus.map((entry) => [entry.operationId, entry.activity])).toEqual([
      ["op-live", "running"],
      ["op-restored", "awaiting"],
      ["op-plain", "idle"],
    ]);
  });

  it("carries operation type and launch provider for the palette mark and meta caption", () => {
    const entries = buildOperationSearchEntries(makeState([
      makeOperation("op-shell", "theater-alpha", "Shell", "shell"),
      { ...makeOperation("op-claude", "theater-alpha", "Agent Run"), payload: { session: { model: "claude-sonnet-5" } } },
      { ...makeOperation("op-codex", "theater-alpha", "Codex Run"), payload: { session: { model: "codex--gpt-5.6-sol" } } },
    ]));

    expect(entries.map((entry) => [entry.operationId, entry.type, entry.launchProvider])).toEqual([
      ["op-shell", "shell", null],
      ["op-claude", "agent", "claude"],
      ["op-codex", "agent", "codex"],
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

describe("activating a rail search result", () => {
  // 팔레트는 activate 뒤에 Operations로 옮긴다. 그 이동이 쿼리를 함께 버리면, activate가
  // 방금 기록한 주소가 지워져 아무 일도 일어나지 않는다 — 실측에서 팔레트로 연 Codex
  // 항목이 그렇게 사라졌다. 경로만 옮기고 주소는 그대로 둬야 한다.
  it("moves to Operations without discarding the address activate just wrote", () => {
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../core/client/src/components/operation-search.tsx"),
      "utf8",
    );
    const activation = source.slice(source.indexOf("const selectRailResult"), source.indexOf("const runCommand"));

    expect(activation).toContain("await result.activate()");
    expect(activation).toContain('pathname: "/operations"');
    expect(activation).toContain("search: window.location.search");
    // 쿼리를 버리는 옛 형태로 되돌아가지 않게 막는다. 부정 정규식은 행 시작에 앵커한다 —
    // 그러지 않으면 이 계약을 설명하는 주석 자신이 걸린다.
    expect(activation).not.toMatch(/^\s*navigate\("\/operations"\);/m);
  });
});
