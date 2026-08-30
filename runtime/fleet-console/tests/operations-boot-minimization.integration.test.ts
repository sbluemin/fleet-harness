// @vitest-environment jsdom

import { act, createElement, Fragment, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import type { OperationCatalogPlugin } from "@fleet-console/sdk/operations";
import { fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";
import type { OperationKindDescriptor } from "@fleet-console/sdk/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearCompanionOperationId, clearFormationView, clearMaximizedOperationId, getCompanionOperationId, getFormationView, getMaximizedOperationId, getSnapshot, getTheaterCompanionOperationId, loadForTheater, minimizeOperation, requestFitAllOperations, resetCanvasViewportSize, restoreOperation, setCanvasViewportSize, setCompanionOperationId, setMaximizedOperationId, setOperationGeometry, setStationKeeping, setViewport, subscribe as subscribeCanvas, toggleFormationView } from "../core/client/src/canvas/canvas-store.js";
import { BOOT_MINIMIZATION_STORAGE_KEY, resetBootMinimizationSession } from "../core/client/src/boot-minimization-session.js";
import { CANVAS_MODE_STORAGE_KEY } from "../core/client/src/canvas/canvas-mode-session.js";
import { armTriageSetAside, getTriageSetAsideArmedId, isTriageActive, resetTriageTheater, setTriageActive } from "../core/client/src/canvas/triage-store.js";
import { focusOperation, getState, hydrateOperations, setActiveOperation, setState } from "../core/client/src/store.js";
import type { OperationNode, TheaterBootstrap } from "../core/client/src/types.js";

const apiMocks = vi.hoisted(() => ({
  fetchTheaterBootstrap: vi.fn(),
  fetchTheaters: vi.fn(),
  fetchOperations: vi.fn(),
  fetchGroups: vi.fn(),
  deleteOperation: vi.fn(),
  restoreDeletion: vi.fn(),
}));
const keyboardShortcutMocks = vi.hoisted(() => ({
  shouldHandleOperationsKeyboardShortcut: vi.fn(),
}));
const sideBarMocks = vi.hoisted(() => ({
  onFocus: null as null | ((operationId: string) => void),
  onResume: null as null | ((operationId: string) => void),
  onClose: null as null | ((operationId: string) => void),
  onMinimize: null as null | ((operationId: string) => void),
}));
const canvasMocks = vi.hoisted(() => ({
  catalog: [] as readonly OperationCatalogPlugin[],
  onMount: null as null | (() => void | (() => void)),
  onLaunchAtGeometry: null as null | ((pluginId: string, kind: { readonly type: string; readonly title: string }, geometry: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly zIndex: number }) => void),
  onLaunchKind: null as null | ((pluginId: string, kind: { readonly type: string; readonly title: string }, canvasPoint: { readonly x: number; readonly y: number }, theaterId?: string) => void),
  onRefreshCatalog: null as null | (() => void),
}));
const registryMocks = vi.hoisted(() => ({
  plugins: [] as Array<Record<string, unknown>>,
  operationKinds: [] as OperationKindDescriptor[],
}));
const bodyPoolMocks = vi.hoisted(() => ({
  renderedOperationIds: [] as string[][],
  order: [] as string[],
}));

vi.mock("../core/client/src/api.js", () => ({
  ...apiMocks,
  ApiError: class ApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  addTheater: vi.fn(),
  createGroup: vi.fn(),
  deleteGroup: vi.fn(),
  forgetTheater: vi.fn(),
  issueTheaterFolderGrant: vi.fn(),
  patchOperation: vi.fn(),
  patchTheaterOrder: vi.fn(),
  renameOperation: vi.fn(),
  updateGroup: vi.fn(),
}));

vi.mock("@fleet-console/sdk/operations/browser", () => ({ fetchOperationCatalog: vi.fn().mockResolvedValue([]) }));
vi.mock("../core/client/src/canvas/canvas.js", () => ({
  OperationsCanvas: ({ catalog, onLaunchAtGeometry, onLaunchKind, onRefreshCatalog }: {
    readonly catalog: readonly OperationCatalogPlugin[];
    readonly onLaunchAtGeometry: NonNullable<typeof canvasMocks.onLaunchAtGeometry>;
    readonly onLaunchKind: NonNullable<typeof canvasMocks.onLaunchKind>;
    readonly onRefreshCatalog: () => void;
  }) => {
    canvasMocks.catalog = catalog;
    canvasMocks.onLaunchAtGeometry = onLaunchAtGeometry;
    canvasMocks.onLaunchKind = onLaunchKind;
    canvasMocks.onRefreshCatalog = onRefreshCatalog;
    useLayoutEffect(() => canvasMocks.onMount?.(), []);
    return null;
  },
}));
vi.mock("../core/client/src/components/codex-reading-sheet.js", () => ({ CodexReadingSheet: () => null }));
vi.mock("../core/client/src/components/command-band.js", () => ({ CommandBand: () => null }));
vi.mock("../core/client/src/components/commissioning-overlay.js", () => ({ CommissioningOverlay: () => null }));
vi.mock("../core/client/src/components/keyboard-shortcuts-dialog.js", () => ({ isKeyboardShortcutsModalOpen: () => false, shouldHandleOperationsKeyboardShortcut: keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut }));
vi.mock("../core/client/src/components/operation-search.js", () => ({ OperationSearch: () => null }));
vi.mock("../core/client/src/mobile/operation-body-pool.js", () => ({
  OperationBodyPool: ({ operations, children }: { readonly operations: readonly OperationNode[]; readonly children: ReactNode }) => {
    bodyPoolMocks.renderedOperationIds.push(operations.map((operation) => operation.id));
    bodyPoolMocks.order.push(`pool:${operations.map((operation) => operation.id).join(",")}`);
    return createElement(Fragment, null, children);
  },
}));
vi.mock("../core/client/src/components/toast.js", () => ({
  Toast: () => null,
  // App은 토스트를 ToastHost 스택으로 감싼다 — mock도 같은 쌍을 제공해야 App 렌더가 산다.
  ToastHost: ({ children }: { readonly children?: ReactNode }) => createElement(Fragment, null, children),
}));
vi.mock("../core/client/src/components/whatsnew-modal.js", () => ({ WhatsNewModal: () => null }));
vi.mock("../core/client/src/global-settings-store.js", () => ({
  getGlobalSettingsStoreState: () => ({ state: null }),
  useGlobalSettingsStore: () => ({ state: null }),
}));
vi.mock("../core/client/src/operations-sse.js", () => ({ refreshObserverStatus: vi.fn() }));
// 데스크톱 /settings는 이제 레일 표면으로 번역하는 어댑터다 — 이 테스트의 관심은 "비-operations
// 라우트에 다녀오기"이므로 어댑터를 옛 페이지 모양의 대역으로 세워 라우트 왕복만 남긴다.
vi.mock("../core/client/src/settings/settings-route-adapter.js", () => ({ SettingsRouteAdapter: () => createElement("div", { "data-route": "settings" }) }));
vi.mock("../core/client/src/plugin-capabilities.js", () => ({ createHostCapabilities: () => ({ api: {} }) }));
vi.mock("../core/client/src/plugin-registry.js", () => ({ useExpandedSurfaceDescriptors: () => new Map(), usePluginRegistry: () => ({ plugins: registryMocks.plugins, failures: [], operationKinds: registryMocks.operationKinds, settingsSections: [], notificationKinds: [], railPanels: [], floatingWidgets: [] , expandedSurfaces: [], persistentComponents: []}) }));
// 부분 목 — 이 스토어에 export가 늘어도(아레나 점유 폭 훅 등) 테스트가 따라 깨지지 않는다.
vi.mock("../core/client/src/rail/rail-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/client/src/rail/rail-store.js")>()),
  toggleRailChrome: vi.fn(),
}));
vi.mock("../core/client/src/rail/right-rail.js", () => ({ RightRail: () => null }));
vi.mock("../core/client/src/whatsnew.js", () => ({ abortReleaseNotesFetch: vi.fn(), requestReleaseNotes: vi.fn() }));
// operations.tsx의 Alt 핸들러가 상태축 분기를 위해 이 모듈을 함께 읽으므로, 누락되면 preventDefault 이전에 던진다.
// 부분 목으로 두어야 이 스토어에 export가 늘어도 이 테스트가 따라 깨지지 않는다.
vi.mock("../core/client/src/sidebar/operations-side-bar-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/client/src/sidebar/operations-side-bar-store.js")>()),
  getSideBarState: () => ({ collapsed: false }),
  setSideBarCollapsed: vi.fn(),
  getSideBarStatusAxis: () => false,
  getSideBarStatusSectionCollapsed: () => false,
  setSideBarStatusAxis: vi.fn(),
  subscribeOperationActivityTracking: () => () => {},
  toggleSideBarStatusAxis: vi.fn(),
}));
// TriageSideBar가 같은 모듈의 목록 조립 헬퍼를 함께 읽으므로 부분 목이어야 한다.
vi.mock("../core/client/src/sidebar/operations-side-bar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/client/src/sidebar/operations-side-bar.js")>()),
  OperationsSideBar: ({ onClose, onFocus, onMinimize, onResume }: { readonly onClose: (operationId: string) => void; readonly onFocus: (operationId: string) => void; readonly onMinimize: (operationId: string) => void; readonly onResume: (operationId: string) => void }) => {
    sideBarMocks.onFocus = onFocus;
    sideBarMocks.onResume = onResume;
    sideBarMocks.onClose = onClose;
    sideBarMocks.onMinimize = onMinimize;
    return null;
  },
}));
vi.mock("../core/client/src/whatsnew-i18n.js", () => ({
  resolveConsoleLanguage: () => "en",
  resolveReleaseNotesLocale: () => "en",
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  // 부팅 최소화의 "한 번"과 캔버스 모드는 이제 탭 세션 단위라, 케이스마다 새 탭에서 시작한 것으로 되돌린다.
  window.sessionStorage.clear();
  resetBootMinimizationSession();
  window.history.replaceState({}, "", "/operations");
  loadForTheater("theater-a");
  setStationKeeping(false);
  clearMaximizedOperationId();
  clearCompanionOperationId();
  clearFormationView();
  loadForTheater(null);
  setState({ activeOperationId: null, activeTheaterId: null, groups: [], keyboardFocusRequest: null, operations: [], operationsHydrated: false, theaters: [] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  apiMocks.fetchGroups.mockResolvedValue([]);
  apiMocks.deleteOperation.mockImplementation(async (operationId: string) => ({
    ok: true,
    deletion: { deletionId: `delete-${operationId}`, kind: "operation", targetId: operationId, expiresAt: Date.now() + 8_000 },
  }));
  apiMocks.restoreDeletion.mockResolvedValue({ ok: true, kind: "operation", targetId: "restored" });
  keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut.mockReturnValue(false);
  sideBarMocks.onFocus = null;
  sideBarMocks.onResume = null;
  sideBarMocks.onClose = null;
  sideBarMocks.onMinimize = null;
  canvasMocks.catalog = [];
  canvasMocks.onMount = null;
  canvasMocks.onLaunchAtGeometry = null;
  canvasMocks.onLaunchKind = null;
  canvasMocks.onRefreshCatalog = null;
  vi.mocked(fetchOperationCatalog).mockReset().mockResolvedValue([]);
  registryMocks.plugins = [];
  registryMocks.operationKinds = [];
  bodyPoolMocks.renderedOperationIds = [];
  bodyPoolMocks.order = [];
  // 선별 처리는 Theater가 아니라 전역 축이라, Theater 단위 reset만으로는 꺼지지 않는다.
  setTriageActive(false);
  resetTriageTheater("theater-a");
  resetTriageTheater("theater-b");
});

afterEach(() => {
  act(() => root?.unmount());
  setTriageActive(false);
  loadForTheater("theater-a");
  clearCompanionOperationId();
  clearMaximizedOperationId();
  clearFormationView();
  loadForTheater("theater-b");
  clearCompanionOperationId();
  clearMaximizedOperationId();
  clearFormationView();
  loadForTheater(null);
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetTriageTheater("theater-a");
  resetTriageTheater("theater-b");
});

describe("Operations boot minimization", () => {
  it("switches to an inactive dormant Operation's Theater before resuming without mounting its foreign body first", async () => {
    const resumeOperation = vi.fn(() => { bodyPoolMocks.order.push(`resume:${getState().activeTheaterId}`); });
    registryMocks.plugins = [{ id: "terminal", resumeOperation }];
    await bootApp(
      [
        operation("home", BOOT_FRESH_CREATED_AT(), "theater-a"),
        { ...operation("dormant", 1, "theater-b"), payload: { resumeAvailable: true } },
      ],
      [theater("theater-a", "Theater A"), theater("theater-b", "Theater B")],
    );
    await navigateTo("/operations");
    expect(getState().activeTheaterId).toBe("theater-a");
    expect(sideBarMocks.onResume).not.toBeNull();
    expect(bodyPoolMocks.renderedOperationIds.at(-1)).toEqual(["home"]);
    bodyPoolMocks.order = [];

    await act(async () => {
      sideBarMocks.onResume?.("dormant");
      await Promise.resolve();
    });

    expect(bodyPoolMocks.order[0]).toBe("resume:theater-b");
    expect(resumeOperation).toHaveBeenCalledWith("dormant");
    expect(getState().activeTheaterId).toBe("theater-b");
    expect(getState().activeOperationId).not.toBe("dormant");
    expect(getState().pendingOperationFocus).toBeNull();
    expect(bodyPoolMocks.renderedOperationIds.at(-1)).toEqual(["dormant"]);
    expect(getSnapshot().minimized).not.toContain("dormant");
  });

  it("resumes a dormant Operation in the active Theater without switching, reloading, or setting focus state", async () => {
    const resumeOperation = vi.fn();
    registryMocks.plugins = [{ id: "terminal", resumeOperation }];
    await bootApp([
      operation("home", BOOT_FRESH_CREATED_AT(), "theater-a"),
      { ...operation("dormant", 1, "theater-a"), payload: { resumeAvailable: true } },
    ]);
    await navigateTo("/operations");
    expect(getState().activeTheaterId).toBe("theater-a");
    expect(sideBarMocks.onResume).not.toBeNull();
    const canvasSnapshot = getSnapshot();
    const bodyPoolRenderCount = bodyPoolMocks.renderedOperationIds.length;

    await act(async () => {
      sideBarMocks.onResume?.("dormant");
      await Promise.resolve();
    });

    expect(resumeOperation).toHaveBeenCalledWith("dormant");
    expect(getState().activeTheaterId).toBe("theater-a");
    expect(getState().activeOperationId).toBeNull();
    expect(getState().pendingOperationFocus).toBeNull();
    expect(getSnapshot()).toBe(canvasSnapshot);
    expect(bodyPoolMocks.renderedOperationIds).toHaveLength(bodyPoolRenderCount);
  });

  it("consumes a cold pending fit after loadForTheater restores the saved viewport", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" || query === "(min-width: 832px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    window.history.replaceState({}, "", "/settings");
    loadForTheater("theater-a");
    setOperationGeometry("visible", { x: 20, y: 30, width: 100, height: 80, zIndex: 1 });
    setViewport({ x: 120, y: 160, zoom: 0.5 });
    loadForTheater(null);
    await bootApp([operation("visible", BOOT_FRESH_CREATED_AT())]);
    loadForTheater("theater-a");
    resetCanvasViewportSize();
    requestFitAllOperations();
    const mountCanvas = vi.fn(() => {
      setCanvasViewportSize({ width: 1_000, height: 800 });
      return resetCanvasViewportSize;
    });
    canvasMocks.onMount = mountCanvas;

    await navigateTo("/operations");

    expect(mountCanvas).toHaveBeenCalledOnce();
    expect(getSnapshot().operations.visible).toMatchObject({ x: 20, y: 30, width: 100, height: 80 });
    expect(getSnapshot().minimized).toEqual([]);
    // 전면 해도 개편: fit-all의 분모·중심은 아레나다 — 펼친 사이드바(폭 280 + 부유 여백 24)가
    // 좌측 인셋 304px를 만들어 중심이 152px 왼쪽으로 온다(캔버스 박스 중심이던 구 계약의 승계).
    expect(getSnapshot().viewport).toEqual({ x: 278, y: 330, zoom: 1 });
  });

  it("seeds missing geometry before consuming a cold pending fit", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" || query === "(min-width: 832px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    window.history.replaceState({}, "", "/settings");
    loadForTheater("theater-a");
    setViewport({ x: 120, y: 160, zoom: 0.5 });
    loadForTheater(null);
    await bootApp([operation("missing-geometry", BOOT_FRESH_CREATED_AT())]);
    loadForTheater("theater-a");
    resetCanvasViewportSize();
    requestFitAllOperations();
    const mountCanvas = vi.fn(() => {
      setCanvasViewportSize({ width: 1_000, height: 800 });
      return resetCanvasViewportSize;
    });
    canvasMocks.onMount = mountCanvas;

    await navigateTo("/operations");

    expect(mountCanvas).toHaveBeenCalledOnce();
    expect(getSnapshot().operations["missing-geometry"]).toMatchObject({ x: 0, y: 0, width: 640, height: 400 });
    expect(getSnapshot().minimized).toEqual([]);
    // 아레나 폭(캔버스 − 좌측 인셋 304)이 bbox보다 좁아 fit이 축소·아레나 중심 좌표로 맞춘다.
    expect(getSnapshot().viewport).toEqual({ x: 48, y: 212.5, zoom: 0.9375 });
  });

  it("prunes stale geometry before consuming a cold pending fit", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" || query === "(min-width: 832px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    window.history.replaceState({}, "", "/settings");
    loadForTheater("theater-a");
    setOperationGeometry("visible", { x: 20, y: 30, width: 100, height: 80, zIndex: 1 });
    setOperationGeometry("stale", { x: 2_000, y: 2_000, width: 100, height: 80, zIndex: 2 });
    setViewport({ x: 120, y: 160, zoom: 0.5 });
    loadForTheater(null);
    await bootApp([operation("visible", BOOT_FRESH_CREATED_AT())]);
    loadForTheater("theater-a");
    resetCanvasViewportSize();
    requestFitAllOperations();
    const mountCanvas = vi.fn(() => {
      setCanvasViewportSize({ width: 1_000, height: 800 });
      return resetCanvasViewportSize;
    });
    canvasMocks.onMount = mountCanvas;

    await navigateTo("/operations");

    expect(mountCanvas).toHaveBeenCalledOnce();
    expect(getSnapshot().operations.stale).toBeUndefined();
    expect(getSnapshot().operations.visible).toMatchObject({ x: 20, y: 30, width: 100, height: 80 });
    // 전면 해도 개편: fit-all의 분모·중심은 아레나다 — 펼친 사이드바(폭 280 + 부유 여백 24)가
    // 좌측 인셋 304px를 만들어 중심이 152px 왼쪽으로 온다(캔버스 박스 중심이던 구 계약의 승계).
    expect(getSnapshot().viewport).toEqual({ x: 278, y: 330, zoom: 1 });
  });

  it("minimizes initial hydrated panels once across /operations -> /settings -> /operations", async () => {
    const operations = deferred<readonly OperationNode[]>();
    const theaters = deferred<TheaterBootstrap>();
    apiMocks.fetchOperations.mockReturnValueOnce(operations.promise);
    apiMocks.fetchTheaterBootstrap.mockReturnValueOnce(theaters.promise);
    const { App } = await import("../core/client/src/app.js");

    await act(async () => {
      root!.render(createElement(BrowserRouter, null, createElement(App)));
    });

    await act(async () => {
      operations.resolve([operation("initial")]);
      await Promise.resolve();
    });
    expect(getState().operationsHydrated).toBe(true);
    expect(getSnapshot().minimized).toEqual([]);

    await act(async () => {
      theaters.resolve({ theaters: [theater()] });
      await Promise.resolve();
    });
    expect(getSnapshot().minimized).toEqual(["initial"]);

    await act(async () => {
      hydrateOperations([operation("initial"), operation("later")]);
    });
    setOperationGeometry("later", { x: 96, y: 144, width: 640, height: 400, zIndex: 2 });
    restoreOperation("initial");
    expect(getSnapshot().minimized).toEqual([]);

    await navigateTo("/settings");
    expect(document.querySelector('[data-route="settings"]')).not.toBeNull();
    await navigateTo("/operations");

    expect(getSnapshot().minimized).toEqual([]);
    expect(getSnapshot().operations).toHaveProperty("initial");
    expect(getSnapshot().operations).toHaveProperty("later");
  });

  it("does not minimize an Operation launched before the initial fetch resolves", async () => {
    const operations = deferred<readonly OperationNode[]>();
    const theaters = deferred<TheaterBootstrap>();
    vi.spyOn(Date, "now").mockReturnValue(100);
    apiMocks.fetchOperations.mockReturnValueOnce(operations.promise);
    apiMocks.fetchTheaterBootstrap.mockReturnValueOnce(theaters.promise);
    const { App } = await import("../core/client/src/app.js");

    await act(async () => {
      root!.render(createElement(BrowserRouter, null, createElement(App)));
    });

    await act(async () => {
      theaters.resolve({ theaters: [theater()] });
      await Promise.resolve();
    });
    expect(getState().activeTheaterId).toBe("theater-a");
    expect(getState().operationsHydrated).toBe(false);

    await act(async () => {
      hydrateOperations([operation("launched", 100)]);
    });
    expect(getSnapshot().minimized).toEqual([]);

    await act(async () => {
      operations.resolve([operation("initial", 99), operation("launched", 100)]);
      await Promise.resolve();
    });

    expect(getSnapshot().minimized).toEqual(["initial"]);
    expect(getSnapshot().operations).toHaveProperty("initial");
    expect(getSnapshot().operations).toHaveProperty("launched");
  });

  it("consumes Alt+Arrow without restoring or activating when every panel is minimized", async () => {
    const operations = deferred<readonly OperationNode[]>();
    const theaters = deferred<TheaterBootstrap>();
    apiMocks.fetchOperations.mockReturnValueOnce(operations.promise);
    apiMocks.fetchTheaterBootstrap.mockReturnValueOnce(theaters.promise);
    const { App } = await import("../core/client/src/app.js");

    await act(async () => {
      root!.render(createElement(BrowserRouter, null, createElement(App)));
    });
    await act(async () => {
      operations.resolve([operation("initial")]);
      theaters.resolve({ theaters: [theater()] });
      await Promise.resolve();
    });
    expect(getSnapshot().minimized).toEqual(["initial"]);
    expect(getState().activeOperationId).toBeNull();

    keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut.mockReturnValue(true);
    const event = new KeyboardEvent("keydown", { code: "ArrowLeft", key: "ArrowLeft", altKey: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(true);
    expect(getState().activeOperationId).toBeNull();
    expect(getState().keyboardFocusRequest).toBeNull();
    expect(getSnapshot().minimized).toEqual(["initial"]);
  });

  it("leaves Shift+1 to xterm while consuming it outside xterm", async () => {
    await bootApp([operation("initial")]);
    keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut.mockReturnValue(true);
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const terminalInput = document.createElement("textarea");
    terminalInput.className = "xterm-helper-textarea";
    xterm.appendChild(terminalInput);
    document.body.appendChild(xterm);
    terminalInput.focus();

    const terminalEvent = new KeyboardEvent("keydown", { code: "Digit1", shiftKey: true, cancelable: true });
    window.dispatchEvent(terminalEvent);
    expect(terminalEvent.defaultPrevented).toBe(false);

    const outsideButton = document.createElement("button");
    document.body.appendChild(outsideButton);
    outsideButton.focus();
    const canvasEvent = new KeyboardEvent("keydown", { code: "Digit1", shiftKey: true, cancelable: true });
    window.dispatchEvent(canvasEvent);
    expect(canvasEvent.defaultPrevented).toBe(true);
  });

  it("does not consume Shift+1 before Operations hydrate", async () => {
    const operations = deferred<readonly OperationNode[]>();
    const theaters = deferred<TheaterBootstrap>();
    apiMocks.fetchOperations.mockReturnValueOnce(operations.promise);
    apiMocks.fetchTheaterBootstrap.mockReturnValueOnce(theaters.promise);
    const { App } = await import("../core/client/src/app.js");
    await act(async () => {
      root!.render(createElement(BrowserRouter, null, createElement(App)));
    });
    await act(async () => {
      theaters.resolve({ theaters: [theater()] });
      await Promise.resolve();
    });
    expect(getState().operationsHydrated).toBe(false);
    keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut.mockReturnValue(true);

    const event = new KeyboardEvent("keydown", { code: "Digit1", shiftKey: true, cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("does not let repeated Alt+Down minimize the next active panel", async () => {
    await bootApp([operation("first"), operation("second")]);
    await act(async () => {
      restoreOperation("first");
      restoreOperation("second");
      setActiveOperation("first");
      await Promise.resolve();
    });
    keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut.mockReturnValue(true);

    const initial = altKeyDown("ArrowDown");
    await act(async () => {
      window.dispatchEvent(initial);
      await Promise.resolve();
    });
    expect(getSnapshot().minimized).toContain("first");
    expect(getState().activeOperationId).toBe("second");

    const repeated = altKeyDown("ArrowDown", { repeat: true });
    await act(async () => {
      window.dispatchEvent(repeated);
      await Promise.resolve();
    });

    expect(repeated.defaultPrevented).toBe(true);
    expect(getSnapshot().minimized).not.toContain("second");
    expect(getState().activeOperationId).toBe("second");
  });

  it("does not let repeated Alt+Down confirm an armed Triage set-aside", async () => {
    await bootApp([operation("first")]);
    await act(async () => {
      // 최소화한 Operation은 War Room 큐에 오르지 않는다 — 최소화가 곧 "이 판에서 내렸다"는 뜻이라
      // deck에도 순번에도 남지 않기 때문이다. 부팅 최소화를 먼저 되돌려야 무대에 세울 수 있다.
      // 이 테스트가 지키는 계약은 그것과 무관하다: 키를 누른 채로 두어도 두 번 누르기 확인이 통과되지 않는다.
      restoreOperation("first");
      setState({ operationRuntime: { first: { lifecycle: "live", activity: "awaiting" } } });
      setTriageActive(true);
      await Promise.resolve();
    });
    const stage = document.createElement("div");
    stage.className = "canvas-operation is-triage-stage";
    stage.dataset.operationId = "first";
    document.body.appendChild(stage);
    keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut.mockReturnValue(true);

    const initial = altKeyDown("ArrowDown");
    await act(async () => {
      window.dispatchEvent(initial);
      await Promise.resolve();
    });
    expect(getTriageSetAsideArmedId()).toBe("first");

    const repeated = altKeyDown("ArrowDown", { repeat: true });
    await act(async () => {
      window.dispatchEvent(repeated);
      await Promise.resolve();
    });

    expect(repeated.defaultPrevented).toBe(true);
    expect(getTriageSetAsideArmedId()).toBe("first");
    stage.remove();
  });

  it("continues focus cycling for repeated Alt+Left and Alt+Right", async () => {
    await bootApp([operation("first"), operation("second")]);
    await act(async () => {
      restoreOperation("first");
      restoreOperation("second");
      setActiveOperation("first");
      await Promise.resolve();
    });
    keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut.mockReturnValue(true);

    await act(async () => {
      window.dispatchEvent(altKeyDown("ArrowRight", { repeat: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getState().activeOperationId).toBe("second");

    await act(async () => {
      window.dispatchEvent(altKeyDown("ArrowLeft", { repeat: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getState().activeOperationId).toBe("first");
  });

  // 채팅 패널에서 캐럿이 사는 자리는 컴포저 하나뿐이다. 편집 중이라는 이유로 Alt+화살표를 삼키면
  // 패널 축이 정확히 필요한 순간에만 죽는다 — 같은 키가 터미널 포커스에서는 이미 살아 있다.
  it("keeps panel arrows alive while a composer textarea holds focus", async () => {
    await bootApp([operation("first"), operation("second")]);
    await act(async () => {
      restoreOperation("first");
      restoreOperation("second");
      setActiveOperation("first");
      await Promise.resolve();
    });
    keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut.mockReturnValue(true);
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();
    expect(document.activeElement).toBe(composer);

    await act(async () => {
      window.dispatchEvent(altKeyDown("ArrowRight"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getState().activeOperationId).toBe("second");

    // 수식자 없는 키는 그대로 타자다 — 편집 중에는 언제나 컴포저의 것이다.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1", key: "!", shiftKey: true, bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(getState().activeOperationId).toBe("second");
    composer.remove();
  });

  it("blocks panel arrows, companion shortcuts, and armed Escape behind a modal", async () => {
    registryMocks.operationKinds = [shortcutCompanionKind()];
    await bootApp([operation("first")]);
    await act(async () => {
      restoreOperation("first");
      setActiveOperation("first");
      await Promise.resolve();
    });
    armTriageSetAside("first");
    keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut.mockReturnValue(true);
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);

    await act(async () => {
      window.dispatchEvent(altKeyDown("ArrowDown"));
      window.dispatchEvent(altKeyDown("KeyC"));
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(getSnapshot().minimized).not.toContain("first");
    expect(getCompanionOperationId()).toBeNull();
    expect(getTriageSetAsideArmedId()).toBe("first");
    dialog.remove();
  });

  it("restores and activates a minimized Operation before pending Map focus moves the viewport", async () => {
    await bootApp([operation("initial")]);
    expect(getSnapshot().minimized).toEqual(["initial"]);

    const initialViewport = getSnapshot().viewport;
    const activeIdsAtViewportChange: Array<string | null> = [];
    const unsubscribe = subscribeCanvas(() => {
      if (getSnapshot().viewport !== initialViewport) activeIdsAtViewportChange.push(getState().activeOperationId);
    });
    try {
      await act(async () => {
        focusOperation("initial");
        // 자식 Canvas effect가 부모의 pending focus effect보다 먼저 활성 ID를 지우는 실제 순서를 재현한다.
        setActiveOperation(null);
        await Promise.resolve();
      });
    } finally {
      unsubscribe();
    }

    expect(getSnapshot().minimized).toEqual([]);
    expect(getState().activeOperationId).toBe("initial");
    expect(activeIdsAtViewportChange.at(-1)).toBe("initial");
    expect(getState().keyboardFocusRequest).toEqual({ operationId: "initial", requestId: 1 });
  });

  it("skips minimized peers while maximized", async () => {
    const operations = deferred<readonly OperationNode[]>();
    const theaters = deferred<TheaterBootstrap>();
    apiMocks.fetchOperations.mockReturnValueOnce(operations.promise);
    apiMocks.fetchTheaterBootstrap.mockReturnValueOnce(theaters.promise);
    const { App } = await import("../core/client/src/app.js");

    await act(async () => {
      root!.render(createElement(BrowserRouter, null, createElement(App)));
    });
    await act(async () => {
      operations.resolve([operation("first"), operation("second"), operation("third")]);
      theaters.resolve({ theaters: [theater()] });
      await Promise.resolve();
    });
    await act(async () => {
      restoreOperation("third");
      setMaximizedOperationId("first");
      await Promise.resolve();
    });
    expect(getMaximizedOperationId()).toBe("first");
    expect(getFormationView()).toBe(false);
    expect(getSnapshot().minimized).toEqual(["second"]);

    keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut.mockReturnValue(true);
    const event = new KeyboardEvent("keydown", { code: "ArrowRight", key: "ArrowRight", altKey: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(true);
    expect(getState().activeOperationId).toBe("third");
    expect(getMaximizedOperationId()).toBe("third");
    expect(getFormationView()).toBe(false);
    expect(getSnapshot().minimized).toEqual(["second"]);
  });

  it("skips minimized peers while Formation is active", async () => {
    await bootApp([operation("first"), operation("second"), operation("third")]);
    await act(async () => {
      restoreOperation("first");
      restoreOperation("third");
      setActiveOperation("first");
      toggleFormationView();
      await Promise.resolve();
    });
    expect(getFormationView()).toBe(true);
    expect(getSnapshot().minimized).toEqual(["second"]);

    keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut.mockReturnValue(true);
    const event = new KeyboardEvent("keydown", { code: "ArrowRight", key: "ArrowRight", altKey: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(true);
    expect(getState().activeOperationId).toBe("third");
    expect(getFormationView()).toBe(true);
    expect(getSnapshot().minimized).toEqual(["second"]);
  });

  it("switches pending focus through the active focus layer before Formation", async () => {
    const operations = deferred<readonly OperationNode[]>();
    const theaters = deferred<TheaterBootstrap>();
    apiMocks.fetchOperations.mockReturnValueOnce(operations.promise);
    apiMocks.fetchTheaterBootstrap.mockReturnValueOnce(theaters.promise);
    const { App } = await import("../core/client/src/app.js");

    await act(async () => {
      root!.render(createElement(BrowserRouter, null, createElement(App)));
    });
    await act(async () => {
      operations.resolve([operation("first"), operation("second")]);
      theaters.resolve({ theaters: [theater()] });
      await Promise.resolve();
    });
    await act(async () => {
      toggleFormationView();
      setMaximizedOperationId("first");
      focusOperation("second");
      await Promise.resolve();
    });

    expect(getState().activeOperationId).toBe("second");
    expect(getMaximizedOperationId()).toBe("second");
    expect(getFormationView()).toBe(true);
    expect(getSnapshot().minimized).toEqual([]);
  });

  it("keeps a same-target sidebar selection in the focus layer without changing Map geometry", async () => {
    const operations = deferred<readonly OperationNode[]>();
    const theaters = deferred<TheaterBootstrap>();
    apiMocks.fetchOperations.mockReturnValueOnce(operations.promise);
    apiMocks.fetchTheaterBootstrap.mockReturnValueOnce(theaters.promise);
    const { App } = await import("../core/client/src/app.js");

    await act(async () => {
      root!.render(createElement(BrowserRouter, null, createElement(App)));
    });
    await act(async () => {
      operations.resolve([operation("first")]);
      theaters.resolve({ theaters: [theater()] });
      await Promise.resolve();
    });
    await act(async () => {
      setViewport({ x: 48, y: 72, zoom: 0.8 });
      setMaximizedOperationId("first");
    });
    const viewport = getSnapshot().viewport;
    const geometry = getSnapshot().operations.first;
    expect(sideBarMocks.onFocus).not.toBeNull();

    await act(async () => {
      sideBarMocks.onFocus?.("first");
      await Promise.resolve();
    });

    expect(getMaximizedOperationId()).toBe("first");
    expect(getSnapshot().viewport).toEqual(viewport);
    expect(getSnapshot().operations.first).toEqual(geometry);
  });

  it("uses the destination Theater's live Formation state for pending focus", async () => {
    const operations = deferred<readonly OperationNode[]>();
    const theaters = deferred<TheaterBootstrap>();
    apiMocks.fetchOperations.mockReturnValueOnce(operations.promise);
    apiMocks.fetchTheaterBootstrap.mockReturnValueOnce(theaters.promise);
    const { App } = await import("../core/client/src/app.js");

    await act(async () => {
      root!.render(createElement(BrowserRouter, null, createElement(App)));
    });
    await act(async () => {
      operations.resolve([operation("a1", 1, "theater-a"), operation("b1", 1, "theater-b")]);
      theaters.resolve({ theaters: [theater(), theater("theater-b", "Theater B")] });
      await Promise.resolve();
    });
    const destinationViewport = { x: 144, y: 96, zoom: 0.7 };
    let destinationGeometry: ReturnType<typeof getSnapshot>["operations"][string] | undefined;
    await act(async () => {
      loadForTheater("theater-b");
      setOperationGeometry("b1", { x: 32, y: 64, width: 640, height: 400, zIndex: 3 });
      setViewport(destinationViewport);
      toggleFormationView();
      destinationGeometry = getSnapshot().operations.b1;
      loadForTheater("theater-a");
      await Promise.resolve();
    });

    await act(async () => {
      focusOperation("b1");
      await Promise.resolve();
    });

    expect(getState().activeTheaterId).toBe("theater-b");
    expect(getFormationView()).toBe(true);
    expect(getSnapshot().viewport).toEqual(destinationViewport);
    expect(getSnapshot().operations.b1).toEqual(destinationGeometry);
  });

  it("retargets Analyze through sidebar focus and surfaces a minimized target", async () => {
    const canOpenCompanions = vi.fn().mockResolvedValue(true);
    registryMocks.operationKinds = [companionKind(canOpenCompanions)];
    await bootApp([operation("first"), operation("second")]);
    await act(async () => {
      toggleFormationView();
      setCompanionOperationId("first");
      minimizeOperation("second");
      await Promise.resolve();
    });

    await act(async () => {
      sideBarMocks.onFocus?.("second");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(canOpenCompanions).toHaveBeenCalledOnce();
    expect(getCompanionOperationId()).toBe("second");
    expect(getFormationView()).toBe(true);
    expect(getState().activeOperationId).toBe("second");
    expect(getSnapshot().minimized).not.toContain("second");
  });

  it("keeps the current Analyze target without revalidating readiness", async () => {
    const canOpenCompanions = vi.fn().mockResolvedValue(false);
    registryMocks.operationKinds = [companionKind(canOpenCompanions)];
    await bootApp([operation("first")]);
    await act(async () => {
      toggleFormationView();
      setCompanionOperationId("first");
      await Promise.resolve();
    });

    await act(async () => {
      sideBarMocks.onFocus?.("first");
      await Promise.resolve();
    });

    expect(canOpenCompanions).not.toHaveBeenCalled();
    expect(getCompanionOperationId()).toBe("first");
    clearCompanionOperationId();
    expect(getFormationView()).toBe(true);
  });

  it("exits Analyze and keeps Formation when an Analyze retarget is not ready", async () => {
    const canOpenCompanions = vi.fn().mockResolvedValue(false);
    registryMocks.operationKinds = [companionKind(canOpenCompanions)];
    await bootApp([operation("first"), operation("second")]);
    await act(async () => {
      toggleFormationView();
      setCompanionOperationId("first");
      minimizeOperation("second");
      await Promise.resolve();
    });

    await act(async () => {
      sideBarMocks.onFocus?.("second");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(canOpenCompanions).toHaveBeenCalledOnce();
    expect(getCompanionOperationId()).toBeNull();
    expect(getFormationView()).toBe(true);
    expect(getState().activeOperationId).toBe("second");
    expect(getSnapshot().minimized).not.toContain("second");
  });

  it("exits Analyze and keeps Formation when the retarget has no registered descriptor", async () => {
    await bootApp([operation("first"), operation("second")]);
    await act(async () => {
      toggleFormationView();
      setCompanionOperationId("first");
      minimizeOperation("second");
      await Promise.resolve();
    });

    await act(async () => {
      sideBarMocks.onFocus?.("second");
      await Promise.resolve();
    });

    expect(getCompanionOperationId()).toBeNull();
    expect(getFormationView()).toBe(true);
    expect(getState().activeOperationId).toBe("second");
    expect(getSnapshot().minimized).not.toContain("second");
  });

  it("falls back to Map when an Analyze retarget is not ready outside Formation", async () => {
    const canOpenCompanions = vi.fn().mockResolvedValue(false);
    registryMocks.operationKinds = [companionKind(canOpenCompanions)];
    await bootApp([operation("first"), operation("second")]);
    await act(async () => {
      setCompanionOperationId("first");
      minimizeOperation("second");
      await Promise.resolve();
    });

    await act(async () => {
      sideBarMocks.onFocus?.("second");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(canOpenCompanions).toHaveBeenCalledOnce();
    expect(getCompanionOperationId()).toBeNull();
    expect(getFormationView()).toBe(false);
    expect(getState().activeOperationId).toBe("second");
    expect(getSnapshot().minimized).not.toContain("second");
  });

  it("applies only the latest asynchronous Analyze retarget", async () => {
    const secondReady = deferred<boolean>();
    const thirdReady = deferred<boolean>();
    const canOpenCompanions = vi.fn(({ operation: target }: { readonly operation: OperationNode }) => target.id === "second" ? secondReady.promise : thirdReady.promise);
    registryMocks.operationKinds = [companionKind(canOpenCompanions)];
    await bootApp([operation("first"), operation("second"), operation("third")]);
    await act(async () => {
      setCompanionOperationId("first");
      await Promise.resolve();
    });

    act(() => {
      sideBarMocks.onFocus?.("second");
      sideBarMocks.onFocus?.("third");
    });
    await act(async () => {
      secondReady.resolve(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getCompanionOperationId()).toBe("first");
    expect(getState().keyboardFocusRequest).toBeNull();

    await act(async () => {
      thirdReady.resolve(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getCompanionOperationId()).toBe("third");
    expect(getState().keyboardFocusRequest).toEqual({ operationId: "third", requestId: 1 });
  });

  it("discards an asynchronous retarget after Analyze exits and reopens", async () => {
    const secondReady = deferred<boolean>();
    registryMocks.operationKinds = [companionKind(() => secondReady.promise)];
    await bootApp([operation("first"), operation("second")]);
    await act(async () => {
      setCompanionOperationId("first");
      await Promise.resolve();
    });

    act(() => sideBarMocks.onFocus?.("second"));
    await act(async () => {
      clearCompanionOperationId();
      setCompanionOperationId("first");
      secondReady.resolve(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getCompanionOperationId()).toBe("first");
  });

  it("discards an asynchronous Analyze retarget after its destination closes", async () => {
    const secondReady = deferred<boolean>();
    registryMocks.operationKinds = [companionKind(() => secondReady.promise)];
    await bootApp([operation("first"), operation("second")]);
    await act(async () => {
      setCompanionOperationId("first");
      await Promise.resolve();
    });

    act(() => sideBarMocks.onFocus?.("second"));
    apiMocks.fetchOperations.mockResolvedValue([operation("first")]);
    await act(async () => {
      sideBarMocks.onClose?.("second");
      await vi.waitFor(() => expect(getState().operations.some((candidate) => candidate.id === "second")).toBe(false));
    });
    await act(async () => {
      secondReady.resolve(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getCompanionOperationId()).toBe("first");
    expect(getState().activeOperationId).not.toBe("second");
  });

  it("discards an asynchronous Analyze retarget while its destination is closing", async () => {
    const secondReady = deferred<boolean>();
    const closeRefresh = deferred<readonly OperationNode[]>();
    registryMocks.operationKinds = [companionKind(() => secondReady.promise)];
    await bootApp([operation("first"), operation("second")]);
    await act(async () => {
      setCompanionOperationId("first");
      await Promise.resolve();
    });

    act(() => sideBarMocks.onFocus?.("second"));
    apiMocks.fetchOperations.mockReturnValueOnce(closeRefresh.promise);
    act(() => sideBarMocks.onClose?.("second"));
    await act(async () => {
      secondReady.resolve(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getState().operations.some((candidate) => candidate.id === "second")).toBe(true);
    expect(getCompanionOperationId()).toBe("first");

    await act(async () => {
      closeRefresh.resolve([operation("first")]);
      await vi.waitFor(() => expect(getState().operations.some((candidate) => candidate.id === "second")).toBe(false));
    });
  });

  it("discards an asynchronous Analyze retarget after its destination is minimized", async () => {
    const secondReady = deferred<boolean>();
    registryMocks.operationKinds = [companionKind(() => secondReady.promise)];
    await bootApp([operation("first"), operation("second")]);
    await act(async () => {
      setCompanionOperationId("first");
      restoreOperation("second");
      await Promise.resolve();
    });

    act(() => sideBarMocks.onFocus?.("second"));
    act(() => sideBarMocks.onMinimize?.("second"));
    await act(async () => {
      secondReady.resolve(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getCompanionOperationId()).toBe("first");
    expect(getSnapshot().minimized).toContain("second");
  });

  it("force-drops Analyze immediately when Sidebar closes its target", async () => {
    await bootApp([operation("first")]);
    await act(async () => {
      setCompanionOperationId("first");
      await Promise.resolve();
    });
    apiMocks.fetchOperations.mockResolvedValue([]);

    act(() => sideBarMocks.onClose?.("first"));

    expect(getCompanionOperationId()).toBeNull();
  });

  it("retargets Analyze with Alt+Arrow to a non-minimized peer while preserving minimized peers", async () => {
    const canOpenCompanions = vi.fn(() => true);
    registryMocks.operationKinds = [companionKind(canOpenCompanions)];
    await bootApp([operation("first"), operation("second"), operation("third")]);
    await act(async () => {
      toggleFormationView();
      restoreOperation("third");
      setMaximizedOperationId("first");
      setCompanionOperationId("first");
      await Promise.resolve();
    });
    expect(getSnapshot().minimized).toEqual(["second"]);

    keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut.mockReturnValue(true);
    const event = new KeyboardEvent("keydown", { code: "ArrowRight", key: "ArrowRight", altKey: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(true);
    expect(canOpenCompanions).toHaveBeenCalledOnce();
    expect(getCompanionOperationId()).toBe("third");
    expect(getState().activeOperationId).toBe("third");
    expect(getMaximizedOperationId()).toBeNull();
    expect(getFormationView()).toBe(true);
    expect(getSnapshot().minimized).toEqual(["second"]);
  });

  it("retargets Analyze through pending focus using the destination Theater's layer", async () => {
    registryMocks.operationKinds = [companionKind(() => true)];
    await bootApp(
      [operation("a1", 1, "theater-a"), operation("b1", 1, "theater-b"), operation("b2", 2, "theater-b")],
      [theater(), theater("theater-b", "Theater B")],
    );
    await act(async () => {
      loadForTheater("theater-b");
      setOperationGeometry("b1", { x: 0, y: 0, width: 640, height: 400, zIndex: 1 });
      setOperationGeometry("b2", { x: 40, y: 40, width: 640, height: 400, zIndex: 2 });
      setMaximizedOperationId("b1");
      setCompanionOperationId("b1");
      loadForTheater("theater-a");
      await Promise.resolve();
    });

    await act(async () => {
      focusOperation("b2");
      await Promise.resolve();
    });

    expect(getState().activeTheaterId).toBe("theater-b");
    expect(getCompanionOperationId()).toBe("b2");
    clearCompanionOperationId();
    expect(getMaximizedOperationId()).toBe("b2");
  });

  it("discards an asynchronous Analyze retarget when a newer focus changes Theater", async () => {
    const secondReady = deferred<boolean>();
    const canOpenCompanions = vi.fn(() => secondReady.promise);
    registryMocks.operationKinds = [companionKind(canOpenCompanions)];
    await bootApp(
      [operation("first"), operation("second"), operation("b1", 1, "theater-b")],
      [theater(), theater("theater-b", "Theater B")],
    );
    await act(async () => {
      setCompanionOperationId("first");
      await Promise.resolve();
    });

    await act(async () => {
      sideBarMocks.onFocus?.("second");
      await Promise.resolve();
      sideBarMocks.onFocus?.("b1");
      expect(getState().activeTheaterId).toBe("theater-b");
      secondReady.resolve(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(canOpenCompanions).toHaveBeenCalledOnce();
    expect(getState().activeTheaterId).toBe("theater-b");
    expect(getTheaterCompanionOperationId("theater-a")).toBe("first");
    expect(getCompanionOperationId()).toBeNull();
  });

  it("keeps a newer catalog refresh when an older request resolves last", async () => {
    const stale = deferred<readonly OperationCatalogPlugin[]>();
    const fresh = deferred<readonly OperationCatalogPlugin[]>();
    vi.mocked(fetchOperationCatalog)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);
    await bootApp([]);
    expect(canvasMocks.onRefreshCatalog).not.toBeNull();

    act(() => canvasMocks.onRefreshCatalog?.());
    await act(async () => {
      fresh.resolve([{ id: "fresh", title: "Fresh", kinds: [{ id: "fresh", type: "shell", title: "Fresh" }] }]);
      await Promise.resolve();
    });
    expect(canvasMocks.catalog[0]?.id).toBe("fresh");

    await act(async () => {
      stale.resolve([{ id: "stale", title: "Stale", kinds: [{ id: "stale", type: "shell", title: "Stale" }] }]);
      await Promise.resolve();
    });
    expect(canvasMocks.catalog[0]?.id).toBe("fresh");
  });

  it("does not retarget Analyze when launch starts with it open", async () => {
    const launch = deferred<{ readonly id: string }>();
    registryMocks.plugins = [{ id: "terminal", launch: vi.fn(() => launch.promise) }];
    await bootApp([operation("first")]);
    await act(async () => {
      setCompanionOperationId("first");
      await Promise.resolve();
    });
    apiMocks.fetchOperations.mockResolvedValue([operation("first"), operation("launched", 2)]);

    await act(async () => {
      // Analyze 비승계는 생성 경로 계약이다. Shell 런치는 Theater 싱글톤이라 기존 패널을 재사용한다.
      canvasMocks.onLaunchAtGeometry?.("terminal", { type: "agent", title: "Agent" }, { x: 0, y: 0, width: 640, height: 400, zIndex: 2 });
      launch.resolve({ id: "launched" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getCompanionOperationId()).toBe("first");
  });

  it("uses live completion state when Analyze opens during an in-flight launch", async () => {
    const launch = deferred<{ readonly id: string }>();
    registryMocks.plugins = [{ id: "terminal", launch: vi.fn(() => launch.promise) }];
    await bootApp([operation("first")]);
    apiMocks.fetchOperations.mockResolvedValue([operation("first"), operation("launched", 2)]);

    await act(async () => {
      canvasMocks.onLaunchAtGeometry?.("terminal", { type: "shell", title: "Shell" }, { x: 0, y: 0, width: 640, height: 400, zIndex: 2 });
      await Promise.resolve();
    });
    await act(async () => {
      setCompanionOperationId("first");
      launch.resolve({ id: "launched" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getCompanionOperationId()).toBe("first");
  });

  it("keeps the destination Theater active and preserves the launch Theater Analyze target", async () => {
    const launch = deferred<{ readonly id: string }>();
    registryMocks.plugins = [{ id: "terminal", launch: vi.fn(() => launch.promise) }];
    await bootApp(
      [operation("a1", 1, "theater-a"), operation("b1", 1, "theater-b")],
      [theater(), theater("theater-b", "Theater B")],
    );
    await act(async () => {
      setCompanionOperationId("a1");
      canvasMocks.onLaunchAtGeometry?.("terminal", { type: "agent", title: "Agent" }, { x: 0, y: 0, width: 640, height: 400, zIndex: 2 });
      await Promise.resolve();
    });
    await act(async () => {
      focusOperation("b1");
      await Promise.resolve();
    });
    apiMocks.fetchOperations.mockResolvedValue([
      operation("a1", 1, "theater-a"),
      operation("launched", 2, "theater-a"),
      operation("b1", 1, "theater-b"),
    ]);

    await act(async () => {
      launch.resolve({ id: "launched" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getState().activeTheaterId).toBe("theater-b");
    expect(getTheaterCompanionOperationId("theater-a")).toBe("a1");
    expect(getCompanionOperationId()).toBeNull();
  });

  it("seeds the click geometry onto the canvas even when plugin launch omits it", async () => {
    const launch = deferred<{ readonly id: string }>();
    registryMocks.plugins = [{ id: "terminal", launch: vi.fn(() => launch.promise) }];
    await bootApp([]);
    const clickGeometry = { x: 480, y: 240, width: 560, height: 360, zIndex: 4 };
    // Shell 런치는 생성 전에 서버 목록을 다시 읽는다. 그 조회가 생성분을 미리 주면 재사용으로 접혀
    // 클릭 좌표를 심지 않는다.
    apiMocks.fetchOperations
      .mockResolvedValueOnce([])
      .mockResolvedValue([operation("launched")]);

    await act(async () => {
      canvasMocks.onLaunchAtGeometry?.("terminal", { type: "shell", title: "Shell" }, clickGeometry);
      launch.resolve({ id: "launched" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getSnapshot().operations.launched).toMatchObject({
      x: clickGeometry.x,
      y: clickGeometry.y,
      width: clickGeometry.width,
      height: clickGeometry.height,
    });
  });

  it("places a Cruise canvas-point launch at the click, not the cascade origin", async () => {
    const launch = deferred<{ readonly id: string }>();
    const launchFn = vi.fn(() => launch.promise);
    registryMocks.plugins = [{ id: "terminal", launch: launchFn }];
    await bootApp([]);
    const canvasPoint = { x: 800, y: 400 };
    const expected = { x: 520, y: 220, width: 560, height: 360 };
    apiMocks.fetchOperations
      .mockResolvedValueOnce([])
      .mockResolvedValue([operation("launched")]);

    await act(async () => {
      canvasMocks.onLaunchKind?.("terminal", { type: "shell", title: "Shell" }, canvasPoint);
      launch.resolve({ id: "launched" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(launchFn).toHaveBeenCalledWith(expect.objectContaining({
      geometry: expect.objectContaining(expected),
    }));
    expect(getSnapshot().operations.launched).toMatchObject(expected);
  });

  it("seeds persisted Operation.geometry onto an empty canvas on hydrate", async () => {
    const persisted = { x: 480, y: 240, width: 560, height: 360, zIndex: 7 };

    await bootApp([{ ...operation("clicked"), geometry: persisted }]);

    expect(getSnapshot().operations.clicked).toMatchObject(persisted);
  });

  it("minimizes a second Theater's existing panels on first in-session view, surfacing only the selected panel", async () => {
    const operations = deferred<readonly OperationNode[]>();
    const theaters = deferred<TheaterBootstrap>();
    apiMocks.fetchOperations.mockReturnValueOnce(operations.promise);
    apiMocks.fetchTheaterBootstrap.mockReturnValueOnce(theaters.promise);
    const { App } = await import("../core/client/src/app.js");

    await act(async () => {
      root!.render(createElement(BrowserRouter, null, createElement(App)));
    });

    // 부팅 응답에는 두 Theater의 기존 패널이 모두 담긴다.
    await act(async () => {
      operations.resolve([
        operation("a1", 1, "theater-a"),
        operation("b1", 1, "theater-b"),
        operation("b2", 1, "theater-b"),
      ]);
      await Promise.resolve();
    });
    await act(async () => {
      theaters.resolve({ theaters: [theater(), theater("theater-b", "Theater B")] });
      await Promise.resolve();
    });

    // 활성 Theater(A)는 부팅 최소화로 깨끗하게 열린다.
    expect(getState().activeTheaterId).toBe("theater-a");
    expect(getSnapshot().minimized).toEqual(["a1"]);

    // 다른 Theater(B)의 패널을 선택 = Theater 전환. B는 이번 세션 최초 진입이므로 기존 패널을 최소화하되,
    // 선택한 b1만 표면화되어 "하나씩" 노출된다. (수정 전에는 B의 모든 패널이 한꺼번에 노출됐다.)
    await act(async () => {
      focusOperation("b1");
      await Promise.resolve();
    });

    expect(getState().activeTheaterId).toBe("theater-b");
    expect(getSnapshot().minimized).toEqual(["b2"]);
    expect(getSnapshot().operations).toHaveProperty("b1");
    expect(getSnapshot().operations).toHaveProperty("b2");
  });

  // 콘솔 전환(로컬↔원격)은 origin을 건너뛰는 전체 페이지 이동이라 App이 통째로 다시 뜬다. 그때마다
  // 부팅 최소화가 다시 걸리면 사용자가 펼쳐둔 패널이 매번 접혀, 오갈 때마다 하나하나 다시 열어야 했다.
  it("keeps a restored panel open when the console reloads inside the same tab session", async () => {
    await bootApp([operation("first"), operation("second")]);
    expect(getSnapshot().minimized).toEqual(["first", "second"]);

    restoreOperation("first");
    expect(getSnapshot().minimized).toEqual(["second"]);

    await reloadTab();
    await bootApp([operation("first"), operation("second")]);

    expect(getSnapshot().minimized).toEqual(["second"]);
  });

  // 세션 단위로 좁힌 것이지 기능을 끈 것이 아니다 — 새 탭은 여전히 깨끗한 Map으로 시작한다.
  it("minimizes boot panels again in a new tab session", async () => {
    await bootApp([operation("first"), operation("second")]);
    restoreOperation("first");
    expect(getSnapshot().minimized).toEqual(["second"]);

    await reloadTab();
    resetBootMinimizationSession();
    await bootApp([operation("first"), operation("second")]);

    // 이미 접혀 있던 패널이 목록 앞자리를 지키므로 순서가 아니라 집합으로 본다.
    expect([...getSnapshot().minimized].sort()).toEqual(["first", "second"]);
  });

  it("boots into War Room when the tab session was left in it", async () => {
    window.sessionStorage.setItem(CANVAS_MODE_STORAGE_KEY, JSON.stringify({ formationTheaters: [], warRoom: true }));

    await bootApp([operation("first")]);

    expect(isTriageActive()).toBe(true);
  });

  it("boots into Cruise when the tab session remembers no mode", async () => {
    await bootApp([operation("first")]);

    expect(isTriageActive()).toBe(false);
  });
});

/**
 * 같은 탭에서 페이지가 다시 뜬 상황을 만든다. localStorage와 sessionStorage는 그대로 두고 React 트리와
 * 캔버스 로드 상태만 부팅 직전으로 되돌린다 — 콘솔 전환이 브라우저에서 일으키는 것과 같은 초기화다.
 *
 * 모듈 메모리도 반드시 함께 비운다. 실제 페이지 로드는 번들을 다시 평가해 모듈 수준 상태를 통째로
 * 날리므로, 그것을 남겨두면 부팅 최소화 표식이 sessionStorage가 아니라 메모리로 살아남아 — 영속화를
 * 지워도 통과하는 — 가짜 초록이 된다.
 */
async function reloadTab(): Promise<void> {
  await act(async () => root?.unmount());
  // 이탈 시점의 캔버스 상태를 localStorage로 흘려보낸 뒤 로드를 비운다.
  loadForTheater(null);
  const survivingSession = window.sessionStorage.getItem(BOOT_MINIMIZATION_STORAGE_KEY);
  resetBootMinimizationSession();
  if (survivingSession !== null) window.sessionStorage.setItem(BOOT_MINIMIZATION_STORAGE_KEY, survivingSession);
  container?.remove();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  setState({ activeOperationId: null, activeTheaterId: null, groups: [], keyboardFocusRequest: null, operations: [], operationsHydrated: false, theaters: [] });
}

async function navigateTo(pathname: string): Promise<void> {
  await act(async () => {
    window.history.pushState({}, "", pathname);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await Promise.resolve();
  });
}

async function bootApp(operationsList: readonly OperationNode[], theaterList = [theater()]): Promise<void> {
  const operations = deferred<readonly OperationNode[]>();
  const theaters = deferred<TheaterBootstrap>();
  apiMocks.fetchOperations.mockReturnValueOnce(operations.promise);
  apiMocks.fetchTheaterBootstrap.mockReturnValueOnce(theaters.promise);
  const { App } = await import("../core/client/src/app.js");
  await act(async () => {
    root!.render(createElement(BrowserRouter, null, createElement(App)));
  });
  await act(async () => {
    operations.resolve(operationsList);
    theaters.resolve({ theaters: theaterList });
    await Promise.resolve();
  });
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function companionKind(canOpenCompanions: NonNullable<OperationKindDescriptor["canOpenCompanions"]>): OperationKindDescriptor {
  return {
    pluginId: "terminal",
    type: "shell",
    title: "Shell",
    companions: [{ id: "analysis", title: "Analysis", render: () => null }],
    canOpenCompanions,
  };
}

function shortcutCompanionKind(): OperationKindDescriptor {
  return {
    pluginId: "terminal",
    type: "shell",
    title: "Shell",
    companions: [{
      id: "streams",
      title: "Streams",
      shortcut: { code: "KeyC", label: "C" },
      render: () => null,
    }],
  };
}

function altKeyDown(code: string, options: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    code,
    key: code,
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  });
}

function theater(id = "theater-a", label = "Theater A") {
  return {
    id,
    label,
    createdAt: "2026-07-12T00:00:00.000Z",
    lastOpenedAt: "2026-07-12T00:00:00.000Z",
    hasWiki: false,
    activeAdmiralCount: 0,
  };
}

// app.tsx는 createdAt < bootOperationsRequestStartedAt인 Operation만 최소화한다. 여유가 1초뿐이면
// 전체 스위트를 병렬로 돌릴 때 스케줄링 지연만으로 "부팅 이후 생성"이 뒤집혀 최소화되어 버린다.
function BOOT_FRESH_CREATED_AT(): number {
  return Date.now() + 60_000;
}

function operation(id: string, createdAt = 1, theaterId = "theater-a"): OperationNode {
  return {
    id,
    theaterId,
    type: "shell",
    pluginId: "terminal",
    title: id,
    payload: {},
    geometry: null,
    ts: { createdAt, updatedAt: createdAt },
  };
}
