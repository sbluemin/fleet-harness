// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadForTheater } from "../core/client/src/canvas/canvas-store.js";
import { OperationsSideBar } from "../core/client/src/sidebar/operations-side-bar.js";
import { setSideBarCollapsed, setTheaterCollapsed } from "../core/client/src/sidebar/operations-side-bar-store.js";
import type { OperationGroup, OperationNode, TheaterInfo } from "../core/client/src/types.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  setSideBarCollapsed(false);
  setTheaterCollapsed("theater-a", false);
  setTheaterCollapsed("theater-b", false);
  loadForTheater("theater-a");
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  loadForTheater(null);
});

describe("inactive Theater sidebar hierarchy", () => {
  it("renders every stored Operation in its group and ungrouped sections without a more summary", () => {
    const onFocus = vi.fn();
    writeTheaterBSnapshot();
    renderSideBar(onFocus);

    const inactive = findInactiveSection();
    expect(inactive.querySelectorAll("[data-side-bar-chip-id]")).toHaveLength(6);
    expect(inactive.querySelectorAll(".side-bar-group-section [data-side-bar-chip-id]")).toHaveLength(5);
    expect(Array.from(inactive.querySelectorAll<HTMLElement>("[data-side-bar-chip-id]")).map((chip) => chip.dataset.sideBarChipId)).toEqual([
      "op-b-5", "op-b-4", "op-b-3", "op-b-2", "op-b-1", "op-b-free",
    ]);
    expect(inactive.querySelector('[data-side-bar-chip-id="op-b-5"]')?.className).toContain("side-bar-chip--minimized");
    expect(inactive.querySelector<HTMLElement>('[data-side-bar-chip-id="op-b-5"]')?.style.getPropertyValue("--user-accent")).not.toBe("");
    expect(inactive.querySelector(".side-bar-ungrouped-label")?.textContent).toContain("Ungrouped");
    expect(inactive.textContent).not.toContain("more");
    expect(inactive.querySelector(".side-bar-group-header")).not.toBeNull();

    act(() => inactive.querySelector<HTMLElement>('[data-side-bar-chip-id="op-b-5"]')?.click());
    expect(onFocus).toHaveBeenCalledWith("op-b-5");
  });

  it("displays and toggles the inactive Theater's persisted collapsed group state", () => {
    writeTheaterBSnapshot(["group-b"]);
    renderSideBar();

    const inactive = findInactiveSection();
    const toggle = inactive.querySelector<HTMLButtonElement>('[aria-label="Expand group Bridge crew"]');
    expect(toggle).not.toBeNull();
    expect(inactive.querySelectorAll(".side-bar-group-section [data-side-bar-chip-id]")).toHaveLength(0);

    act(() => toggle?.click());

    expect(inactive.querySelector<HTMLButtonElement>('[aria-label="Collapse group Bridge crew"]')).not.toBeNull();
    expect(inactive.querySelectorAll(".side-bar-group-section [data-side-bar-chip-id]")).toHaveLength(5);
    expect(JSON.parse(window.localStorage.getItem("fleet-console.canvas.theater-b") ?? "{}").collapsedGroups).toEqual([]);
  });

  it("toggles the inactive Theater directly without selecting it", () => {
    const onSelectTheater = vi.fn();
    writeTheaterBSnapshot();
    renderSideBar(undefined, onSelectTheater);

    const inactive = findInactiveSection();
    const collapse = inactive.querySelector<HTMLButtonElement>(".side-bar-theater-collapse-btn");
    expect(collapse?.getAttribute("aria-label")).toBe("Collapse Bravo");

    act(() => collapse?.click());

    expect(onSelectTheater).not.toHaveBeenCalled();
    expect(collapse?.getAttribute("aria-label")).toBe("Expand Bravo");
    expect(inactive.querySelector(".side-bar-group-header")).toBeNull();
    expect(inactive.querySelector("[data-side-bar-chip-id]")).toBeNull();

    act(() => collapse?.click());

    expect(onSelectTheater).not.toHaveBeenCalled();
    expect(inactive.querySelector(".side-bar-group-header")).not.toBeNull();
    expect(inactive.querySelectorAll("[data-side-bar-chip-id]")).toHaveLength(6);
  });

  it("hides inactive Group headers and Operations when the Theater section is collapsed", () => {
    writeTheaterBSnapshot();
    setTheaterCollapsed("theater-b", true);
    renderSideBar();

    const inactive = findInactiveSection();
    expect(inactive.querySelector(".side-bar-group-header")).toBeNull();
    expect(inactive.querySelector("[data-side-bar-chip-id]")).toBeNull();
  });
});

function renderSideBar(onFocus = vi.fn(), onSelectTheater = vi.fn()): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(MemoryRouter, null, createElement(OperationsSideBar, {
    theaters: [makeTheater("theater-a", "Alpha"), makeTheater("theater-b", "Bravo")],
    activeTheaterId: "theater-a",
    operations: [makeOperation("op-a", "theater-a"), ...THEATER_B_OPERATIONS],
    groups: [GROUP_B],
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
    onFocus,
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

function findInactiveSection(): HTMLElement {
  const inactive = container?.querySelector<HTMLElement>('[data-theater-id="theater-b"]');
  if (!inactive) throw new Error("Missing inactive Theater section");
  return inactive;
}

function writeTheaterBSnapshot(collapsedGroups: readonly string[] = []): void {
  window.localStorage.setItem("fleet-console.canvas.theater-b", JSON.stringify({
    viewport: { x: 0, y: 0, zoom: 1 },
    operations: Object.fromEntries(THEATER_B_OPERATIONS.map((operation) => [operation.id, { x: 0, y: 0, width: 640, height: 400, zIndex: 0 }])),
    operationOrder: ["op-b-5", "op-b-4", "op-b-3", "op-b-2", "op-b-1", "op-b-free"],
    operationAccent: { "op-b-5": "rose" },
    minimized: ["op-b-5"],
    collapsedGroups,
  }));
}

function makeTheater(id: string, label: string): TheaterInfo {
  return { id, label, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 0 };
}

function makeOperation(id: string, theaterId: string, groupId: string | null = null): OperationNode {
  return {
    id,
    theaterId,
    type: "shell",
    pluginId: "terminal",
    title: id,
    payload: {},
    geometry: null,
    groupId,
    ts: { createdAt: 1, updatedAt: 1 },
  };
}

const GROUP_B: OperationGroup = { id: "group-b", name: "Bridge crew", color: "blue", order: 0, theaterId: "theater-b", createdAt: 1 };
const THEATER_B_OPERATIONS = [
  makeOperation("op-b-1", "theater-b", "group-b"),
  makeOperation("op-b-2", "theater-b", "group-b"),
  makeOperation("op-b-3", "theater-b", "group-b"),
  makeOperation("op-b-4", "theater-b", "group-b"),
  makeOperation("op-b-5", "theater-b", "group-b"),
  makeOperation("op-b-free", "theater-b"),
];
