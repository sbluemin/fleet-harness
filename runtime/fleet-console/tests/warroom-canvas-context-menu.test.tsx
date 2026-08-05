// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/client/src/plugin-registry.js", () => ({
  usePluginRegistry: () => ({
    plugins: [],
    operationKinds: [{
      pluginId: "test-plugin",
      type: "shell",
      title: "Test",
      render: () => null,
    }],
    settingsSections: [],
    notificationKinds: [],
    railPanels: [],
  }),
}));

import { OperationsCanvas } from "../core/client/src/canvas/canvas.js";
import { loadForTheater, setState as setCanvasState } from "../core/client/src/canvas/canvas-store.js";
import { isTriageDeckMapMode, resetTriageDeckZoomForTests, resetTriageTheater, setTriageActive, setTriageDeckZoom } from "../core/client/src/canvas/triage-store.js";
import type { ConsoleState, OperationNode } from "../core/client/src/types.js";

const THEATER_A = "theater-a";
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
  });
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
      // 소유자가 없는 자리의 실행 대상은 활성 Theater이며, 헤더가 그것을 밝힌다.
      expect(opened?.querySelector(".canvas-context-menu-head-text")?.textContent).toContain("Alpha");
      expect(opened?.querySelector('[data-operation-launch-kind="shell"]')).not.toBeNull();
      act(() => { window.dispatchEvent(new Event("canvas-context-menu-close")); });
      expect(container!.querySelector(".canvas-context-menu")).toBeNull();
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
});

function renderCanvas() {
  act(() => root!.render(createElement(OperationsCanvas, {
    state: STATE,
    catalog: CATALOG,
    canLaunch: true,
    renderKindIcon: () => null,
    onLaunchKind: () => {},
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
  theaters: [{ id: THEATER_A, label: "Alpha" }],
  operations: [OPERATION],
  operationsHydrated: true,
  groups: [],
  activeTheaterId: THEATER_A,
  activeOperationId: OPERATION.id,
  activeOperationAcknowledged: true,
  operationStatus: { [OPERATION.id]: "awaiting" },
  addingTheater: false,
  theaterError: null,
  operationsViewActive: true,
  operationSearchOpen: false,
  operationSearchSeed: null,
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
  codexReader: null,
  codexReaderExpanded: false,
};
