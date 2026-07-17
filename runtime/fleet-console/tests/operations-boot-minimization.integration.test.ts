// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSnapshot, loadForTheater, restoreOperation, setOperationGeometry } from "../core/client/src/canvas/canvas-store.js";
import { focusOperation, getState, hydrateOperations, setState } from "../core/client/src/store.js";
import type { OperationNode, TheaterBootstrap } from "../core/client/src/types.js";

const apiMocks = vi.hoisted(() => ({
  fetchTheaterBootstrap: vi.fn(),
  fetchOperations: vi.fn(),
  fetchGroups: vi.fn(),
}));
const keyboardShortcutMocks = vi.hoisted(() => ({
  shouldHandleOperationsKeyboardShortcut: vi.fn(),
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
  renameOperation: vi.fn(),
  updateGroup: vi.fn(),
}));

vi.mock("@fleet-console/sdk/operations/browser", () => ({ fetchOperationCatalog: vi.fn().mockResolvedValue([]) }));
vi.mock("../core/client/src/canvas/canvas.js", () => ({ OperationsCanvas: () => null }));
vi.mock("../core/client/src/components/codex-reading-sheet.js", () => ({ CodexReadingSheet: () => null }));
vi.mock("../core/client/src/components/command-band.js", () => ({ CommandBand: () => null }));
vi.mock("../core/client/src/components/commissioning-overlay.js", () => ({ CommissioningOverlay: () => null }));
vi.mock("../core/client/src/components/keyboard-shortcuts-dialog.js", () => ({ isKeyboardShortcutsModalOpen: () => false, shouldHandleOperationsKeyboardShortcut: keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut }));
vi.mock("../core/client/src/components/operation-search.js", () => ({ OperationSearch: () => null }));
vi.mock("../core/client/src/components/toast.js", () => ({ Toast: () => null }));
vi.mock("../core/client/src/components/whatsnew-modal.js", () => ({ WhatsNewModal: () => null }));
vi.mock("../core/client/src/global-settings-store.js", () => ({ useGlobalSettingsStore: () => ({ state: null }) }));
vi.mock("../core/client/src/operations-sse.js", () => ({ refreshObserverStatus: vi.fn() }));
vi.mock("../core/client/src/pages/global-settings.js", () => ({ GlobalSettings: () => createElement("div", { "data-route": "settings" }) }));
vi.mock("../core/client/src/plugin-capabilities.js", () => ({ createHostCapabilities: () => ({ api: {} }) }));
vi.mock("../core/client/src/plugin-registry.js", () => ({ usePluginRegistry: () => ({ plugins: [], operationKinds: [], settingsSections: [], notificationKinds: [], railPanels: [] }) }));
vi.mock("../core/client/src/rail/rail-store.js", () => ({ toggleRailChrome: vi.fn() }));
vi.mock("../core/client/src/rail/right-rail.js", () => ({ RightRail: () => null }));
vi.mock("../core/client/src/release-notes-fetch.js", () => ({ abortReleaseNotesFetch: vi.fn(), requestReleaseNotes: vi.fn() }));
vi.mock("../core/client/src/sidebar/operations-side-bar-store.js", () => ({ getSideBarState: () => ({ collapsed: false }), setSideBarCollapsed: vi.fn() }));
vi.mock("../core/client/src/sidebar/operations-side-bar.js", () => ({ OperationsSideBar: () => null }));
vi.mock("../core/client/src/whatsnew-i18n.js", () => ({ resolveReleaseNotesLocale: () => "en" }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/operations");
  loadForTheater(null);
  setState({ activeOperationId: null, activeTheaterId: null, groups: [], operations: [], operationsHydrated: false, theaters: [] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  apiMocks.fetchGroups.mockResolvedValue([]);
  keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut.mockReturnValue(false);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("Operations boot minimization", () => {
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

  it("consumes Alt+Arrow without restoring a minimized panel", async () => {
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

    keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut.mockReturnValue(true);
    const event = new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(true);
    expect(getState().activeOperationId).toBeNull();
    expect(getSnapshot().minimized).toEqual(["initial"]);
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

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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
