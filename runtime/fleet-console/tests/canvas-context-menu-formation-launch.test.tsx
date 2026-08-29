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
import { clearFormationView, loadForTheater, setState as setCanvasState, toggleFormationView } from "../core/client/src/canvas/canvas-store.js";
import type { ConsoleState, OperationNode } from "../core/client/src/types.js";

const THEATER = "theater-a";
const OPERATION: OperationNode = {
  id: "operation-a",
  theaterId: THEATER,
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
  loadForTheater(THEATER);
  setCanvasState({
    viewport: { x: 0, y: 0, zoom: 1 },
    operations: { [OPERATION.id]: OPERATION.geometry! },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  clearFormationView(THEATER);
  loadForTheater(null);
  container?.remove();
  root = null;
  container = null;
});

describe("canvas controls launch parity across canvas modes", () => {
  // Formation은 캔버스 제스처(팬·줌·드래그 생성)를 막는 모드지 실행을 막는 모드가 아니다 —
  // 같은 catalog가 사이드바와 좌하단 런처에서는 계속 실행되므로, 우클릭에서만 죽으면
  // 사용자에게는 "메뉴는 열리는데 전부 회색"이라는 원인 없는 고장으로만 보인다.
  it("keeps launch kinds enabled in Formation view", () => {
    renderCanvas();
    act(() => toggleFormationView());
    expect(container!.querySelector("main.operations-canvas")?.className).toContain("is-formation-view");

    const canvas = container!.querySelector<HTMLElement>("main.operations-canvas")!;
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 240 });
    act(() => canvas.dispatchEvent(menu));
    expect(menu.defaultPrevented).toBe(true);

    const item = container!.querySelector<HTMLButtonElement>('[data-operation-launch-kind="shell"]');
    expect(item).not.toBeNull();
    expect(item!.disabled).toBe(false);
    act(() => { window.dispatchEvent(new Event("canvas-context-menu-close")); });
  });

  it("launches at the cursor from Formation view", () => {
    const launches: string[] = [];
    renderCanvas({ onLaunchKind: (pluginId, kind) => launches.push(`${pluginId}:${kind.id}`) });
    act(() => toggleFormationView());

    const canvas = container!.querySelector<HTMLElement>("main.operations-canvas")!;
    act(() => canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 240 })));
    act(() => container!.querySelector<HTMLButtonElement>('[data-operation-launch-kind="shell"]')!.click());

    expect(launches).toEqual(["test-plugin:shell"]);
  });

  it("still disables launch kinds when no Theater owns the launch", () => {
    // 모드가 아니라 Theater가 실행 가부를 정한다는 반대 방향 — 게이트 제거가 canLaunch까지
    // 지워버리면 이 단언이 먼저 무너진다.
    renderCanvas({ canLaunch: false });
    act(() => toggleFormationView());

    const canvas = container!.querySelector<HTMLElement>("main.operations-canvas")!;
    act(() => canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 240 })));

    const item = container!.querySelector<HTMLButtonElement>('[data-operation-launch-kind="shell"]');
    expect(item).not.toBeNull();
    expect(item!.disabled).toBe(true);
    act(() => { window.dispatchEvent(new Event("canvas-context-menu-close")); });
  });

  it("opens nothing when no Theater is registered", () => {
    // 실행 대상이 없으면 메뉴를 띄워도 고를 자리가 없다 — 브라우저 메뉴만 막고 상자는 열지 않는다.
    // canLaunch:false + Theater가 있는 위 경우와 반대: 거기는 항목을 회색으로 남기고, 여기는 상자 자체다.
    renderCanvas({
      state: { ...STATE, theaters: [], operations: [], activeTheaterId: null, activeOperationId: null },
      canLaunch: false,
    });

    const canvas = container!.querySelector<HTMLElement>("main.operations-canvas")!;
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 240 });
    act(() => canvas.dispatchEvent(menu));

    expect(menu.defaultPrevented).toBe(true);
    expect(container!.querySelector(".canvas-context-menu")).toBeNull();
  });

  it("closes an already-open launcher when the last Theater disappears", () => {
    renderCanvas();
    const canvas = container!.querySelector<HTMLElement>("main.operations-canvas")!;
    act(() => canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 240 })));
    expect(container!.querySelector(".canvas-context-menu")).not.toBeNull();

    renderCanvas({
      state: { ...STATE, theaters: [], operations: [], activeTheaterId: null, activeOperationId: null },
      canLaunch: false,
    });
    expect(container!.querySelector(".canvas-context-menu")).toBeNull();
  });
});

function renderCanvas(overrides: Partial<Parameters<typeof OperationsCanvas>[0]> = {}) {
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
  theaters: [{ id: THEATER, label: "Alpha" }],
  operations: [OPERATION],
  operationsHydrated: true,
  groups: [],
  activeTheaterId: THEATER,
  activeOperationId: OPERATION.id,
  activeOperationAcknowledged: true,
  operationRuntime: { [OPERATION.id]: { lifecycle: "live", activity: "awaiting" } },
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
