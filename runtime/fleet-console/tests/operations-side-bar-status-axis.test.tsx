// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSnapshot, loadForTheater, setOperationOrder } from "../core/client/src/canvas/canvas-store.js";
import { getIdleArrivalIds, markIdleArrival } from "../core/client/src/operation-idle-arrival.js";
import { requestSideBarOperationAction } from "../core/client/src/sidebar/operation-action-request.js";
import { OperationsSideBar } from "../core/client/src/sidebar/operations-side-bar.js";
import {
  getSideBarStatusSectionCollapsed,
  getStatusTransitionTick,
  resetSideBarStatusRecencyForTests,
  resetSideBarStatusSectionCollapseForTests,
  setSideBarCollapsed,
  setSideBarStatusAxis,
  setTheaterCollapsed,
  toggleSideBarStatusSectionCollapsed,
  trackOperationActivityTransitions,
} from "../core/client/src/sidebar/operations-side-bar-store.js";
import { setActiveOperation, setState as setConsoleState } from "../core/client/src/store.js";
import type { OperationGroup, OperationNode, TheaterInfo } from "../core/client/src/types.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  setSideBarCollapsed(false);
  setSideBarStatusAxis(false);
  resetSideBarStatusRecencyForTests();
  resetSideBarStatusSectionCollapseForTests();
  setTheaterCollapsed("theater-a", false);
  setTheaterCollapsed("theater-b", false);
  loadForTheater("theater-a");
  setConsoleState({ operationStatus: {} });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  setSideBarStatusAxis(false);
  resetSideBarStatusRecencyForTests();
  resetSideBarStatusSectionCollapseForTests();
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
      "AWAITING",
      "RUNNING",
      "IDLE",
      "DORMANT",
    ]);
    expect(container?.querySelector(".side-bar-group-header")).toBeNull();
    expect(required<HTMLElement>('[data-side-bar-chip-id="awaiting"]').style.getPropertyValue("--user-accent")).toBe("var(--id-rose)");
    const pill = required<HTMLElement>('[data-side-bar-chip-id="awaiting"] .side-bar-chip-group-pill');
    expect(pill.title).toBe("Alpha crew");
    expect(pill.getAttribute("aria-hidden")).toBe("true");
    expect(pill.getAttribute("aria-label")).toBeNull();
    expect(pill.textContent).toBe("Alpha crew");
    expect(pill.style.getPropertyValue("--group-mark")).toBe("var(--id-cerulean)");
    expect(required<HTMLElement>('[data-side-bar-chip-id="awaiting"]').getAttribute("aria-label"))
      .toBe("Focus operation awaiting in group Alpha crew");
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
    const awaitingToggle = required<HTMLButtonElement>('.side-bar-status-section--awaiting [aria-label="Expand section AWAITING"]');
    expect(awaitingToggle.getAttribute("aria-expanded")).toBe("false");
    expect(awaiting.querySelector(".side-bar-status-empty-hint")).toBeNull();

    act(() => awaitingToggle.click());

    expect(required<HTMLButtonElement>('.side-bar-status-section--awaiting [aria-label="Collapse section AWAITING"]').title).toBe("Collapse");
    expect(required<HTMLElement>(".side-bar-status-section--awaiting .side-bar-status-empty-hint").textContent).toBe("No operations");

    const runningToggle = required<HTMLButtonElement>('.side-bar-status-section--running [aria-label="Collapse section RUNNING"]');
    expect(runningToggle.getAttribute("aria-expanded")).toBe("true");
    act(() => runningToggle.click());
    expect(required<HTMLButtonElement>('.side-bar-status-section--running [aria-label="Expand section RUNNING"]').title).toBe("Expand");
    expect(container?.querySelector('[data-side-bar-chip-id="only"]')).toBeNull();
    act(() => required<HTMLButtonElement>('.side-bar-status-section--running [aria-label="Expand section RUNNING"]').click());
    expect(container?.querySelector('[data-side-bar-chip-id="only"]')).not.toBeNull();
  });

  it("reveals an idle arrival from the AWAITING section for a palette action", () => {
    const operation = makeOperation("arrived", null);
    setConsoleState({ operationStatus: { arrived: "idle" } });
    markIdleArrival(operation.id);
    setSideBarStatusAxis(true);
    toggleSideBarStatusSectionCollapsed(THEATER.id, "awaiting", false);
    renderSideBar([operation]);
    expect(getSideBarStatusSectionCollapsed(THEATER.id, "awaiting", false)).toBe(true);

    act(() => requestSideBarOperationAction(operation.id, "rename"));

    expect(getSideBarStatusSectionCollapsed(THEATER.id, "awaiting", false)).toBe(false);
    expect(getSideBarStatusSectionCollapsed(THEATER.id, "idle", true)).toBe(true);
  });

  it("continues to reveal an ordinary idle Operation from the IDLE section", () => {
    const operation = makeOperation("idle", null);
    setConsoleState({ operationStatus: { idle: "idle" } });
    setSideBarStatusAxis(true);
    toggleSideBarStatusSectionCollapsed(THEATER.id, "idle", false);
    renderSideBar([operation]);
    expect(getSideBarStatusSectionCollapsed(THEATER.id, "idle", false)).toBe(true);

    act(() => requestSideBarOperationAction(operation.id, "rename"));

    expect(getSideBarStatusSectionCollapsed(THEATER.id, "idle", false)).toBe(false);
    expect(getSideBarStatusSectionCollapsed(THEATER.id, "awaiting", true)).toBe(true);
  });

  it("keeps an explicit empty-section expansion when an Operation enters and leaves again", () => {
    setSideBarStatusAxis(true);
    renderSideBar([]);

    act(() => required<HTMLButtonElement>('.side-bar-status-section--awaiting [aria-label="Expand section AWAITING"]').click());
    expect(required<HTMLElement>(".side-bar-status-section--awaiting .side-bar-status-empty-hint").textContent).toBe("No operations");

    act(() => setConsoleState({ operationStatus: { arriving: "awaiting" } }));
    rerenderSideBar([makeOperation("arriving", null)]);

    expect(required<HTMLButtonElement>('.side-bar-status-section--awaiting [aria-label="Collapse section AWAITING"]').getAttribute("aria-expanded")).toBe("true");
    expect(container?.querySelector('[data-side-bar-chip-id="arriving"]')).not.toBeNull();

    act(() => setConsoleState({ operationStatus: {} }));
    rerenderSideBar([]);

    expect(required<HTMLButtonElement>('.side-bar-status-section--awaiting [aria-label="Collapse section AWAITING"]').getAttribute("aria-expanded")).toBe("true");
    expect(required<HTMLElement>(".side-bar-status-section--awaiting .side-bar-status-empty-hint").textContent).toBe("No operations");
  });

  it("isolates the same status collapse toggle by Theater key", () => {
    const operations = [
      makeOperation("alpha-running", null),
      makeOperation("bravo-running", null, undefined, THEATER_B.id),
    ];
    setConsoleState({ operationStatus: { "alpha-running": "running", "bravo-running": "running" } });
    setSideBarStatusAxis(true);
    renderSideBar(operations, [], vi.fn(), THEATER.id, [THEATER, THEATER_B]);

    const alpha = required<HTMLElement>(`[data-theater-id="${THEATER.id}"]`);
    const bravo = required<HTMLElement>(`[data-theater-id="${THEATER_B.id}"]`);
    act(() => alpha.querySelector<HTMLButtonElement>('.side-bar-status-section--running [aria-label="Collapse section RUNNING"]')?.click());

    expect(alpha.querySelector('[data-side-bar-chip-id="alpha-running"]')).toBeNull();
    expect(bravo.querySelector('[data-side-bar-chip-id="bravo-running"]')).not.toBeNull();
    expect(bravo.querySelector('.side-bar-status-section--running [aria-label="Collapse section RUNNING"]')).not.toBeNull();

    act(() => bravo.querySelector<HTMLButtonElement>('.side-bar-status-section--running [aria-label="Collapse section RUNNING"]')?.click());

    expect(alpha.querySelector('.side-bar-status-section--running [aria-label="Expand section RUNNING"]')).not.toBeNull();
    expect(bravo.querySelector('.side-bar-status-section--running [aria-label="Expand section RUNNING"]')).not.toBeNull();
  });

  it("suppresses group pills and status beacons but shows idle unseen in inactive Theater preview chips", () => {
    setConsoleState({ operationStatus: { preview: "running" } });
    setSideBarStatusAxis(true);
    renderSideBar([makeOperation("preview", "group-a")], [GROUP_A], vi.fn(), "theater-other");

    const preview = required<HTMLElement>('[data-side-bar-chip-id="preview"]');
    expect(preview.querySelector(".side-bar-chip-group-pill")).toBeNull();
    expect(preview.querySelector(".side-bar-chip-group-mark")).toBeNull();
    expect(preview.querySelector(".side-bar-chip-status")).toBeNull();

    act(() => setConsoleState({ operationStatus: { preview: "idle" } }));

    expect(required<HTMLElement>('[data-side-bar-chip-id="preview"] .side-bar-chip-unseen')).not.toBeNull();
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
    expect(required<HTMLElement>(".side-bar-status-header__label").textContent).toBe("AWAITING");
  });

  it("puts the most recently transitioned Operation first and keeps untouched Operations in operationOrder", () => {
    const operations = [
      makeOperation("untouched-first", null),
      makeOperation("latest", null),
      makeOperation("earlier", null),
      makeOperation("untouched-second", null),
    ];
    setOperationOrder(operations.map((operation) => operation.id));
    setConsoleState({ operationStatus: Object.fromEntries(operations.map((operation) => [operation.id, "running"])) });
    setSideBarStatusAxis(true);
    renderSideBar(operations);

    act(() => setConsoleState({ operationStatus: {
      "untouched-first": "running",
      latest: "running",
      earlier: "idle",
      "untouched-second": "running",
    } }));
    act(() => setConsoleState({ operationStatus: {
      "untouched-first": "running",
      latest: "running",
      earlier: "running",
      "untouched-second": "running",
    } }));
    act(() => setConsoleState({ operationStatus: {
      "untouched-first": "running",
      latest: "idle",
      earlier: "running",
      "untouched-second": "running",
    } }));
    act(() => setConsoleState({ operationStatus: {
      "untouched-first": "running",
      latest: "running",
      earlier: "running",
      "untouched-second": "running",
    } }));

    const runningIds = Array.from(
      required<HTMLElement>(".side-bar-status-section--running").querySelectorAll<HTMLElement>("[data-side-bar-chip-id]"),
      (chip) => chip.dataset.sideBarChipId,
    );
    expect(runningIds).toEqual(["latest", "earlier", "untouched-first", "untouched-second"]);
  });

  it("renders synchronous running to idle recorded while unmounted without retroactive landing flash", () => {
    const operations = [
      makeOperation("untouched", null),
      makeOperation("recorded", null),
    ];
    setOperationOrder(operations.map((operation) => operation.id));
    trackOperationActivityTransitions({
      operations,
      operationStatus: { recorded: "running" },
      activeTheaterId: THEATER.id,
      activeOperationId: null,
      activeOperationAcknowledged: true,
    });
    expect(trackOperationActivityTransitions({
      operations,
      operationStatus: { recorded: "idle" },
      activeTheaterId: THEATER.id,
      activeOperationId: null,
      activeOperationAcknowledged: true,
    })).toEqual(["recorded"]);

    setConsoleState({ operationStatus: { recorded: "idle" } });
    setSideBarStatusAxis(true);
    renderSideBar(operations);

    const idleChips = Array.from(
      required<HTMLElement>(".side-bar-status-section--idle").querySelectorAll<HTMLElement>("[data-side-bar-chip-id]"),
      (chip) => chip.dataset.sideBarChipId,
    );
    expect(idleChips).toEqual(["untouched"]);
    expect(Array.from(
      required<HTMLElement>(".side-bar-status-section--awaiting").querySelectorAll<HTMLElement>("[data-side-bar-chip-id]"),
      (chip) => chip.dataset.sideBarChipId,
    )).toEqual(["recorded"]);
    const recordedChip = required<HTMLElement>('[data-side-bar-chip-id="recorded"]');
    expect(recordedChip.querySelector(".side-bar-chip-unseen")).not.toBeNull();
    expect(recordedChip.className).not.toContain("side-bar-chip--status-landed");
    expect(required<HTMLElement>(".side-bar-status-section--awaiting .side-bar-status-header__unseen").textContent).toBe("1");
  });

  it("tracks idle unseen while STATUS is off, omits focused transitions, and clears on focus", () => {
    const operations = [makeOperation("unseen", null), makeOperation("focused", null)];
    setConsoleState({ operationStatus: { unseen: "running", focused: "running" } });
    renderSideBar(operations, [], vi.fn(), THEATER.id, [THEATER], "focused");

    act(() => setConsoleState({ operationStatus: { unseen: "idle", focused: "idle" } }));
    expect(container?.querySelector(".side-bar-chip-unseen")).not.toBeNull();

    act(() => setSideBarStatusAxis(true));

    const unseenChip = required<HTMLElement>('[data-side-bar-chip-id="unseen"]');
    expect(unseenChip.querySelector(".side-bar-chip-unseen")?.getAttribute("title")).toBe("Finished — not opened yet");
    expect(unseenChip.getAttribute("aria-label")).toContain(" (unseen since idle)");
    expect(required<HTMLElement>(".side-bar-status-section--awaiting .side-bar-status-header__unseen").textContent).toBe("1");
    expect(required<HTMLElement>('[data-side-bar-chip-id="focused"]').querySelector(".side-bar-chip-unseen")).toBeNull();

    act(() => setActiveOperation("unseen"));
    rerenderSideBar(operations, [], THEATER.id, [THEATER], "unseen");

    expect(required<HTMLElement>('[data-side-bar-chip-id="unseen"]').querySelector(".side-bar-chip-unseen")).toBeNull();
    expect(container?.querySelector(".side-bar-status-section--idle .side-bar-status-header__unseen")).toBeNull();
    expect(getIdleArrivalIds().has("unseen")).toBe(false);
  });

  it("removes idle unseen on exit and grants it again on a later idle episode", () => {
    const operations = [makeOperation("repeat", null)];
    setConsoleState({ operationStatus: { repeat: "running" } });
    setSideBarStatusAxis(true);
    renderSideBar(operations);

    act(() => setConsoleState({ operationStatus: { repeat: "idle" } }));
    expect(required<HTMLElement>('[data-side-bar-chip-id="repeat"] .side-bar-chip-unseen')).not.toBeNull();

    act(() => setConsoleState({ operationStatus: { repeat: "running" } }));
    expect(required<HTMLElement>('[data-side-bar-chip-id="repeat"]').querySelector(".side-bar-chip-unseen")).toBeNull();

    act(() => setConsoleState({ operationStatus: { repeat: "idle" } }));
    expect(required<HTMLElement>('[data-side-bar-chip-id="repeat"] .side-bar-chip-unseen')).not.toBeNull();
  });

  it("does not mark an Operation that is already idle on page load", () => {
    setConsoleState({ operationStatus: { initial: "idle" } });
    setSideBarStatusAxis(true);
    renderSideBar([makeOperation("initial", null)]);

    expect(required<HTMLElement>('[data-side-bar-chip-id="initial"]').querySelector(".side-bar-chip-unseen")).toBeNull();
    expect(container?.querySelector(".side-bar-status-header__unseen")).toBeNull();
  });

  it("baselines the first live status of a restored Operation before tracking later transitions", () => {
    const operation = {
      ...makeOperation("restored", null),
      payload: { resumeAvailable: true },
    };
    setSideBarStatusAxis(true);
    renderSideBar([operation]);

    expect(required<HTMLElement>('[data-side-bar-chip-id="restored"]').closest(".side-bar-status-section--dormant")).not.toBeNull();

    act(() => setConsoleState({ operationStatus: { restored: "idle" } }));

    const firstLiveChip = required<HTMLElement>('[data-side-bar-chip-id="restored"]');
    expect(getStatusTransitionTick("restored")).toBeUndefined();
    expect(firstLiveChip.querySelector(".side-bar-chip-unseen")).toBeNull();
    expect(firstLiveChip.className).not.toContain("side-bar-chip--status-landed");
    expect(container?.querySelector(".side-bar-status-section--idle .side-bar-status-header__unseen")).toBeNull();

    act(() => setConsoleState({ operationStatus: { restored: "running" } }));
    const runningTick = getStatusTransitionTick("restored");
    expect(runningTick).toBeDefined();

    act(() => setConsoleState({ operationStatus: { restored: "idle" } }));

    const transitionedChip = required<HTMLElement>('[data-side-bar-chip-id="restored"]');
    expect(getStatusTransitionTick("restored")).toBeGreaterThan(runningTick ?? 0);
    expect(transitionedChip.querySelector(".side-bar-chip-unseen")).not.toBeNull();
    expect(transitionedChip.className).toContain("side-bar-chip--status-landed");
    expect(required<HTMLElement>(".side-bar-status-section--awaiting .side-bar-status-header__unseen").textContent).toBe("1");
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
  theaters: readonly TheaterInfo[] = [THEATER],
  activeOperationId: string | null = null,
): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(sideBarElement(operations, groups, onSelectTheater, activeTheaterId, theaters, activeOperationId)));
}

function rerenderSideBar(
  operations: readonly OperationNode[],
  groups: readonly OperationGroup[] = [],
  activeTheaterId: string = THEATER.id,
  theaters: readonly TheaterInfo[] = [THEATER],
  activeOperationId: string | null = null,
): void {
  act(() => root?.render(sideBarElement(operations, groups, vi.fn(), activeTheaterId, theaters, activeOperationId)));
}

function sideBarElement(
  operations: readonly OperationNode[],
  groups: readonly OperationGroup[],
  onSelectTheater: (theaterId: string) => void,
  activeTheaterId: string,
  theaters: readonly TheaterInfo[],
  activeOperationId: string | null,
) {
  return createElement(MemoryRouter, null, createElement(OperationsSideBar, {
    theaters,
    activeTheaterId,
    operations,
    groups,
    minimized: [],
    activeOperationId,
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
  }));
}

function required<T extends Element>(selector: string): T {
  const element = container?.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

function makeOperation(id: string, groupId: string | null, accent?: string, theaterId: string = THEATER.id): OperationNode {
  return {
    id,
    theaterId,
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

const THEATER_B: TheaterInfo = {
  ...THEATER,
  id: "theater-b",
  label: "Bravo",
};

const GROUP_A: OperationGroup = {
  id: "group-a",
  name: "Alpha crew",
  color: "blue",
  order: 0,
  theaterId: THEATER.id,
  createdAt: 1,
};
