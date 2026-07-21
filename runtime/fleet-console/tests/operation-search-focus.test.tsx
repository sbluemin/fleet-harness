// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OperationSearch } from "../core/client/src/components/operation-search.js";
import { takeKeyboardShortcutsReturnFocus } from "../core/client/src/keyboard-shortcuts-return-focus.js";
import { useConsoleState } from "../core/client/src/hooks/use-store.js";
import { setState } from "../core/client/src/store.js";

let container: HTMLDivElement | null = null;
let previousFocus: HTMLButtonElement | null = null;
let root: Root | null = null;
let scrollIntoViewDescriptor: PropertyDescriptor | undefined;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });

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
      hasWiki: false,
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
  return createElement(OperationSearch, { state: useConsoleState(), railPanels: [{ id: "alerts", title: "Alerts" }] });
}

let observedPathname = "";

function LocationProbe() {
  observedPathname = useLocation().pathname;
  return null;
}
