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
import { getTheaterCanvasSnapshot, loadForTheater, setState as setCanvasState } from "../core/client/src/canvas/canvas-store.js";
import { getIdleArrivalIds, markIdleArrival, resetIdleArrivalForTests } from "../core/client/src/operation-marks.js";
import { isTriageDeckMapMode, resetTriageDeckZoomForTests, resetTriageTheater, setTriageActive, setTriageDeckZoom } from "../core/client/src/canvas/triage-store.js";
import { getState, setActiveOperation, setState as setConsoleState } from "../core/client/src/store.js";
import type { ConsoleState, OperationNode } from "../core/client/src/types.js";

type OperationsCanvasLaunchKind = Parameters<typeof OperationsCanvas>[0]["onLaunchKind"];

const THEATER_A = "theater-a";
// War Room은 전 Theater를 한 판에 얹는다 — 밴드가 자기 Theater를 소유하는지는 활성 Theater가
// 아닌 밴드에서만 드러난다. 두 밴드가 같은 이름이면 밴드 소유와 캔버스 폴백이 구별되지 않는다.
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
  setTriageActive(true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  resetTriageDeckZoomForTests();
  setTriageActive(false);
  resetTriageTheater(THEATER_A);
  resetTriageTheater(THEATER_B);
  loadForTheater(null);
  container?.remove();
  root = null;
  container = null;
});

describe("War Room canvas controls reach", () => {
  it("opens canvas controls on unowned canvas space at every deck density", () => {
    renderCanvas();
    const canvas = container!.querySelector<HTMLElement>("main.operations-canvas")!;
    // 밀도 칩이 순환시키는 실제 프리셋 전부. 0.4만 지도로 넘어가고 1.0/1.6은 카드다 —
    // 카드 밀도에서 Theater를 소유한 표면은 밴드 헤더 한 줄뿐이라, 판 바닥이 아무것도 열지 않으면
    // 실행 진입점이 밀도에 따라 사라진다.
    expect([1.0, 1.6].map(isTriageDeckMapMode)).toEqual([false, false]);
    expect(isTriageDeckMapMode(0.4)).toBe(true);

    for (const zoom of [1.0, 1.6, 0.4]) {
      act(() => setTriageDeckZoom(zoom));
      const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 240 });
      act(() => canvas.dispatchEvent(menu));
      expect(menu.defaultPrevented).toBe(true);
      const opened = container!.querySelector(".canvas-context-menu");
      expect(opened, `deck zoom ${zoom}`).not.toBeNull();
      // 시각 헤더 없이도 메뉴 역할은 접근 이름으로 유지한다.
      expect(opened?.getAttribute("aria-label")).toBe("Operation launcher");
      expect(opened?.querySelector(".canvas-context-menu-head")).toBeNull();
      expect(opened?.querySelector('[data-operation-launch-kind="shell"]')).not.toBeNull();
      act(() => { window.dispatchEvent(new Event("canvas-context-menu-close")); });
      expect(container!.querySelector(".canvas-context-menu")).toBeNull();
    }
  });

  // 위 경우는 <main>에 직접 이벤트를 놓는다 — 진입 커튼(1.9초) 동안에는 덱이 아예 렌더되지 않으므로
  // 그때의 <main>은 맨바닥이고, 실제 제품에서 커서가 닿는 표면은 그 판을 덮은 덱이다. 커튼을 걷어
  // 덱을 세운 뒤 덱 자신의 빈 자리에서 우클릭해야 "밀도가 실행 진입점을 없애지 않는다"가 검증된다.
  it("reaches canvas controls from the deck's own empty space once the entry curtain lifts", () => {
    vi.useFakeTimers();
    const onLaunchKind = vi.fn();
    try {
      renderCanvas(onLaunchKind);
      // 진입 커튼이 걷혀야 덱이 선다(커튼 중에는 TriageWatchDeck이 null을 낸다).
      act(() => { vi.advanceTimersByTime(2_000); });

      const deck = container!.querySelector<HTMLElement>(".canvas-triage-deck");
      expect(deck, "deck must be mounted once the curtain lifts").not.toBeNull();

      for (const zoom of [1.0, 1.6]) {
        act(() => setTriageDeckZoom(zoom));
        // 밴드 사이 여백·판 바닥은 덱이 덮은 자리지만 주인이 없다 — 여기서 시작한 우클릭이
        // 캔버스까지 버블해 캔버스 제어를 열어야 한다.
        const grid = container!.querySelector<HTMLElement>(".canvas-triage-deck-grid")!;
        const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 240 });
        act(() => grid.dispatchEvent(menu));
        expect(menu.defaultPrevented, `deck zoom ${zoom}`).toBe(true);
        const opened = container!.querySelector(".canvas-context-menu");
        expect(opened, `deck zoom ${zoom}`).not.toBeNull();
        expect(opened?.querySelector('[data-operation-launch-kind="shell"]')).not.toBeNull();
        act(() => { window.dispatchEvent(new Event("canvas-context-menu-close")); });
      }

      // 밴드는 자기 Theater를 소유한다 — 활성 Theater(Alpha)가 아닌 밴드에서 열어야 그 소유가
      // 드러난다. Alpha 밴드에서 재면 밴드가 핸들러를 잃어도 캔버스 폴백이 같은 Alpha를 띄워
      // 통과하므로, 엉뚱한 Theater로 실행되는 회귀를 이 단언이 못 잡는다.
      act(() => setTriageDeckZoom(1.0));
      const bands = [...container!.querySelectorAll<HTMLElement>(".canvas-triage-deck-band")];
      expect(bands.length, "card density must render one band per theater").toBe(2);
      const betaBand = bands.find((candidate) =>
        candidate.querySelector(".canvas-triage-deck-band-label")?.textContent === "Beta");
      expect(betaBand, "the non-active Theater must own its own band").not.toBeUndefined();
      const bandMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 140, clientY: 260 });
      act(() => betaBand!.dispatchEvent(bandMenu));
      expect(bandMenu.defaultPrevented).toBe(true);
      // 소유는 머리글 문구가 아니라 실행이 향하는 Theater로 재야 한다 — 상자 이름은 어디서 열든
      // 같은 문자열이고, 그 이름을 재는 것은 소유가 아니라 라벨을 재는 것이다.
      act(() => container!.querySelector<HTMLButtonElement>('[data-operation-launch-kind="shell"]')!.click());
      expect(onLaunchKind).toHaveBeenCalledTimes(1);
      expect(onLaunchKind.mock.calls[0]![3]).toBe(THEATER_B);
    } finally {
      act(() => { window.dispatchEvent(new Event("canvas-context-menu-close")); });
      vi.useRealTimers();
    }
  });

  it("opens nothing when no Theater owns the launch", () => {
    // 실행 대상이 없으면 메뉴를 띄워도 아무것도 실행할 수 없다 — 브라우저 메뉴만 계속 막는다.
    act(() => root!.render(createElement(OperationsCanvas, {
      state: { ...STATE, theaters: [], operations: [], activeTheaterId: null, activeOperationId: null },
      catalog: CATALOG,
      canLaunch: false,
      renderKindIcon: () => null,
      onLaunchKind: () => {},
      onLaunchAtGeometry: () => {},
      onClose: () => {},
      onFocus: () => {},
      onRename: () => {},
      onSetAccent: () => {},
    })));

    const canvas = container!.querySelector<HTMLElement>("main.operations-canvas")!;
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 240 });
    act(() => canvas.dispatchEvent(menu));
    expect(menu.defaultPrevented).toBe(true);
    expect(container!.querySelector(".canvas-context-menu")).toBeNull();
  });

  it("keeps the browser menu inside Operation panels", () => {
    renderCanvas();

    const panel = container!.querySelector<HTMLElement>("[data-canvas-operation]");
    expect(panel).not.toBeNull();
    const panelMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 });
    act(() => panel!.dispatchEvent(panelMenu));
    // 터미널 안은 복사·붙여넣기가 있는 자리다 — 우리 메뉴가 그것을 빼앗지 않는다.
    expect(panelMenu.defaultPrevented).toBe(false);
    expect(container!.querySelector(".canvas-context-menu")).toBeNull();
  });

  it("acknowledges an unseen idle arrival when its War Room stage is minimized", () => {
    vi.useFakeTimers();
    try {
      markIdleArrival(OPERATION.id);
      renderCanvas();
      act(() => { vi.advanceTimersByTime(2_000); });

      const stage = container!.querySelector<HTMLElement>(`.canvas-operation[data-operation-id="${OPERATION.id}"]`);
      expect(stage).not.toBeNull();
      act(() => stage!.querySelector<HTMLButtonElement>(".canvas-operation-window-controls .canvas-operation-icon-button")!.click());

      expect(getTheaterCanvasSnapshot(THEATER_A).minimized).toContain(OPERATION.id);
      expect(getIdleArrivalIds().has(OPERATION.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("War Room empty space releases a focused deck panel", () => {
  const idleState: ConsoleState = {
    ...STATE,
    operationRuntime: {
      [OPERATION.id]: { lifecycle: "live", activity: "idle" },
      [OPERATION_B.id]: { lifecycle: "live", activity: "idle" },
    },
  };

  it("clears store activation from the deck grid without staging the focused panel", () => {
    vi.useFakeTimers();
    try {
      act(() => {
        setConsoleState({ activeOperationId: OPERATION.id, activeOperationAcknowledged: true });
        root!.render(createElement(OperationsCanvas, {
          state: idleState,
          catalog: CATALOG,
          canLaunch: true,
          renderKindIcon: () => null,
          onLaunchKind: () => {},
          onLaunchAtGeometry: () => {},
          onClose: () => {},
          onFocus: () => {},
          onRename: () => {},
          onSetAccent: () => {},
        }));
      });
      act(() => { vi.advanceTimersByTime(2_000); });

      expect(container!.querySelector(".canvas-operation.is-triage-stage")).toBeNull();
      expect(getState().activeOperationId).toBe(OPERATION.id);

      const grid = container!.querySelector<HTMLElement>(".canvas-triage-deck-grid");
      expect(grid, "idle fleet must keep the deck mounted").not.toBeNull();
      grid!.tabIndex = -1;
      act(() => { grid!.focus(); });
      expect(document.activeElement).toBe(grid);
      act(() => grid!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })));
      expect(getState().activeOperationId).toBeNull();
      expect(document.activeElement === grid).toBe(false);
      expect(container!.querySelector(".canvas-operation.is-triage-stage")).toBeNull();
    } finally {
      act(() => { setActiveOperation(null); });
      vi.useRealTimers();
    }
  });

  it("does not clear activation when the pointer lands on a deck card", () => {
    vi.useFakeTimers();
    try {
      act(() => {
        setConsoleState({ activeOperationId: OPERATION.id, activeOperationAcknowledged: true });
        root!.render(createElement(OperationsCanvas, {
          state: idleState,
          catalog: CATALOG,
          canLaunch: true,
          renderKindIcon: () => null,
          onLaunchKind: () => {},
          onLaunchAtGeometry: () => {},
          onClose: () => {},
          onFocus: () => {},
          onRename: () => {},
          onSetAccent: () => {},
        }));
      });
      act(() => { vi.advanceTimersByTime(2_000); });

      const card = container!.querySelector<HTMLElement>(`[data-triage-deck-card="${OPERATION.id}"]`);
      expect(card).not.toBeNull();
      act(() => card!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })));
      expect(getState().activeOperationId).toBe(OPERATION.id);
    } finally {
      act(() => { setActiveOperation(null); });
      vi.useRealTimers();
    }
  });

  it("does not clear activation on a non-primary empty-space click", () => {
    vi.useFakeTimers();
    try {
      act(() => {
        setConsoleState({ activeOperationId: OPERATION.id, activeOperationAcknowledged: true });
        root!.render(createElement(OperationsCanvas, {
          state: idleState,
          catalog: CATALOG,
          canLaunch: true,
          renderKindIcon: () => null,
          onLaunchKind: () => {},
          onLaunchAtGeometry: () => {},
          onClose: () => {},
          onFocus: () => {},
          onRename: () => {},
          onSetAccent: () => {},
        }));
      });
      act(() => { vi.advanceTimersByTime(2_000); });

      const grid = container!.querySelector<HTMLElement>(".canvas-triage-deck-grid");
      expect(grid).not.toBeNull();
      act(() => grid!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 2 })));
      expect(getState().activeOperationId).toBe(OPERATION.id);
    } finally {
      act(() => { setActiveOperation(null); });
      vi.useRealTimers();
    }
  });
});

function renderCanvas(onLaunchKind: OperationsCanvasLaunchKind = () => {}) {
  act(() => root!.render(createElement(OperationsCanvas, {
    state: STATE,
    catalog: CATALOG,
    canLaunch: true,
    renderKindIcon: () => null,
    onLaunchKind,
    onLaunchAtGeometry: () => {},
    onClose: () => {},
    onFocus: () => {},
    onRename: () => {},
    onSetAccent: () => {},
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
  operationRuntime: { [OPERATION.id]: { lifecycle: "live", activity: "awaiting" }, [OPERATION_B.id]: { lifecycle: "live", activity: "awaiting" } },
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
