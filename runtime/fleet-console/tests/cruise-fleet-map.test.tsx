// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/client/src/plugin-registry.js", () => ({ useExpandedSurfaceDescriptors: () => new Map(),
  usePluginRegistry: () => ({
    plugins: [],
    operationKinds: [{
      pluginId: "test-plugin",
      type: "shell",
      title: "Test",
      render: () => null,
    }],
    failures: [],
    settingsSections: [],
    notificationKinds: [],
    railPanels: [],
  }),
}));

import { OperationsCanvas } from "../core/client/src/canvas/canvas.js";
import { clearMaximizedOperationId, loadForTheater, setMaximizedOperationId, setState as setCanvasState, setViewport } from "../core/client/src/canvas/canvas-store.js";
import { resetIdleArrivalForTests } from "../core/client/src/operation-marks.js";
import { claimTheaterBootMinimization, resetBootMinimizationSession } from "../core/client/src/boot-minimization-session.js";
import { getState } from "../core/client/src/store.js";
import { resetTriageTheater, setTriageActive } from "../core/client/src/canvas/triage-store.js";
import type { ConsoleState, OperationNode } from "../core/client/src/types.js";

const THEATER_A = "theater-a";
const THEATER_B = "theater-b";
const OPERATION: OperationNode = {
  id: "operation-a",
  theaterId: THEATER_A,
  type: "shell",
  pluginId: "test-plugin",
  title: "Operation A",
  payload: {},
  geometry: { x: 0, y: 0, width: 320, height: 200, zIndex: 1 },
  ts: { createdAt: 0, updatedAt: 0 },
};
const OPERATION_B: OperationNode = {
  ...OPERATION,
  id: "operation-b",
  theaterId: THEATER_B,
  title: "Operation B",
  geometry: { x: 600, y: 300, width: 320, height: 200, zIndex: 1 },
};
const CATALOG = [{ id: "test-plugin", title: "Test", kinds: [{ id: "shell", type: "shell", title: "Shell" }] }];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  loadForTheater(THEATER_A);
  setCanvasState({
    viewport: { x: 0, y: 0, zoom: 1 },
    operations: { [OPERATION.id]: OPERATION.geometry! },
    minimized: [],
  });
  resetIdleArrivalForTests();
  resetBootMinimizationSession();
  setTriageActive(false);
  clearMaximizedOperationId();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  vi.useRealTimers();
  setTriageActive(false);
  clearMaximizedOperationId();
  resetTriageTheater(THEATER_A);
  resetTriageTheater(THEATER_B);
  loadForTheater(null);
  container?.remove();
  root = null;
  container = null;
});

const fleetMap = () => container!.querySelector<HTMLElement>(".canvas-fleet-map");
const canvas = () => container!.querySelector<HTMLElement>("main.operations-canvas")!;

describe("Cruise fleet map", () => {
  it("stands the fleet map once the canvas zooms below the readability floor and takes it down past the exit threshold", () => {
    vi.useFakeTimers();
    renderCanvas();
    expect(fleetMap()).toBeNull();
    expect(canvas().classList.contains("is-fleet-map")).toBe(false);

    // 0.22는 진입 임계(0.2) 위다 — 아직 패널의 자리다.
    act(() => setViewport({ x: 0, y: 0, zoom: 0.22 }));
    expect(fleetMap()).toBeNull();

    act(() => setViewport({ x: 0, y: 0, zoom: 0.15 }));
    const plate = fleetMap();
    expect(plate).not.toBeNull();
    expect(plate?.classList.contains("is-leaving")).toBe(false);
    // 월드는 mount를 유지한 채 클래스로만 물러난다 — 패널 body·PTY는 그대로다.
    expect(canvas().classList.contains("is-fleet-map")).toBe(true);
    expect(container!.querySelector(".operations-canvas-world")).not.toBeNull();
    expect(container!.querySelectorAll("[data-canvas-operation]").length).toBeGreaterThan(0);
    // 전 Theater가 한 판에 오른다 — 활성 Theater 밖 Operation도 점이다.
    expect(container!.querySelectorAll(".canvas-fleet-map-zone")).toHaveLength(2);
    expect(container!.querySelectorAll("[data-fleet-map-dot]")).toHaveLength(2);

    // 히스테리시스 — 진입 임계 위지만 이탈 임계(0.24) 아래에서는 판이 붙어 있다.
    act(() => setViewport({ x: 0, y: 0, zoom: 0.22 }));
    expect(fleetMap()?.classList.contains("is-leaving")).toBe(false);

    act(() => setViewport({ x: 0, y: 0, zoom: 0.3 }));
    // 퇴장은 한 박자 남는다 — 판정은 즉시 꺼지고 판만 퇴장 연출 동안 머문다.
    expect(canvas().classList.contains("is-fleet-map")).toBe(false);
    expect(fleetMap()?.classList.contains("is-leaving")).toBe(true);
    act(() => { vi.advanceTimersByTime(400); });
    expect(fleetMap()).toBeNull();
  });

  it("hands a picked dot to the focus route, which owns the theater switch and the zoom back", () => {
    const onFocus = vi.fn();
    renderCanvas({ onFocus });
    act(() => setViewport({ x: 0, y: 0, zoom: 0.1 }));
    const dot = container!.querySelector<HTMLButtonElement>('[data-fleet-map-dot="operation-b"]')!;
    act(() => { dot.click(); });
    expect(onFocus).toHaveBeenCalledWith("operation-b");
  });

  it("mounts a theater from its nameplate without folding the panels the map just showed", () => {
    renderCanvas();
    act(() => setViewport({ x: 0, y: 0, zoom: 0.1 }));
    const pick = container!.querySelector<HTMLButtonElement>('[data-fleet-map-zone-pick="theater-b"]')!;
    act(() => { pick.click(); });
    expect(getState().activeTheaterId).toBe(THEATER_B);
    // 부팅 최소화의 "처음 여는 한 번"은 표석 클릭이 소비했다 — 페이지 effect는 접을 목록을 받지 못한다.
    expect(claimTheaterBootMinimization(THEATER_B)).toBe(false);
  });

  it("never stands under War Room or a maximized panel, whatever the zoom", () => {
    vi.useFakeTimers();
    renderCanvas();
    act(() => setViewport({ x: 0, y: 0, zoom: 0.1 }));
    expect(fleetMap()).not.toBeNull();

    // 포커스 층은 자기 기하를 쓴다 — 판정은 즉시 꺼지고 판은 퇴장 연출 뒤 사라진다.
    act(() => setMaximizedOperationId(OPERATION.id));
    expect(canvas().classList.contains("is-fleet-map")).toBe(false);
    act(() => { vi.advanceTimersByTime(400); });
    expect(fleetMap()).toBeNull();
    act(() => clearMaximizedOperationId());
    expect(fleetMap()).not.toBeNull();

    act(() => setTriageActive(true));
    expect(canvas().classList.contains("is-fleet-map")).toBe(false);
    act(() => { vi.advanceTimersByTime(400); });
    expect(fleetMap()).toBeNull();
    act(() => setTriageActive(false));
    expect(fleetMap()).not.toBeNull();
  });
});

function renderCanvas(overrides: Partial<Parameters<typeof OperationsCanvas>[0]> = {}) {
  act(() => root!.render(createElement(OperationsCanvas, {
    arenaInsets: { left: 0, top: 0, right: 0, bottom: 0 },
    state: STATE,
    catalog: CATALOG,
    canLaunch: true,
    renderKindIcon: () => null,
    onLaunchKind: () => {},
    onLaunchAtGeometry: () => {},
    onClose: () => {},
    onFocus: () => {},
    onOpenAll: () => {},
    onRename: () => {},
    ...overrides,
  })));
}

const STATE: ConsoleState = {
  connection: "connecting",
  connectionLostAt: null,
  channel: "unknown",
  activeTheme: "maritime",
  version: "test",
  updateAvailable: false,
  latestVersion: null,
  portMode: "dynamic",
  requestedPort: null,
  effectivePort: 0,
  portHonored: true,
  theaters: [{ id: THEATER_A, label: "Alpha" }, { id: THEATER_B, label: "Beta" }],
  operations: [OPERATION, OPERATION_B],
  operationsHydrated: true,
  groups: [],
  activeTheaterId: THEATER_A,
  activeOperationId: OPERATION.id,
  activeOperationAcknowledged: true,
  operationRuntime: { [OPERATION.id]: { lifecycle: "live", activity: "running" }, [OPERATION_B.id]: { lifecycle: "live", activity: "awaiting" } },
  addingTheater: false,
  theaterError: null,
  operationsViewActive: true,
  operationSearchOpen: false,
  operationSearchSeed: null,
  quickLaunchOpen: false,
  quickLaunchPinned: false,
  quickLaunchFocusToggle: 0,
  quickLaunchExpandRequest: 0,
  quickLaunchDockSuppressed: false,
  quickLaunchDraft: null,
  quickLaunchError: null,
  pendingQuickLaunch: null,
  whatsNewOpen: false,
  releaseNotes: [],
  releaseNotesLocale: null,
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
  codexReader: null,
  codexReaderExpanded: false,
};
