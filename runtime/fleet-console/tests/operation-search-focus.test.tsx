// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const codexApiMocks = vi.hoisted(() => ({ fetchSearch: vi.fn() }));
vi.mock("../core/client/src/codex/api.js", () => codexApiMocks);

import { OperationSearch } from "../core/client/src/components/operation-search.js";
import { takeKeyboardShortcutsReturnFocus } from "../core/client/src/shortcuts.js";
import { useConsoleState } from "../core/client/src/hooks/use-store.js";
import { getSideBarState, setSideBarCollapsed } from "../core/client/src/sidebar/operations-side-bar-store.js";
import { closeOperationSearch, getState, openOperationSearch, setState, toggleOperationSearch } from "../core/client/src/store.js";

let container: HTMLDivElement | null = null;
let previousFocus: HTMLButtonElement | null = null;
let root: Root | null = null;
let scrollIntoViewDescriptor: PropertyDescriptor | undefined;
let canUndoLastClose = false;
let onUndoLastClose = vi.fn();
const readCanUndoLastClose = () => canUndoLastClose;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  canUndoLastClose = false;
  onUndoLastClose = vi.fn();
  codexApiMocks.fetchSearch.mockReset();
  codexApiMocks.fetchSearch.mockResolvedValue({ entries: [], total: 0 });
  setSideBarCollapsed(false);

  previousFocus = document.createElement("button");
  previousFocus.textContent = "Previous control";
  container = document.createElement("div");
  document.body.append(previousFocus, container);
  previousFocus.focus();

  setState({
    activeTheaterId: "theater-a",
    activeOperationId: null,
    theaters: [{
      id: "theater-a",
      label: "Theater A",
      createdAt: "2026-07-20T00:00:00.000Z",
      lastOpenedAt: "2026-07-20T00:00:00.000Z",
      hasWiki: true,
      activeAdmiralCount: 0,
    }],
    operations: [{
      id: "operation-a",
      theaterId: "theater-a",
      type: "shell",
      pluginId: "terminal",
      title: "Operation A",
      payload: {},
      geometry: null,
      ts: { createdAt: 1, updatedAt: 1 },
    }],
    operationSearchOpen: true,
    operationSearchSeed: null,
    quickLaunchOpen: false,
    quickLaunchPinned: false,
    quickLaunchFocusToggle: 0,
    quickLaunchExpandRequest: 0,
    quickLaunchDockSuppressed: false,
    quickLaunchDraft: null,
    quickLaunchError: null,
    pendingQuickLaunch: null,
    pendingOperationFocus: null,
    keyboardFocusRequest: null,
    pendingSideBarAddTheater: false,
    pendingSideBarTheaterLaunch: null,
  });

  root = createRoot(container);
  act(() => root!.render(createElement(MemoryRouter, null, createElement(SearchHarness))));
});

afterEach(() => {
  act(() => root?.unmount());
  if (scrollIntoViewDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
  document.body.replaceChildren();
  root = null;
  container = null;
  previousFocus = null;
  vi.restoreAllMocks();
});

describe("Operation search focus handoff", () => {
  it("consumes an opening seed once and lets Backspace return to operation search", () => {
    act(() => setState({ operationSearchOpen: false }));
    act(() => openOperationSearch(">"));

    const input = document.querySelector<HTMLInputElement>("#operation-search-input");
    expect(input?.value).toBe(">");
    expect(input?.selectionStart).toBe(1);
    expect(document.querySelector("#operation-search-heading-commands")?.textContent).toBe("Commands");

    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setInputValue.call(input, "");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => setState({ operationSearchSeed: ">add theater" }));

    expect(input?.value).toBe("");
    expect(document.querySelector('[role="option"]')?.textContent).toContain("Operation A");

    act(() => closeOperationSearch());
    expect(getState()).toMatchObject({ operationSearchOpen: false, operationSearchSeed: null });
    act(() => openOperationSearch(">"));
    act(() => toggleOperationSearch());
    expect(getState()).toMatchObject({ operationSearchOpen: false, operationSearchSeed: null });
  });

  it("does not restore the previous focus after selecting an Operation", () => {
    const restoreFocus = vi.spyOn(previousFocus!, "focus");
    const result = document.querySelector<HTMLButtonElement>('[role="option"]');
    expect(result).not.toBeNull();

    act(() => result!.click());

    expect(restoreFocus).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("navigates to /operations before opening a rail panel command from another route", () => {
    // 커맨드 모드의 open-rail-panel은 rail이 operations 페이지에만 마운트되므로 다른 경로에서 먼저 이동해야 한다.
    act(() => root!.render(createElement(
      MemoryRouter,
      { key: "settings-route", initialEntries: ["/settings"] },
      createElement(SearchHarness),
      createElement(LocationProbe),
    )));
    expect(observedPathname).toBe("/settings");

    const input = document.querySelector<HTMLInputElement>("#operation-search-input");
    expect(input).not.toBeNull();
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setInputValue.call(input, ">open panel alerts");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const commandOption = document.querySelector<HTMLButtonElement>('[role="option"]');
    expect(commandOption?.textContent).toContain("Open panel: Alerts");

    act(() => commandOption!.click());

    expect(observedPathname).toBe("/operations");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });


  it("hands the palette opener to the keyboard shortcuts return-focus channel", () => {
    // 팔레트 경유로 다이얼로그를 열면 App 캡처 시점의 activeElement가 제거 중인 팔레트 내부라,
    // 팔레트를 연 시점의 요소를 채널로 전달해야 닫힘 시 그 요소로 복원된다.
    const input = document.querySelector<HTMLInputElement>("#operation-search-input");
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setInputValue.call(input, ">keyboard");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const commandOption = document.querySelector<HTMLButtonElement>('[role="option"]');
    expect(commandOption?.textContent).toContain("Open keyboard shortcuts");

    act(() => commandOption!.click());

    expect(takeKeyboardShortcutsReturnFocus()).toBe(previousFocus);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps the opening-time Undo row snapshot while rechecking availability at execution time", () => {
    act(() => setState({ operationSearchOpen: false }));
    canUndoLastClose = true;
    act(() => setState({ operationSearchOpen: true }));
    const input = document.querySelector<HTMLInputElement>("#operation-search-input");
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setInputValue.call(input, ">undo");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const commandOption = document.querySelector<HTMLButtonElement>('[role="option"]');
    expect(commandOption?.textContent).toContain("Undo last close");

    canUndoLastClose = false;
    act(() => root!.render(createElement(MemoryRouter, null, createElement(SearchHarness))));
    const retainedCommandOption = document.querySelector<HTMLButtonElement>('[role="option"]');
    expect(retainedCommandOption?.textContent).toContain("Undo last close");
    act(() => input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));

    expect(onUndoLastClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("routes to Operations, expands the sidebar, and requests the Add Theater flow", () => {
    setSideBarCollapsed(true);
    act(() => root!.render(createElement(
      MemoryRouter,
      { key: "add-theater-route", initialEntries: ["/settings"] },
      createElement(SearchHarness),
      createElement(LocationProbe),
    )));
    const input = document.querySelector<HTMLInputElement>("#operation-search-input");
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setInputValue.call(input, ">add theater");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const commandOption = document.querySelector<HTMLButtonElement>('[role="option"]');
    expect(commandOption?.textContent).toContain("Add Theater…");
    act(() => commandOption!.click());

    expect(observedPathname).toBe("/operations");
    expect(getSideBarState().collapsed).toBe(false);
    expect(getState().pendingSideBarAddTheater).toBe(true);
  });

  it("restores the previous focus after Escape cancellation", () => {
    const restoreFocus = vi.spyOn(previousFocus!, "focus");
    const input = document.querySelector<HTMLInputElement>("#operation-search-input");
    expect(input).not.toBeNull();

    act(() => input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

    expect(restoreFocus).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(previousFocus);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

function SearchHarness() {
  return createElement(OperationSearch, {
    state: useConsoleState(),
    railPanels: [{ id: "alerts", title: "Alerts" }],
    plugins: [],
    canUndoLastClose: readCanUndoLastClose,
    onUndoLastClose,
  });
}

let observedPathname = "";

function LocationProbe() {
  observedPathname = useLocation().pathname;
  return null;
}
