// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadForTheater } from "../core/client/src/canvas/canvas-store.js";
import { OperationsSideBar } from "../core/client/src/sidebar/operations-side-bar.js";
import {
  getSideBarState,
  MIN_EXPANDED_PX,
  setSideBarCollapsed,
  setSideBarWidth,
} from "../core/client/src/sidebar/operations-side-bar-store.js";
import { TriageSideBar } from "../core/client/src/sidebar/triage-side-bar.js";
import type { TheaterInfo } from "../core/client/src/types.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  setSideBarWidth(400);
  setSideBarCollapsed(false);
  loadForTheater(THEATER.id);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  loadForTheater(null);
  setSideBarWidth(MIN_EXPANDED_PX);
  setSideBarCollapsed(false);
  window.localStorage.clear();
});

describe("shared side bar resize", () => {
  it("renders the shared resize handle in both side bars", () => {
    renderTriageSideBar();
    expect(required(".operations-side-bar-resize-handle")).not.toBeNull();

    act(() => root?.unmount());
    container?.replaceChildren();
    root = createRoot(container!);
    act(() => root?.render(operationsSideBarElement()));

    expect(required(".operations-side-bar-resize-handle")).not.toBeNull();
  });

  it("resizes the War Room side bar and marks only the active drag", () => {
    renderTriageSideBar();
    const handle = required<HTMLElement>(".operations-side-bar-resize-handle");
    const aside = required<HTMLElement>(".triage-side-bar");

    act(() => {
      handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100 }));
    });
    expect(aside.getAttribute("data-resizing")).toBe("true");

    act(() => {
      document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 160 }));
    });
    expect(getSideBarState().width).toBe(460);

    act(() => {
      document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    expect(aside.getAttribute("data-resizing")).toBeNull();
  });

  it("toggles the shared collapsed state from the War Room handle", () => {
    renderTriageSideBar();
    const handle = required<HTMLElement>(".operations-side-bar-resize-handle");

    act(() => {
      handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    expect(getSideBarState().collapsed).toBe(true);
    expect(required<HTMLElement>(".triage-side-bar").classList.contains("is-closed")).toBe(true);
  });
});

function renderTriageSideBar(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onPick = vi.fn();
  const onClose = vi.fn();
  const onRename = vi.fn();
  act(() => root?.render(createElement(TriageSideBar, {
    theaters: [{ id: THEATER.id, label: THEATER.label }],
    operations: [],
    operationRuntime: {},
    operationNotifications: {},
    catalog: [],
    plugins: [],
    renderKindIcon: () => null,
    onPick,
    onClose,
    onRename,
  })));
}

function operationsSideBarElement() {
  return createElement(MemoryRouter, null, createElement(OperationsSideBar, {
    theaters: [THEATER],
    activeTheaterId: THEATER.id,
    operations: [],
    groups: [],
    minimized: [],
    activeOperationId: null,
    operationNotifications: {},
    catalog: [],
    canLaunch: true,
    addingTheater: false,
    theaterError: null,
    renderKindIcon: () => null,
    onLaunchKind: () => {},
    onClose: () => {},
    onMinimize: () => {},
    onFocus: () => {},
    onResume: () => {},
    onSetAccent: () => {},
    onRename: () => {},
    onSetGroupId: () => {},
    onCreateGroup: () => {},
    onSetGroupColor: () => {},
    onRenameGroup: () => {},
    onReorderGroups: () => {},
    onReorderTheaters: () => {},
    onUngroupAll: () => {},
    onSelectTheater: () => {},
    onAddTheater: () => {},
    onCancelAddTheater: () => {},
    onForgetTheater: () => {},
  }));
}

function required<T extends Element = Element>(selector: string): T {
  const element = container?.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

const THEATER: TheaterInfo = {
  id: "theater-a",
  label: "Alpha",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastOpenedAt: "2026-01-01T00:00:00.000Z",
  hasWiki: false,
  activeAdmiralCount: 0,
};
