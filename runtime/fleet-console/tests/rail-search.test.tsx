// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RailPanelDescriptor, RailSearchProvider, RailSearchResult } from "@fleet-console/sdk/rail";

import { OperationSearch } from "../core/client/src/components/operation-search.js";
import { useConsoleState } from "../core/client/src/hooks/use-store.js";
import type { PaletteSearchPanel } from "../core/client/src/operation-search.js";
import {
  RAIL_SEARCH_DEBOUNCE_MS,
  RAIL_SEARCH_PROVIDER_LIMIT,
  RAIL_SEARCH_PROVIDER_TIMEOUT_MS,
  searchRailPanels,
} from "../core/client/src/operation-search.js";
import { closeRailPanel, getRailStoreSnapshot, setRailChromeExpanded } from "../core/client/src/rail/rail-store.js";
import { getExpandedSurfaceState, resetExpandedSurfacesForTest } from "../core/client/src/expanded-surface/store.js";
import { getState, setState } from "../core/client/src/store.js";

// 팔레트가 페인 레지스트리를 읽으므로 그 모듈을 대역으로 세운다. 실물을 태우면
// plugin-registry가 번들러 가상 모듈(virtual:fleet-plugins)을 끌어와 해석 단계에서 막힌다.
vi.mock("../core/client/src/pane/pane-registry.js", () => ({
  useRailEntries: () => [],
  usePaneIndex: () => new Map(),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let panels: readonly (RailPanelDescriptor | PaletteSearchPanel)[] = [];
let pathname = "";
let scrollIntoViewDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  document.body.replaceChildren();
  scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  for (const id of [...getRailStoreSnapshot().pinnedPanelIds]) closeRailPanel(id);
  setRailChromeExpanded(false);
  resetExpandedSurfacesForTest();
  setState({
    ...getState(),
    activeTheaterId: "theater-a",
    theaters: [{
      id: "theater-a",
      label: "Theater A",
      createdAt: "2026-07-25T00:00:00.000Z",
      lastOpenedAt: "2026-07-25T00:00:00.000Z",
      hasWiki: false,
      activeAdmiralCount: 0,
    }],
    operations: [],
    operationSearchOpen: true,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  if (scrollIntoViewDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  document.body.replaceChildren();
  panels = [];
  pathname = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("rail search fan-out", () => {
  it("enforces the provider timeout and per-provider result cap while isolating failures", async () => {
    const slow = vi.fn<RailSearchProvider>(() => new Promise(() => undefined));
    const failed = vi.fn<RailSearchProvider>(async () => { throw new Error("failed"); });
    const fast = vi.fn<RailSearchProvider>(async ({ limit }) => {
      expect(limit).toBe(RAIL_SEARCH_PROVIDER_LIMIT);
      return Array.from({ length: 12 }, (_, index) => result(`fast-${index}`));
    });
    const abort = new AbortController();
    const pending = searchRailPanels([
      panel("slow", "Slow", slow),
      panel("failed", "Failed", failed),
      panel("fast", "Fast", fast),
    ], "needle", "theater-a", abort.signal);

    await vi.advanceTimersByTimeAsync(RAIL_SEARCH_PROVIDER_TIMEOUT_MS);
    const groups = await pending;

    expect(groups.map((group) => group.panelId)).toEqual(["fast"]);
    expect(groups[0]?.results).toHaveLength(RAIL_SEARCH_PROVIDER_LIMIT);
    expect(slow.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it("does not fan out for an empty query, bare command mode, or a missing Theater", async () => {
    const provider = vi.fn<RailSearchProvider>(async () => []);
    panels = [panel("files", "Files", provider)];
    renderPalette();

    await advanceDebounce();
    expect(provider).not.toHaveBeenCalled();

    setInput(">");
    await advanceDebounce();
    expect(provider).not.toHaveBeenCalled();

    act(() => setState({ activeTheaterId: null }));
    setInput("needle");
    await advanceDebounce();
    expect(provider).not.toHaveBeenCalled();
  });

  it("mixes rail matches after commands in command mode and selects them with the shared index", async () => {
    const activate = vi.fn();
    const provider = vi.fn<RailSearchProvider>(async ({ query }) => {
      expect(query).toBe("file");
      return [result("file-a", "File A", activate)];
    });
    panels = [panel("files", "Files", provider)];
    renderPalette();

    setInput(">file");
    await advanceDebounce();

    const headings = [...container.querySelectorAll(".operation-search-section-heading")].map((node) => node.textContent);
    expect(headings).toEqual(["Commands", "Files"]);
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("Open panel: Files"),
      expect.stringContaining("File A"),
    ]);

    const input = container.querySelector<HTMLInputElement>("#operation-search-input");
    act(() => input!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    expect(input?.getAttribute("aria-activedescendant")).toBe("operation-search-option-panel-files-file-a");
    expect(input?.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(activate).toHaveBeenCalledOnce();
  });

  it("renders info results as read-only metadata outside keyboard navigation", async () => {
    const activateReal = vi.fn();
    const activateInfo = vi.fn();
    const provider = vi.fn<RailSearchProvider>(async () => [
      result("file-a", "File A", activateReal),
      { id: "cap-marker", title: "Search limit reached", activate: activateInfo, kind: "info" },
    ]);
    panels = [panel("files", "Files", provider)];
    renderPalette();

    setInput("needle");
    await advanceDebounce();

    // info 행은 읽기 전용 — option 역할도 "열기" 어포던스도 없다.
    const marker = container.querySelector(".operation-search-panel-info");
    expect(marker?.textContent).toContain("Search limit reached");
    expect(marker?.getAttribute("role")).toBeNull();
    const options = [...container.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.some((option) => option.textContent?.includes("Search limit reached"))).toBe(false);

    // 키보드 날비는 info 행을 건어너뛰고 실결과에만 멈춘다.
    const input = container.querySelector<HTMLInputElement>("#operation-search-input");
    act(() => input!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    expect(input?.getAttribute("aria-activedescendant")).toBe("operation-search-option-panel-files-file-a");
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(activateReal).toHaveBeenCalledOnce();
    expect(activateInfo).not.toHaveBeenCalled();
  });

  it("debounces providers and discards a response that arrives after abort via the generation fence", async () => {
    const requests = new Map<string, { readonly signal: AbortSignal; readonly resolve: (results: readonly RailSearchResult[]) => void }>();
    const provider = vi.fn<RailSearchProvider>(({ query, signal }) => new Promise((resolve) => {
      requests.set(query, { signal, resolve });
    }));
    panels = [panel("repository", "Repository", provider)];
    renderPalette();

    setInput("old");
    await act(async () => { await vi.advanceTimersByTimeAsync(RAIL_SEARCH_DEBOUNCE_MS - 1); });
    expect(provider).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(provider).toHaveBeenCalledTimes(1);

    setInput("new");
    await advanceDebounce();
    expect(requests.get("old")?.signal.aborted).toBe(true);
    expect(provider).toHaveBeenCalledTimes(2);

    await act(async () => {
      requests.get("new")?.resolve([result("new-result", "New result")]);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("New result");

    await act(async () => {
      requests.get("old")?.resolve([result("old-result", "Old result")]);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("New result");
    expect(container.textContent).not.toContain("Old result");
  });

  it("runs activate before routing to Operations and opening the owning panel", async () => {
    let finishActivation: (() => void) | undefined;
    const activate = vi.fn(() => new Promise<void>((resolve) => { finishActivation = resolve; }));
    panels = [panel("files", "Files", async () => [result("file-a", "File A", activate)])];
    renderPalette("/settings");

    setInput("file");
    await advanceDebounce();
    const option = container.querySelector<HTMLButtonElement>(".operation-search-panel-result");
    expect(option?.textContent).toContain("File A");

    act(() => option!.click());
    expect(activate).toHaveBeenCalledOnce();
    expect(pathname).toBe("/settings");
    expect(getRailStoreSnapshot().pinnedPanelIds).not.toContain("files");
    expect(getRailStoreSnapshot()).toMatchObject({ railChromeExpanded: false });

    await act(async () => {
      finishActivation?.();
      await Promise.resolve();
    });
    expect(pathname).toBe("/operations");
    expect(getRailStoreSnapshot().pinnedPanelIds).toContain("files");
    expect(getRailStoreSnapshot()).toMatchObject({ railChromeExpanded: true });
  });

  // 페인을 세우지 않고 확대 표면을 여는 기여(Shell·Repository)도 찾을 것을 갖는다. 그 결과는
  // 레일 패널로 착지할 수 없으므로, 엔트리가 말한 표면이 대신 열려야 한다 — 갈라 주지 않으면
  // 팔레트로 고른 결과가 아무 데도 도착하지 않는다.
  it("lands a surface entry's result on that surface, not on a rail panel", async () => {
    panels = [{
      id: "repository",
      title: "Repository",
      surfaceId: "repository",
      search: async () => [result("commit-a", "Fix the tide model")],
    }];
    renderPalette("/settings");

    setInput("tide");
    await advanceDebounce();
    const option = container.querySelector<HTMLButtonElement>(".operation-search-panel-result");
    expect(option?.textContent).toContain("Fix the tide model");

    await act(async () => {
      option!.click();
      await Promise.resolve();
    });

    expect(getExpandedSurfaceState().instances.map((instance) => instance.surfaceId)).toEqual(["repository"]);
    expect(getRailStoreSnapshot().activeRailPanelId).toBeNull();
  });

  it("keeps matching Operations above panel groups", async () => {
    panels = [panel("files", "Files", async () => [result("file", "Needle file")])];
    act(() => setState({
      operations: [{
        id: "operation-a",
        theaterId: "theater-a",
        type: "shell",
        pluginId: "terminal",
        title: "Needle Operation",
        payload: {},
        geometry: null,
        ts: { createdAt: 1, updatedAt: 1 },
      }],
    }));
    renderPalette();
    setInput("needle");
    await advanceDebounce();

    const headings = [...container.querySelectorAll(".operation-search-section-heading")].map((node) => node.textContent);
    expect(headings).toEqual(["Theater A", "Files"]);
    expect(container.textContent).toContain("Needle Operation");
    expect(container.textContent).toContain("Needle file");
  });
});

function renderPalette(initialPath = "/operations"): void {
  act(() => {
    root.render(createElement(
      MemoryRouter,
      { initialEntries: [initialPath] },
      createElement(PaletteHarness),
      createElement(LocationProbe),
    ));
  });
  act(() => { vi.advanceTimersByTime(0); });
}

function PaletteHarness() {
  return createElement(OperationSearch, { state: useConsoleState(), railPanels: panels as readonly PaletteSearchPanel[], plugins: [] });
}

function LocationProbe() {
  pathname = useLocation().pathname;
  return null;
}

function setInput(value: string): void {
  const input = container.querySelector<HTMLInputElement>("#operation-search-input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function advanceDebounce(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RAIL_SEARCH_DEBOUNCE_MS);
    await Promise.resolve();
  });
}

function panel(id: string, title: string, search: RailSearchProvider): RailPanelDescriptor {
  return { id, title, icon: null, render: () => null, search };
}

function result(id: string, title = id, activate: RailSearchResult["activate"] = () => undefined): RailSearchResult {
  return { id, title, activate };
}
