// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSnapshot, loadForTheater, setOperationOrder } from "../core/client/src/canvas/canvas-store.js";
import { OperationsSideBar } from "../core/client/src/sidebar/operations-side-bar.js";
import { setSideBarCollapsed, setSideBarStatusAxis, setTheaterCollapsed } from "../core/client/src/sidebar/operations-side-bar-store.js";
import { setState as setConsoleState } from "../core/client/src/store.js";
import type { OperationGroup, OperationNode, TheaterInfo } from "../core/client/src/types.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  setSideBarCollapsed(false);
  setSideBarStatusAxis(false);
  setTheaterCollapsed("theater-a", false);
  loadForTheater("theater-a");
  setConsoleState({ operationStatus: {} });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  setSideBarStatusAxis(false);
  setConsoleState({ operationStatus: {} });
  loadForTheater(null);
});

describe("OperationsSideBar STATUS axis", () => {
  it("toggles from GROUP to ordered status sections, hides the live tick, and renders group identity pills without row beacons", () => {
    const operations = [
      makeOperation("idle", null),
      makeOperation("running", "group-a"),
      makeOperation("awaiting", "group-a", "rose"),
      makeOperation("dormant", null),
    ];
    setOperationOrder(operations.map((operation) => operation.id));
    setConsoleState({
      operationStatus: {
        running: "running",
        awaiting: "awaiting",
        dormant: "dormant",
      },
    });
    renderSideBar(operations, [GROUP_A]);

    const toggle = required<HTMLButtonElement>(".side-bar-status-axis-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.title).toBe("Sort by status (Alt+S)");
    expect(toggle.querySelector(".side-bar-status-axis-live-tick")).not.toBeNull();
    expect(container?.querySelector(".side-bar-group-header")).not.toBeNull();

    act(() => toggle.click());

    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.querySelector(".side-bar-status-axis-live-tick")).toBeNull();
    expect(Array.from(container?.querySelectorAll(".side-bar-status-header__label") ?? []).map((node) => node.textContent)).toEqual([
      "AWAITING INPUT",
      "RUNNING",
      "IDLE",
      "DORMANT",
    ]);
    expect(container?.querySelector(".side-bar-group-header")).toBeNull();
    expect(required<HTMLElement>('[data-side-bar-chip-id="awaiting"]').style.getPropertyValue("--user-accent")).toBe("var(--id-rose)");
    const pill = required<HTMLElement>('[data-side-bar-chip-id="awaiting"] .side-bar-chip-group-pill');
    expect(pill.title).toBe("Alpha crew");
    expect(pill.getAttribute("aria-label")).toBe("Group Alpha crew");
    expect(pill.textContent).toBe("Alpha crew");
    expect(pill.style.getPropertyValue("--group-mark")).toBe("var(--id-cerulean)");
    expect(container?.querySelector('[data-side-bar-chip-id="awaiting"] .side-bar-chip-group-mark')).toBeNull();
    expect(container?.querySelector('[data-side-bar-chip-id="awaiting"] .side-bar-chip-status')).toBeNull();
    expect(container?.querySelector('[data-side-bar-chip-id="idle"] .side-bar-chip-group-pill')).toBeNull();
    expect(required<HTMLElement>('[data-side-bar-chip-id="awaiting"]').dataset.reorderEnabled).toBe("false");
  });

  it("pins all four slots, defaults empty sections collapsed, and toggles empty and occupied sections independently", () => {
    setConsoleState({ operationStatus: { only: "running" } });
    setSideBarStatusAxis(true);
    renderSideBar([makeOperation("only", null)]);

    const sections = Array.from(container?.querySelectorAll<HTMLElement>(".side-bar-status-section") ?? []);
    expect(sections).toHaveLength(4);
    expect(sections.map((section) => section.querySelector(".side-bar-status-header__count")?.textContent)).toEqual(["0", "1", "0", "0"]);

    const awaiting = required<HTMLElement>(".side-bar-status-section--awaiting");
    expect(awaiting.className).toContain("side-bar-status-section--empty");
    const awaitingToggle = required<HTMLButtonElement>('.side-bar-status-section--awaiting [aria-label="Expand section AWAITING INPUT"]');
    expect(awaitingToggle.getAttribute("aria-expanded")).toBe("false");
    expect(awaiting.querySelector(".side-bar-status-empty-hint")).toBeNull();

    act(() => awaitingToggle.click());

    expect(required<HTMLButtonElement>('.side-bar-status-section--awaiting [aria-label="Collapse section AWAITING INPUT"]').title).toBe("Collapse");
    expect(required<HTMLElement>(".side-bar-status-section--awaiting .side-bar-status-empty-hint").textContent).toBe("No operations");

    const runningToggle = required<HTMLButtonElement>('.side-bar-status-section--running [aria-label="Collapse section RUNNING"]');
    expect(runningToggle.getAttribute("aria-expanded")).toBe("true");
    act(() => runningToggle.click());
    expect(required<HTMLButtonElement>('.side-bar-status-section--running [aria-label="Expand section RUNNING"]').title).toBe("Expand");
    expect(container?.querySelector('[data-side-bar-chip-id="only"]')).toBeNull();
    act(() => required<HTMLButtonElement>('.side-bar-status-section--running [aria-label="Expand section RUNNING"]').click());
    expect(container?.querySelector('[data-side-bar-chip-id="only"]')).not.toBeNull();
  });

  it("suppresses both group pills and status beacons in inactive Theater preview chips", () => {
    setConsoleState({ operationStatus: { preview: "awaiting" } });
    setSideBarStatusAxis(true);
    renderSideBar([makeOperation("preview", "group-a")], [GROUP_A], vi.fn(), "theater-other");

    const preview = required<HTMLElement>('[data-side-bar-chip-id="preview"]');
    expect(preview.querySelector(".side-bar-chip-group-pill")).toBeNull();
    expect(preview.querySelector(".side-bar-chip-group-mark")).toBeNull();
    expect(preview.querySelector(".side-bar-chip-status")).toBeNull();
  });

  it("keeps keyboard reordering disabled in STATUS and unchanged in GROUP", () => {
    const operations = [
      makeOperation("first", null),
      makeOperation("second", null),
    ];
    setOperationOrder(["first", "second"]);
    setConsoleState({ operationStatus: { first: "running", second: "running" } });
    setSideBarStatusAxis(true);
    renderSideBar(operations);

    const first = required<HTMLElement>('[data-side-bar-chip-id="first"]');
    act(() => first.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      shiftKey: true,
      bubbles: true,
    })));

    expect(getSnapshot().operationOrder).toEqual(["first", "second"]);

    act(() => required<HTMLButtonElement>(".side-bar-status-axis-toggle").click());
    const groupFirst = required<HTMLElement>('[data-side-bar-chip-id="first"]');
    act(() => groupFirst.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      shiftKey: true,
      bubbles: true,
    })));

    expect(getSnapshot().operationOrder).toEqual(["second", "first"]);
  });

  it("flashes a chip once when a live status change moves it between sections", () => {
    const operations = [makeOperation("moving", null)];
    setConsoleState({ operationStatus: { moving: "running" } });
    setSideBarStatusAxis(true);
    renderSideBar(operations);

    expect(required<HTMLElement>('[data-side-bar-chip-id="moving"]').className).not.toContain("side-bar-chip--status-landed");

    act(() => setConsoleState({ operationStatus: { moving: "awaiting" } }));

    expect(required<HTMLElement>('[data-side-bar-chip-id="moving"]').className).toContain("side-bar-chip--status-landed");
    expect(required<HTMLElement>(".side-bar-status-header__label").textContent).toBe("AWAITING INPUT");
  });

  it("uses the Theater name row for persisted collapse and exposes the split control accessibility contract", () => {
    const onSelectTheater = vi.fn();
    renderSideBar([makeOperation("only", null)], [], onSelectTheater);

    expect(container?.querySelector(".side-bar-theater-count")).toBeNull();
    expect(container?.querySelector(".side-bar-theater-collapse-btn")).toBeNull();
    expect(required<HTMLButtonElement>(".side-bar-theater-split-plus").getAttribute("aria-label")).toBe("New Operation in Alpha");
    const caret = required<HTMLButtonElement>(".side-bar-theater-split-caret");
    expect(caret.getAttribute("aria-haspopup")).toBe("menu");
    expect(caret.getAttribute("aria-expanded")).toBe("false");
    expect(caret.querySelectorAll("circle")).toHaveLength(3);
    expect(caret.querySelector("path")).toBeNull();

    act(() => required<HTMLElement>(".side-bar-theater-header").click());

    // 활성 Theater 행 클릭은 접기 토글만 수행한다 — 재선택하지 않는다.
    // (비활성 Theater 클릭은 선택만 하고 접기 상태를 건드리지 않는 것이 행 제스처 계약이다.)
    expect(onSelectTheater).not.toHaveBeenCalled();
    expect(required<HTMLElement>(".side-bar-theater-header").getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem("fleet-console.operations.theater-collapsed")).toBe('["theater-a"]');
  });

  it("selects an inactive Theater on row click without mutating its persisted collapse preference", () => {
    setTheaterCollapsed("theater-a", true);
    const onSelectTheater = vi.fn();
    renderSideBar([makeOperation("only", null)], [], onSelectTheater, "theater-other");

    act(() => required<HTMLElement>(".side-bar-theater-header").click());

    expect(onSelectTheater).toHaveBeenCalledWith("theater-a");
    // 비활성 클릭=선택만 — 접힘 영속 키는 그대로 남는다.
    expect(window.localStorage.getItem("fleet-console.operations.theater-collapsed")).toBe('["theater-a"]');
  });
});

function renderSideBar(
  operations: readonly OperationNode[],
  groups: readonly OperationGroup[] = [],
  onSelectTheater = vi.fn(),
  activeTheaterId: string = THEATER.id,
): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(MemoryRouter, null, createElement(OperationsSideBar, {
    theaters: [THEATER],
    activeTheaterId,
    operations,
    groups,
    minimized: [],
    activeOperationId: null,
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

function required<T extends Element>(selector: string): T {
  const element = container?.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

function makeOperation(id: string, groupId: string | null, accent?: string): OperationNode {
  return {
    id,
    theaterId: THEATER.id,
    type: "shell",
    pluginId: "terminal",
    title: id,
    payload: {},
    geometry: null,
    groupId,
    accent,
    ts: { createdAt: 1, updatedAt: 1 },
  };
}

const THEATER: TheaterInfo = {
  id: "theater-a",
  label: "Alpha",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastOpenedAt: "2026-01-01T00:00:00.000Z",
  hasWiki: false,
  activeAdmiralCount: 0,
};

const GROUP_A: OperationGroup = {
  id: "group-a",
  name: "Alpha crew",
  color: "blue",
  order: 0,
  theaterId: THEATER.id,
  createdAt: 1,
};
