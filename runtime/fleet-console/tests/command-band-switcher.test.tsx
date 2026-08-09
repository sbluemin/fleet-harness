// @vitest-environment jsdom

import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandBandOperationMenu, CommandBandTheaterMenu } from "../core/client/src/components/command-band-switcher.js";
import { OperationsSideBar } from "../core/client/src/sidebar/operations-side-bar.js";
import { setSideBarCollapsed } from "../core/client/src/sidebar/operations-side-bar-store.js";
import {
  consumeSideBarAddTheater,
  consumeSideBarTheaterLaunch,
  getState,
  requestSideBarAddTheater,
  requestSideBarTheaterLaunch,
} from "../core/client/src/store.js";
import type { OperationNode, TheaterInfo } from "../core/client/src/types.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  setSideBarCollapsed(false);
  consumeSideBarAddTheater();
  consumeSideBarTheaterLaunch();
  // DirectoryBrowserModal은 열리는 즉시 폴더 목록을 fetch한다 — 테스트에서는 pending 상태로 고정한다.
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("side bar request signals", () => {
  it("stores and consumes the Add Theater request", () => {
    expect(getState().pendingSideBarAddTheater).toBe(false);
    requestSideBarAddTheater();
    expect(getState().pendingSideBarAddTheater).toBe(true);
    consumeSideBarAddTheater();
    expect(getState().pendingSideBarAddTheater).toBe(false);
  });

  it("stores and consumes the Theater launch request", () => {
    expect(getState().pendingSideBarTheaterLaunch).toBeNull();
    requestSideBarTheaterLaunch("theater-b");
    expect(getState().pendingSideBarTheaterLaunch).toBe("theater-b");
    consumeSideBarTheaterLaunch();
    expect(getState().pendingSideBarTheaterLaunch).toBeNull();
  });
});

describe("CommandBandTheaterMenu", () => {
  it("lists every Theater with mark, ops meta, and checked active row plus the Add Theater action", () => {
    const onSelectTheater = vi.fn();
    renderMenu(createElement(CommandBandTheaterMenu, {
      theaters: [makeTheater("theater-a", "fleet-harness"), makeTheater("theater-b", "Bravo")],
      operations: [makeOperation("op-1", "theater-a"), makeOperation("op-2", "theater-a"), makeOperation("op-3", "theater-b")],
      activeTheaterId: "theater-a",
      addingTheater: false,
      onSelectTheater,
      onAddTheater: vi.fn(),
      containerRef: createRef<HTMLDivElement>(),
    }));

    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Switch Theater"]');
    expect(menu).not.toBeNull();
    const radios = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    expect(radios).toHaveLength(2);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
    expect(radios[0]?.className).toContain("is-active");
    expect(radios[0]?.querySelector(".command-band-theater-mark")?.textContent).toBe("FH");
    expect(radios[0]?.querySelector(".command-band-menu-meta")?.textContent).toBe("2 ops");
    expect(radios[1]?.getAttribute("aria-checked")).toBe("false");
    expect(radios[1]?.querySelector(".command-band-menu-meta")?.textContent).toBe("1 op");
    const action = menu?.querySelector<HTMLButtonElement>(".command-band-menu-action");
    expect(action?.textContent).toContain("Add Theater…");
    expect(menu?.querySelector(".command-band-menu-divider")).not.toBeNull();

    act(() => radios[1]?.click());
    expect(onSelectTheater).toHaveBeenCalledWith("theater-b");
  });

  it("moves focus with arrow keys and starts from the checked row", () => {
    renderMenu(createElement(CommandBandTheaterMenu, {
      theaters: [makeTheater("theater-a", "Alpha"), makeTheater("theater-b", "Bravo")],
      operations: [],
      activeTheaterId: "theater-b",
      addingTheater: false,
      onSelectTheater: vi.fn(),
      onAddTheater: vi.fn(),
      containerRef: createRef<HTMLDivElement>(),
    }));

    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    const items = Array.from(menu?.querySelectorAll<HTMLButtonElement>(".command-band-menu-item") ?? []);
    expect(document.activeElement).toBe(items[1]);

    act(() => {
      menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(items[2]);

    act(() => {
      menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(document.activeElement).toBe(items[0]);

    act(() => {
      menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(document.activeElement).toBe(items[2]);
  });
});

describe("CommandBandOperationMenu", () => {
  it("lists active-Theater Operations with CLI meta plus Rename and New Operation rows", () => {
    const onSelectOperation = vi.fn();
    const onRenameOperation = vi.fn();
    renderMenu(createElement(CommandBandOperationMenu, {
      operations: [
        { ...makeOperation("op-1", "theater-a"), payload: { cliLabel: "Claude Code" } },
        makeOperation("op-2", "theater-a"),
      ],
      activeOperationId: "op-1",
      theaterLabel: "Alpha",
      onSelectOperation,
      onRenameOperation,
      onNewOperation: vi.fn(),
      containerRef: createRef<HTMLDivElement>(),
    }));

    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Switch operation"]');
    const radios = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    expect(radios).toHaveLength(2);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
    expect(radios[0]?.querySelector(".command-band-menu-meta")?.textContent).toBe("Claude Code");
    const actionItems = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    expect(actionItems.map((item) => item.textContent)).toEqual(["Rename current operation…", "New Operation in Alpha…"]);

    act(() => radios[1]?.click());
    expect(onSelectOperation).toHaveBeenCalledWith("op-2");
    act(() => actionItems[0]?.click());
    expect(onRenameOperation).toHaveBeenCalledTimes(1);
  });

  it("omits the Rename row without an active Operation and notes an empty Theater", () => {
    renderMenu(createElement(CommandBandOperationMenu, {
      operations: [],
      activeOperationId: null,
      theaterLabel: "Alpha",
      onSelectOperation: vi.fn(),
      onRenameOperation: null,
      onNewOperation: vi.fn(),
      containerRef: createRef<HTMLDivElement>(),
    }));

    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu?.querySelector(".command-band-menu-empty")?.textContent).toBe("No operations in this Theater");
    const actionItems = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    expect(actionItems.map((item) => item.textContent)).toEqual(["New Operation in Alpha…"]);
  });
});

describe("side bar signal consumption", () => {
  it("consumes the Add Theater request by expanding the side bar and opening the Theater browser", () => {
    setSideBarCollapsed(true);
    renderSideBar();
    expect(document.querySelector(".directory-browser-overlay")).toBeNull();

    act(() => requestSideBarAddTheater());

    expect(getState().pendingSideBarAddTheater).toBe(false);
    expect(container?.querySelector('[data-sidebar-state="expanded"]')).not.toBeNull();
    expect(document.querySelector(".directory-browser-overlay")).not.toBeNull();
  });

  it("consumes the Theater launch request by opening the launch menu at the Theater's New Operation button", async () => {
    const onSelectTheater = vi.fn();
    renderSideBar(onSelectTheater);
    expect(document.querySelector(".canvas-context-menu-head")).toBeNull();

    act(() => requestSideBarTheaterLaunch("theater-b"));

    // jsdom 기하는 항상 0이라 width 전환 미정착 경로(220ms 지연 실측)를 탄다. consume도 실측 시점에 일어난다.
    await act(() => new Promise((resolve) => setTimeout(resolve, 240)));
    expect(getState().pendingSideBarTheaterLaunch).toBeNull();
    expect(document.querySelector(".canvas-context-menu-head")).not.toBeNull();
    expect(onSelectTheater).toHaveBeenCalledWith("theater-b");
  });
});

function renderMenu(element: ReturnType<typeof createElement>): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

function renderSideBar(onSelectTheater = vi.fn()): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(MemoryRouter, null, createElement(OperationsSideBar, {
    theaters: [makeTheater("theater-a", "Alpha"), makeTheater("theater-b", "Bravo")],
    activeTheaterId: "theater-a",
    operations: [makeOperation("op-a", "theater-a"), makeOperation("op-b", "theater-b")],
    groups: [],
    minimized: [],
    activeOperationId: "op-a",
    operationNotifications: {},
    catalog: [],
    canLaunch: true,
    addingTheater: false,
    theaterError: null,
    renderKindIcon: () => null,
    onLaunchKind: () => {},
    onResetView: () => {},
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
    onSelectTheater,
    onAddTheater: () => {},
    onCancelAddTheater: () => {},
    onForgetTheater: () => {},
  }))));
}

function makeTheater(id: string, label: string): TheaterInfo {
  return { id, label, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 0 };
}

function makeOperation(id: string, theaterId: string): OperationNode {
  return {
    id,
    theaterId,
    type: "shell",
    pluginId: "terminal",
    title: id,
    payload: {},
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
  };
}
