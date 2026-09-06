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
