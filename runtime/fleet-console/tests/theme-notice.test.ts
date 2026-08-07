// @vitest-environment jsdom

import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import type { OperationKindDescriptor } from "@fleet-console/sdk/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getState, setActiveTheme, setState } from "../core/client/src/store.js";

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
vi.mock("../core/client/src/canvas/canvas.js", () => ({ OperationsCanvas: () => null }));
vi.mock("../core/client/src/components/codex-reading-sheet.js", () => ({ CodexReadingSheet: () => null }));
vi.mock("../core/client/src/components/command-band.js", () => ({ CommandBand: () => null }));
vi.mock("../core/client/src/components/commissioning-overlay.js", () => ({ CommissioningOverlay: () => null }));
vi.mock("../core/client/src/components/keyboard-shortcuts-dialog.js", () => ({ isKeyboardShortcutsModalOpen: () => false, shouldHandleOperationsKeyboardShortcut: keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut }));
vi.mock("../core/client/src/components/operation-search.js", () => ({ OperationSearch: () => null }));
vi.mock("../core/client/src/components/whatsnew-modal.js", () => ({ WhatsNewModal: () => null }));
vi.mock("../core/client/src/global-settings-store.js", () => ({
  getGlobalSettingsStoreState: () => ({ state: null }),
  useGlobalSettingsStore: () => ({ state: null }),
}));
vi.mock("../core/client/src/operations-sse.js", () => ({ refreshObserverStatus: vi.fn() }));
vi.mock("../core/client/src/pages/global-settings.js", () => ({ GlobalSettings: () => createElement("div", { "data-route": "settings" }) }));
vi.mock("../core/client/src/plugin-capabilities.js", () => ({ createHostCapabilities: () => ({ api: {} }) }));
vi.mock("../core/client/src/plugin-registry.js", () => ({ usePluginRegistry: () => ({ plugins: registryMocks.plugins, operationKinds: registryMocks.operationKinds, settingsSections: [], notificationKinds: [], railPanels: [], floatingWidgets: [] }) }));
vi.mock("../core/client/src/rail/rail-store.js", () => ({ toggleRailChrome: vi.fn() }));
vi.mock("../core/client/src/rail/right-rail.js", () => ({ RightRail: () => null }));
vi.mock("../core/client/src/release-notes-fetch.js", () => ({ abortReleaseNotesFetch: vi.fn(), requestReleaseNotes: vi.fn() }));
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
vi.mock("../core/client/src/sidebar/operations-side-bar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/client/src/sidebar/operations-side-bar.js")>()),
  OperationsSideBar: () => null,
}));
vi.mock("../core/client/src/whatsnew-i18n.js", () => ({
  resolveConsoleLanguage: () => "en",
  resolveReleaseNotesLocale: () => "en",
}));

const THEME_DARK_TITLE = "Console switched to a dark theme — relaunch running CLIs or run /theme to match";
const THEME_LIGHT_TITLE = "Console switched to a light theme — relaunch running CLIs or run /theme to match";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function themeToasts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".app-toast--info"));
}

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/operations");
  setState({
    activeOperationId: null,
    activeTheaterId: null,
    activeTheme: "instrument",
    bootstrapped: false,
    groups: [],
    keyboardFocusRequest: null,
    operations: [],
    operationsHydrated: false,
    theaters: [],
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  apiMocks.fetchTheaters.mockResolvedValue([]);
  apiMocks.fetchOperations.mockResolvedValue([]);
  apiMocks.fetchGroups.mockResolvedValue([]);
  apiMocks.fetchTheaterBootstrap.mockResolvedValue({ theaters: [] });
  keyboardShortcutMocks.shouldHandleOperationsKeyboardShortcut.mockReturnValue(false);
  registryMocks.plugins = [];
  registryMocks.operationKinds = [];
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderApp(): Promise<void> {
  const { App } = await import("../core/client/src/app.js");
  await act(async () => {
    root!.render(createElement(BrowserRouter, null, createElement(App)));
    await Promise.resolve();
  });
}

describe("Theme polarity notice", () => {
  it("fires no toast while boot settles, even when the stored theme flips polarity before bootstrap", async () => {
    // 부팅 중 localStorage→서버 settings 2회 적용으로 극성이 흔들려도 안내가 뜨면 안 된다.
    setState({ activeTheme: "whites", bootstrapped: false });
    await renderApp();
    expect(themeToasts()).toHaveLength(0);

    await act(async () => {
      setState({ bootstrapped: true });
    });
    expect(themeToasts()).toHaveLength(0);
  });

  it("fires exactly one console-level toast on a polarity flip after bootstrap", async () => {
    await renderApp();
    await act(async () => {
      setState({ bootstrapped: true });
    });
    expect(themeToasts()).toHaveLength(0);

    await act(async () => {
      setActiveTheme("whites");
    });
    const toasts = themeToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.querySelector(".app-toast-title")?.textContent).toBe(THEME_LIGHT_TITLE);
    expect(getState().activeTheme).toBe("whites");
  });

  it("stays silent for same-polarity theme changes", async () => {
    await renderApp();
    await act(async () => {
      setState({ bootstrapped: true });
    });

    await act(async () => {
      setActiveTheme("maritime");
    });
    expect(themeToasts()).toHaveLength(0);

    await act(async () => {
      setActiveTheme("carbon");
    });
    expect(themeToasts()).toHaveLength(0);
  });

  it("dismisses manually via the close button and refires on the next flip", async () => {
    await renderApp();
    await act(async () => {
      setState({ bootstrapped: true });
    });
    await act(async () => {
      setActiveTheme("whites");
    });
    expect(themeToasts()).toHaveLength(1);

    const close = document.querySelector<HTMLButtonElement>(".app-toast--info .app-toast-close");
    expect(close).not.toBeNull();
    await act(async () => {
      close!.click();
    });
    expect(themeToasts()).toHaveLength(0);

    await act(async () => {
      setActiveTheme("carbon");
    });
    const toasts = themeToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.querySelector(".app-toast-title")?.textContent).toBe(THEME_DARK_TITLE);
  });

  it("auto-dismisses after the notice window", async () => {
    await renderApp();
    await act(async () => {
      setState({ bootstrapped: true });
    });

    // fake timer는 flip으로 해제 타이머가 예약되기 "전"에 켜야 한다 — real timer로 예약된
    // 타이머는 advanceTimersByTime이 밀어주지 않는다.
    vi.useFakeTimers();
    try {
      await act(async () => {
        setActiveTheme("whites");
      });
      expect(themeToasts()).toHaveLength(1);

      await act(async () => {
        vi.advanceTimersByTime(8_100);
      });
      expect(themeToasts()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
