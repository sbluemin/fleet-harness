// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadForTheater } from "../core/client/src/canvas/canvas-store.js";
import { requestSideBarOperationAction } from "../core/client/src/sidebar/operation-action-request.js";
import { OperationsSideBar } from "../core/client/src/sidebar/operations-side-bar.js";
import { setSideBarCollapsed, setTheaterCollapsed } from "../core/client/src/sidebar/operations-side-bar-store.js";
import type { OperationGroup, OperationNode, TheaterInfo } from "../core/client/src/types.js";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let scrollIntoViewDescriptor: PropertyDescriptor | undefined;
const scrollIntoView = vi.fn();

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  scrollIntoView.mockClear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  document.body.replaceChildren();
  window.localStorage.clear();
  setSideBarCollapsed(false);
  setTheaterCollapsed("theater-a", false);
  loadForTheater("theater-a");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  if (scrollIntoViewDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  document.body.replaceChildren();
  root = null;
  container = null;
  loadForTheater(null);
});

describe("sidebar context menu keyboard path", () => {
  it("opens the Operation menu with Shift+F10, roves cyclically, and restores focus on Escape", async () => {
    renderSideBar();
    const chip = required<HTMLElement>('[data-side-bar-chip-id="operation-a"]');
    chip.focus();

    dispatchKey(chip, "F10", { shiftKey: true });
    await nextFrame();

    const menu = required<HTMLElement>('.group-context-menu-card[role="menu"]');
    const items = menuItems(menu);
    expect(chip.getAttribute("aria-haspopup")).toBe("menu");
    expect(items).toHaveLength(11);
    expect(document.activeElement).toBe(items[0]);
    expect(items.filter((item) => item.tabIndex === 0)).toEqual([items[0]]);

    dispatchKey(items[0]!, "ArrowUp");
    expect(document.activeElement?.textContent).toContain("Rose");
    expect(menuItems(menu).filter((item) => item.tabIndex === 0)).toEqual([document.activeElement]);

    dispatchKey(document.activeElement as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(items[0]);

    dispatchKey(items[0]!, "Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("focuses the first accent for a palette set-accent request while preserving the full menu loop and Escape return", async () => {
    renderSideBar();
    const chip = required<HTMLElement>('[data-side-bar-chip-id="operation-a"]');

    act(() => requestSideBarOperationAction(OPERATION.id, "set-accent"));
    await nextFrame();

    const menu = required<HTMLElement>('.group-context-menu-card[role="menu"]');
    const items = menuItems(menu);
    expect(document.activeElement?.getAttribute("data-accent-option")).toBe("none");
    expect(document.activeElement?.textContent).toContain("None");
    expect(items.filter((item) => item.tabIndex === 0)).toEqual([document.activeElement]);

    const accentIndex = items.findIndex((item) => item.hasAttribute("data-accent-option"));
    expect(accentIndex).toBeGreaterThan(0);
    dispatchKey(document.activeElement as HTMLElement, "ArrowUp");
    expect(document.activeElement).toBe(items[accentIndex - 1]);
    expect(document.activeElement?.hasAttribute("data-accent-option")).toBe(false);

    dispatchKey(document.activeElement as HTMLElement, "ArrowDown");
    expect(document.activeElement?.getAttribute("data-accent-option")).toBe("none");

    dispatchKey(document.activeElement as HTMLElement, "Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("scrolls an offscreen chip into view before anchoring the palette menu", async () => {
    renderSideBar();
    const chip = required<HTMLElement>('[data-side-bar-chip-id="operation-a"]');
    let rectReadBeforeScroll: number | null = null;
    const originalRect = chip.getBoundingClientRect.bind(chip);
    chip.getBoundingClientRect = () => {
      rectReadBeforeScroll ??= scrollIntoView.mock.calls.length;
      return originalRect();
    };

    act(() => requestSideBarOperationAction(OPERATION.id, "set-accent"));
    await nextFrame();

    // rect를 읽는 시점에 이미 스크롤이 끝나 있어야 메뉴가 화면 안에 앵커링된다.
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(rectReadBeforeScroll).toBeGreaterThan(0);
  });

  it("keeps the first menu item focused for a palette assign-group request", async () => {
    renderSideBar();

    act(() => requestSideBarOperationAction(OPERATION.id, "assign-group"));
    await nextFrame();

    const menu = required<HTMLElement>('.group-context-menu-card[role="menu"]');
    const items = menuItems(menu);
    expect(document.activeElement).toBe(items[0]);
    expect(document.activeElement?.hasAttribute("data-accent-option")).toBe(false);
    expect(items.filter((item) => item.tabIndex === 0)).toEqual([items[0]]);
  });

  it("opens the Theater actions menu from the row with ContextMenu and applies the same focus loop", async () => {
    renderSideBar();
    const row = required<HTMLElement>(".side-bar-theater-header");
    row.focus();

    dispatchKey(row, "ContextMenu");
    await nextFrame();

    const menu = required<HTMLElement>('.side-bar-theater-menu[role="menu"]');
    const items = menuItems(menu);
    expect(row.getAttribute("aria-haspopup")).toBe("menu");
    expect(document.activeElement).toBe(items[0]);
    expect(items[0]?.textContent).toContain("New group…");

    dispatchKey(items[0]!, "ArrowUp");
    expect(document.activeElement?.textContent).toContain("Forget Theater");
    dispatchKey(document.activeElement as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(items[0]);

    dispatchKey(items[0]!, "Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("executes the focused existing menu item with Enter", async () => {
    renderSideBar();
    const chip = required<HTMLElement>('[data-side-bar-chip-id="operation-a"]');
    dispatchKey(chip, "F10", { shiftKey: true });
    await nextFrame();
    const firstItem = required<HTMLButtonElement>('.group-context-menu-card button[data-accent-option="none"]');
    const click = vi.fn();
    firstItem.addEventListener("click", click);
    firstItem.focus();

    dispatchKey(firstItem, "Enter");

    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // Escape뿐 아니라 항목 실행으로 닫힐 때도 포커스가 칩으로 돌아와야 한다.
    expect(document.activeElement).toBe(chip);
  });

});

function renderSideBar(): void {
  act(() => root?.render(createElement(MemoryRouter, null, createElement(OperationsSideBar, {
    theaters: [THEATER],
    activeTheaterId: THEATER.id,
    operations: [OPERATION],
    groups: [GROUP],
    minimized: [],
    activeOperationId: OPERATION.id,
    operationNotifications: {},
    catalog: [],
    canLaunch: true,
    addingTheater: false,
    theaterError: null,
    renderKindIcon: () => null,
    onLaunchKind: vi.fn(),
    onClose: vi.fn(),
    onMinimize: vi.fn(),
    onFocus: vi.fn(),
    onSetAccent: vi.fn(),
    onRename: vi.fn(),
    onSetGroupId: vi.fn(),
    onCreateGroup: vi.fn(),
    onSetGroupColor: vi.fn(),
    onRenameGroup: vi.fn(),
    onReorderGroups: vi.fn(),
    onReorderTheaters: vi.fn(),
    onUngroupAll: vi.fn(),
    onSelectTheater: vi.fn(),
    onAddTheater: vi.fn(),
    onCancelAddTheater: vi.fn(),
    onForgetTheater: vi.fn(),
  }))));
}

function dispatchKey(target: HTMLElement, key: string, options: KeyboardEventInit = {}): void {
  act(() => target.dispatchEvent(new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  })));
}

async function nextFrame(): Promise<void> {
  await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
}

function menuItems(menu: HTMLElement): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]'));
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
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

const OPERATION: OperationNode = {
  id: "operation-a",
  theaterId: THEATER.id,
  type: "shell",
  pluginId: "terminal",
  title: "Bridge",
  payload: {},
  geometry: null,
  groupId: "group-a",
  ts: { createdAt: 1, updatedAt: 1 },
};

const GROUP: OperationGroup = {
  id: "group-a",
  theaterId: THEATER.id,
  name: "Crew",
  color: "cerulean",
  order: 0,
  createdAt: 1,
};
