// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OperationSearch } from "../core/client/src/components/operation-search.js";
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
  return createElement(OperationSearch, { state: useConsoleState() });
}
