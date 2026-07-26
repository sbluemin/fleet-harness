// @vitest-environment jsdom

import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import type { OperationKindDescriptor } from "@fleet-console/sdk/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearCompanionOperationId, clearFormationView, clearMaximizedOperationId, getCompanionOperationId, getFormationView, getMaximizedOperationId, getSnapshot, getTheaterCompanionOperationId, loadForTheater, minimizeOperation, requestFitAllOperations, resetCanvasViewportSize, restoreOperation, setCanvasViewportSize, setCompanionOperationId, setMaximizedOperationId, setOperationGeometry, setViewport, subscribe as subscribeCanvas, toggleFormationView } from "../core/client/src/canvas/canvas-store.js";
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
  onClose: null as null | ((operationId: string) => void),
  onMinimize: null as null | ((operationId: string) => void),
}));
const canvasMocks = vi.hoisted(() => ({
  onMount: null as null | (() => void | (() => void)),
  onLaunchAtGeometry: null as null | ((pluginId: string, kind: { readonly type: string; readonly title: string }, geometry: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly zIndex: number }) => void),
}));
const registryMocks = vi.hoisted(() => ({
  plugins: [] as Array<Record<string, unknown>>,
  operationKinds: [] as OperationKindDescriptor[],
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
  OperationsCanvas: ({ onLaunchAtGeometry }: { readonly onLaunchAtGeometry: NonNullable<typeof canvasMocks.onLaunchAtGeometry> }) => {
    canvasMocks.onLaunchAtGeometry = onLaunchAtGeometry;
    useLayoutEffect(() => canvasMocks.onMount?.(), []);
    return null;
  },
}));
vi.mock("../core/client/src/components/codex-reading-sheet.js", () => ({ CodexReadingSheet: () => null }));
vi.mock("../core/client/src/components/command-band.js", () => ({ CommandBand: () => null }));
vi.mock("../core/client/src/components/commissioning-overlay.js", () => ({ CommissioningOverlay: () => null }));
vi.mock("../core/client/src/components/keyboard-shortcuts-dialog.js", () => ({ isKeyboardShortcutsModalOpen: () => false, shouldHandleOperationsKeyboardShortcut: keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut }));
vi.mock("../core/client/src/components/operation-search.js", () => ({ OperationSearch: () => null }));
vi.mock("../core/client/src/components/toast.js", () => ({ Toast: () => null }));
vi.mock("../core/client/src/components/whatsnew-modal.js", () => ({ WhatsNewModal: () => null }));
vi.mock("../core/client/src/global-settings-store.js", () => ({
  getGlobalSettingsStoreState: () => ({ state: null }),
  useGlobalSettingsStore: () => ({ state: null }),
}));
vi.mock("../core/client/src/operations-sse.js", () => ({ refreshObserverStatus: vi.fn() }));
vi.mock("../core/client/src/pages/global-settings.js", () => ({ GlobalSettings: () => createElement("div", { "data-route": "settings" }) }));
vi.mock("../core/client/src/plugin-capabilities.js", () => ({ createHostCapabilities: () => ({ api: {} }) }));
vi.mock("../core/client/src/plugin-registry.js", () => ({ usePluginRegistry: () => ({ plugins: registryMocks.plugins, operationKinds: registryMocks.operationKinds, settingsSections: [], notificationKinds: [], railPanels: [] }) }));
vi.mock("../core/client/src/rail/rail-store.js", () => ({ toggleRailChrome: vi.fn() }));
vi.mock("../core/client/src/rail/right-rail.js", () => ({ RightRail: () => null }));
vi.mock("../core/client/src/release-notes-fetch.js", () => ({ abortReleaseNotesFetch: vi.fn(), requestReleaseNotes: vi.fn() }));
// operations.tsx의 Alt 핸들러가 상태축 분기를 위해 이 모듈을 함께 읽으므로, 누락되면 preventDefault 이전에 던진다.
vi.mock("../core/client/src/sidebar/operations-side-bar-store.js", () => ({
  getSideBarState: () => ({ collapsed: false }),
  setSideBarCollapsed: vi.fn(),
  getSideBarStatusAxis: () => false,
  getSideBarStatusSectionCollapsed: () => false,
  subscribeOperationActivityTracking: () => () => {},
  toggleSideBarStatusAxis: vi.fn(),
}));
vi.mock("../core/client/src/sidebar/operations-side-bar.js", () => ({
  OperationsSideBar: ({ onClose, onFocus, onMinimize }: { readonly onClose: (operationId: string) => void; readonly onFocus: (operationId: string) => void; readonly onMinimize: (operationId: string) => void }) => {
    sideBarMocks.onFocus = onFocus;
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
  window.history.replaceState({}, "", "/operations");
  loadForTheater("theater-a");
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
  sideBarMocks.onClose = null;
  sideBarMocks.onMinimize = null;
  canvasMocks.onMount = null;
  canvasMocks.onLaunchAtGeometry = null;
  registryMocks.plugins = [];
  registryMocks.operationKinds = [];
});

afterEach(() => {
  act(() => root?.unmount());
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
});

describe("Operations boot minimization", () => {
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
    await bootApp([operation("visible", Date.now() + 1_000)]);
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
    expect(getSnapshot().viewport).toEqual({ x: 430, y: 330, zoom: 1 });
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
    await bootApp([operation("missing-geometry", Date.now() + 1_000)]);
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
    expect(getSnapshot().viewport).toEqual({ x: 180, y: 200, zoom: 1 });
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
    await bootApp([operation("visible", Date.now() + 1_000)]);
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
    expect(getSnapshot().viewport).toEqual({ x: 430, y: 330, zoom: 1 });
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
    const event = new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, cancelable: true });
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
    const event = new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, cancelable: true });
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
    const event = new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, cancelable: true });
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
    const event = new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, cancelable: true });
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
      canvasMocks.onLaunchAtGeometry?.("terminal", { type: "shell", title: "Shell" }, { x: 0, y: 0, width: 640, height: 400, zIndex: 2 });
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
      canvasMocks.onLaunchAtGeometry?.("terminal", { type: "shell", title: "Shell" }, { x: 0, y: 0, width: 640, height: 400, zIndex: 2 });
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
});

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
