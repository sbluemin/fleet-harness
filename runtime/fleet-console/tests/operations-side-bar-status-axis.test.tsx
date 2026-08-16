// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSnapshot, loadForTheater, setOperationOrder } from "../core/client/src/canvas/canvas-store.js";
import { getIdleArrivalIds, markIdleArrival } from "../core/client/src/operation-idle-arrival.js";
import { requestSideBarOperationAction } from "../core/client/src/sidebar/interaction.js";
import { findAccessibilityViolations, formatAccessibilityViolations } from "./helpers/accessibility-rules.js";
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
  setConsoleState({ operationRuntime: {} });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  setSideBarStatusAxis(false);
  resetSideBarStatusRecencyForTests();
  resetSideBarStatusSectionCollapseForTests();
  setConsoleState({ operationRuntime: {} });
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
      operationRuntime: {
        running: { lifecycle: "live", activity: "running" },
        awaiting: { lifecycle: "live", activity: "awaiting" },
        dormant: { lifecycle: "dormant" },
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
      "BACKGROUND",
      "IDLE",
      "Minimized",
      "ENDED",
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
    // 상태 마크는 축과 무관하게 이름 왼쪽에 선다 — STATUS 축에서도 행이 자기 상태를 말한다.
    // 그룹 헤더는 그 마크를 반복하지 않는다. 버킷은 라벨·카운트·왼쪽 스트라이프로 읽는다.
    expect(required<HTMLElement>('[data-side-bar-chip-id="awaiting"] .side-bar-chip-status').className)
      .toContain("tenant-beacon is-awaiting");
    expect(container?.querySelector(".side-bar-status-header__dot")).toBeNull();
    expect(container?.querySelector('[data-side-bar-chip-id="idle"] .side-bar-chip-group-pill')).toBeNull();
    expect(required<HTMLElement>('[data-side-bar-chip-id="awaiting"]').dataset.reorderEnabled).toBe("false");
  });

  it("pins four live sections plus both recovery shelves, defaults empty sections collapsed, and toggles empty and occupied sections independently", () => {
    setConsoleState({ operationRuntime: { only: { lifecycle: "live", activity: "running" } } });
    setSideBarStatusAxis(true);
    renderSideBar([makeOperation("only", null)]);

    const sections = Array.from(container?.querySelectorAll<HTMLElement>(".side-bar-status-section") ?? []);
    expect(sections).toHaveLength(6);
    expect(sections.map((section) => section.querySelector(".side-bar-status-header__count")?.textContent)).toEqual(["0", "1", "0", "0", "0", "0"]);
    const recoveryShelves = Array.from(container?.querySelectorAll<HTMLElement>(".side-bar-status-recovery-shelf") ?? []);
    expect(recoveryShelves).toHaveLength(2);
    expect(recoveryShelves.map((shelf) => shelf.className)).toEqual([
      "triage-side-bar-minimized-shelf side-bar-status-recovery-shelf",
      "triage-side-bar-dormant-shelf side-bar-status-recovery-shelf",
    ]);

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
    setConsoleState({ operationRuntime: { arrived: { lifecycle: "live", activity: "idle" } } });
    markIdleArrival(operation.id);
    setSideBarStatusAxis(true);
    toggleSideBarStatusSectionCollapsed(THEATER.id, "awaiting", false);
    renderSideBar([operation]);
    expect(getSideBarStatusSectionCollapsed(THEATER.id, "awaiting", false)).toBe(true);

    act(() => requestSideBarOperationAction(operation.id, "rename"));

    expect(getSideBarStatusSectionCollapsed(THEATER.id, "awaiting", false)).toBe(false);
    expect(getSideBarStatusSectionCollapsed(THEATER.id, "idle", true)).toBe(true);
  });

  // 도착으로 AWAITING에 오른 행은 그 승격을 마크로도 말해야 한다 — 섹션은 대기라고 하는데
  // 마크만 유휴로 남으면 같은 행이 한 화면에서 두 상태를 말한다.
  it("marks an idle arrival promoted into AWAITING as awaiting, not idle", () => {
    const operation = makeOperation("arrived", null);
    setConsoleState({ operationRuntime: { arrived: { lifecycle: "live", activity: "idle" } } });
    markIdleArrival(operation.id);
    setSideBarStatusAxis(true);
    renderSideBar([operation]);

    const chip = required<HTMLElement>('.side-bar-status-section--awaiting [data-side-bar-chip-id="arrived"]');
    const mark = required<HTMLElement>('.side-bar-status-section--awaiting [data-side-bar-chip-id="arrived"] .side-bar-chip-status');
    expect(chip).not.toBeNull();
    expect(mark.className).toContain("is-awaiting");
    expect(mark.getAttribute("aria-label")).toBe("Awaiting input");
  });

  it("continues to reveal an ordinary idle Operation from the IDLE section", () => {
    const operation = makeOperation("idle", null);
    setConsoleState({ operationRuntime: { idle: { lifecycle: "live", activity: "idle" } } });
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

    act(() => setConsoleState({ operationRuntime: { arriving: { lifecycle: "live", activity: "awaiting" } } }));
    rerenderSideBar([makeOperation("arriving", null)]);

    expect(required<HTMLButtonElement>('.side-bar-status-section--awaiting [aria-label="Collapse section AWAITING"]').getAttribute("aria-expanded")).toBe("true");
    expect(container?.querySelector('[data-side-bar-chip-id="arriving"]')).not.toBeNull();

    act(() => setConsoleState({ operationRuntime: {} }));
    rerenderSideBar([]);

    expect(required<HTMLButtonElement>('.side-bar-status-section--awaiting [aria-label="Collapse section AWAITING"]').getAttribute("aria-expanded")).toBe("true");
    expect(required<HTMLElement>(".side-bar-status-section--awaiting .side-bar-status-empty-hint").textContent).toBe("No operations");
  });

  it("isolates the same status collapse toggle by Theater key", () => {
    const operations = [
      makeOperation("alpha-running", null),
      makeOperation("bravo-running", null, undefined, THEATER_B.id),
    ];
    setConsoleState({ operationRuntime: { "alpha-running": { lifecycle: "live", activity: "running" }, "bravo-running": { lifecycle: "live", activity: "running" } } });
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

  it("suppresses group pills but keeps the status mark and shows idle unseen in inactive Theater preview chips", () => {
    setConsoleState({ operationRuntime: { preview: { lifecycle: "live", activity: "running" } } });
    setSideBarStatusAxis(true);
    renderSideBar([makeOperation("preview", "group-a")], [GROUP_A], vi.fn(), "theater-other");

    const preview = required<HTMLElement>('[data-side-bar-chip-id="preview"]');
    expect(preview.querySelector(".side-bar-chip-group-pill")).toBeNull();
    expect(preview.querySelector(".side-bar-chip-group-mark")).toBeNull();
    // preview 칩은 조작 어포던스만 접는다 — 상태는 미리보기에서도 읽혀야 한다.
    expect(preview.querySelector(".side-bar-chip-status")?.className).toContain("tenant-beacon is-turn-running");

    act(() => setConsoleState({ operationRuntime: { preview: { lifecycle: "live", activity: "idle" } } }));

    expect(required<HTMLElement>('[data-side-bar-chip-id="preview"] .side-bar-chip-unseen')).not.toBeNull();
  });

  it("keeps keyboard reordering disabled in STATUS and unchanged in GROUP", () => {
    const operations = [
      makeOperation("first", null),
      makeOperation("second", null),
    ];
    setOperationOrder(["first", "second"]);
    setConsoleState({ operationRuntime: { first: { lifecycle: "live", activity: "running" }, second: { lifecycle: "live", activity: "running" } } });
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
    setConsoleState({ operationRuntime: { moving: { lifecycle: "live", activity: "running" } } });
    setSideBarStatusAxis(true);
    renderSideBar(operations);

    expect(required<HTMLElement>('[data-side-bar-chip-id="moving"]').className).not.toContain("side-bar-chip--status-landed");

    act(() => setConsoleState({ operationRuntime: { moving: { lifecycle: "live", activity: "awaiting" } } }));

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
    setConsoleState({ operationRuntime: Object.fromEntries(operations.map((operation) => [operation.id, "running"])) });
    setSideBarStatusAxis(true);
    renderSideBar(operations);

    act(() => setConsoleState({ operationRuntime: {
      "untouched-first": { lifecycle: "live", activity: "running" },
      latest: { lifecycle: "live", activity: "running" },
      earlier: { lifecycle: "live", activity: "idle" },
      "untouched-second": { lifecycle: "live", activity: "running" },
    } }));
    act(() => setConsoleState({ operationRuntime: {
      "untouched-first": { lifecycle: "live", activity: "running" },
      latest: { lifecycle: "live", activity: "running" },
      earlier: { lifecycle: "live", activity: "running" },
      "untouched-second": { lifecycle: "live", activity: "running" },
    } }));
    act(() => setConsoleState({ operationRuntime: {
      "untouched-first": { lifecycle: "live", activity: "running" },
      latest: { lifecycle: "live", activity: "idle" },
      earlier: { lifecycle: "live", activity: "running" },
      "untouched-second": { lifecycle: "live", activity: "running" },
    } }));
    act(() => setConsoleState({ operationRuntime: {
      "untouched-first": { lifecycle: "live", activity: "running" },
      latest: { lifecycle: "live", activity: "running" },
      earlier: { lifecycle: "live", activity: "running" },
      "untouched-second": { lifecycle: "live", activity: "running" },
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
      operationRuntime: { recorded: { lifecycle: "live", activity: "running" } },
      activeTheaterId: THEATER.id,
      activeOperationId: null,
      activeOperationAcknowledged: true,
    });
    expect(trackOperationActivityTransitions({
      operations,
      operationRuntime: { recorded: { lifecycle: "live", activity: "idle" } },
      activeTheaterId: THEATER.id,
      activeOperationId: null,
      activeOperationAcknowledged: true,
    })).toEqual(["recorded"]);

    setConsoleState({ operationRuntime: { recorded: { lifecycle: "live", activity: "idle" } } });
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
    setConsoleState({ operationRuntime: { unseen: { lifecycle: "live", activity: "running" }, focused: { lifecycle: "live", activity: "running" } } });
    renderSideBar(operations, [], vi.fn(), THEATER.id, [THEATER], "focused");

    act(() => setConsoleState({ operationRuntime: { unseen: { lifecycle: "live", activity: "idle" }, focused: { lifecycle: "live", activity: "idle" } } }));
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
    setConsoleState({ operationRuntime: { repeat: { lifecycle: "live", activity: "running" } } });
    setSideBarStatusAxis(true);
    renderSideBar(operations);

    act(() => setConsoleState({ operationRuntime: { repeat: { lifecycle: "live", activity: "idle" } } }));
    expect(required<HTMLElement>('[data-side-bar-chip-id="repeat"] .side-bar-chip-unseen')).not.toBeNull();

    act(() => setConsoleState({ operationRuntime: { repeat: { lifecycle: "live", activity: "running" } } }));
    expect(required<HTMLElement>('[data-side-bar-chip-id="repeat"]').querySelector(".side-bar-chip-unseen")).toBeNull();

    act(() => setConsoleState({ operationRuntime: { repeat: { lifecycle: "live", activity: "idle" } } }));
    expect(required<HTMLElement>('[data-side-bar-chip-id="repeat"] .side-bar-chip-unseen')).not.toBeNull();
  });

  it("does not mark an Operation that is already idle on page load", () => {
    setConsoleState({ operationRuntime: { initial: { lifecycle: "live", activity: "idle" } } });
    setSideBarStatusAxis(true);
    renderSideBar([makeOperation("initial", null)]);

    expect(required<HTMLElement>('[data-side-bar-chip-id="initial"]').querySelector(".side-bar-chip-unseen")).toBeNull();
    expect(container?.querySelector(".side-bar-status-header__unseen")).toBeNull();
  });

  it("gives dormant recovery precedence over a minimized snapshot and keeps exactly-once membership", () => {
    const operations = [
      { ...makeOperation("dormant-minimized", null), payload: { resumeAvailable: true } },
      makeOperation("live-minimized", null),
      makeOperation("ordinary-live", null),
    ];
    setConsoleState({ operationRuntime: { "dormant-minimized": { lifecycle: "dormant" }, "live-minimized": { lifecycle: "live", activity: "running" }, "ordinary-live": { lifecycle: "live", activity: "idle" } } });
    setSideBarStatusAxis(true);
    renderSideBar(operations, [], vi.fn(), THEATER.id, [THEATER], null, ["dormant-minimized", "live-minimized"]);

    expect(container?.querySelectorAll('[data-side-bar-chip-id="dormant-minimized"]')).toHaveLength(1);
    expect(container?.querySelectorAll('[data-side-bar-chip-id="live-minimized"]')).toHaveLength(1);
    expect(required<HTMLElement>('[data-side-bar-chip-id="dormant-minimized"]').closest(".triage-side-bar-dormant-shelf")).not.toBeNull();
    expect(required<HTMLElement>('[data-side-bar-chip-id="live-minimized"]').closest(".triage-side-bar-minimized-shelf")).not.toBeNull();
    expect(required<HTMLElement>('[data-side-bar-chip-id="ordinary-live"]').closest(".side-bar-status-section--idle")).not.toBeNull();
  });

  it("preserves unseen arrival signals on the minimized recovery shelf but suppresses them on dormant recovery", () => {
    const operations = [
      makeOperation("minimized-unseen", null),
      { ...makeOperation("dormant-unseen", null), payload: { resumeAvailable: true } },
    ];
    setConsoleState({ operationRuntime: { "minimized-unseen": { lifecycle: "live", activity: "running" }, "dormant-unseen": { lifecycle: "live", activity: "running" } } });
    setSideBarStatusAxis(true);
    renderSideBar(operations, [], vi.fn(), THEATER.id, [THEATER], null, ["minimized-unseen"]);
    act(() => markIdleArrival("dormant-unseen"));
    act(() => setConsoleState({ operationRuntime: { "minimized-unseen": { lifecycle: "live", activity: "idle" }, "dormant-unseen": { lifecycle: "dormant" } } }));

    const minimizedShelf = required<HTMLElement>(".triage-side-bar-minimized-shelf");
    const dormantShelf = required<HTMLElement>(".triage-side-bar-dormant-shelf");
    const minimizedChip = required<HTMLElement>('[data-side-bar-chip-id="minimized-unseen"]');
    const dormantChip = required<HTMLElement>('[data-side-bar-chip-id="dormant-unseen"]');
    expect(minimizedChip.querySelector(".side-bar-chip-unseen")).not.toBeNull();
    expect(minimizedChip.className).toContain("side-bar-chip--status-landed");
    expect(minimizedShelf.querySelector(".side-bar-status-header__unseen")?.textContent).toBe("1");
    expect(dormantChip.querySelector(".side-bar-chip-unseen")).toBeNull();
    expect(dormantChip.className).not.toContain("side-bar-chip--status-landed");
    expect(dormantShelf.querySelector(".side-bar-status-header__unseen")).toBeNull();
  });

  it.each([
    { label: "active", activeTheaterId: THEATER.id },
    { label: "inactive", activeTheaterId: THEATER_B.id },
  ])("routes minimized activation through focus and dormant activation through resume in an $label Theater", ({ activeTheaterId }) => {
    const onFocus = vi.fn();
    const onResume = vi.fn();
    const operations = [
      { ...makeOperation("dormant", null), payload: { resumeAvailable: true } },
      makeOperation("minimized", null),
    ];
    window.localStorage.setItem("fleet-console.canvas.theater-a", JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 },
      operations: {},
      operationOrder: ["dormant", "minimized"],
      operationAccent: {},
      minimized: ["minimized"],
      collapsedGroups: [],
    }));
    setConsoleState({ operationRuntime: { dormant: { lifecycle: "dormant" }, minimized: { lifecycle: "live", activity: "running" } } });
    setSideBarStatusAxis(true);
    renderSideBar(
      operations,
      [],
      vi.fn(),
      activeTheaterId,
      activeTheaterId === THEATER.id ? [THEATER] : [THEATER_B, THEATER],
      null,
      activeTheaterId === THEATER.id ? ["minimized"] : [],
      onFocus,
      onResume,
    );

    act(() => required<HTMLElement>('[data-side-bar-chip-id="minimized"]').click());
    act(() => required<HTMLElement>('[data-side-bar-chip-id="dormant"]').click());

    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith("minimized");
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledWith("dormant");
  });

  it("baselines the first live status of a restored Operation before tracking later transitions", () => {
    const operation = {
      ...makeOperation("restored", null),
      payload: { resumeAvailable: true },
    };
    setSideBarStatusAxis(true);
    renderSideBar([operation]);

    expect(required<HTMLElement>('[data-side-bar-chip-id="restored"]').closest(".side-bar-status-section--ended")).not.toBeNull();

    act(() => setConsoleState({ operationRuntime: { restored: { lifecycle: "live", activity: "idle" } } }));

    const firstLiveChip = required<HTMLElement>('[data-side-bar-chip-id="restored"]');
    expect(getStatusTransitionTick("restored")).toBeUndefined();
    expect(firstLiveChip.querySelector(".side-bar-chip-unseen")).toBeNull();
    expect(firstLiveChip.className).not.toContain("side-bar-chip--status-landed");
    expect(container?.querySelector(".side-bar-status-section--idle .side-bar-status-header__unseen")).toBeNull();

    act(() => setConsoleState({ operationRuntime: { restored: { lifecycle: "live", activity: "running" } } }));
    const runningTick = getStatusTransitionTick("restored");
    expect(runningTick).toBeDefined();

    act(() => setConsoleState({ operationRuntime: { restored: { lifecycle: "live", activity: "idle" } } }));

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

    act(() => required<HTMLElement>(".side-bar-theater-activate").click());

    // 활성 Theater 행 클릭은 접기 토글만 수행한다 — 재선택하지 않는다.
    // (비활성 Theater 클릭은 선택만 하고 접기 상태를 건드리지 않는 것이 행 제스처 계약이다.)
    expect(onSelectTheater).not.toHaveBeenCalled();
    expect(required<HTMLElement>(".side-bar-theater-activate").getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem("fleet-console.operations.theater-collapsed")).toBe('["theater-a"]');
  });

  it("selects an inactive Theater on row click without mutating its persisted collapse preference", () => {
    setTheaterCollapsed("theater-a", true);
    const onSelectTheater = vi.fn();
    renderSideBar([makeOperation("only", null)], [], onSelectTheater, "theater-other");

    act(() => required<HTMLElement>(".side-bar-theater-activate").click());

    expect(onSelectTheater).toHaveBeenCalledWith("theater-a");
    // 비활성 클릭=선택만 — 접힘 영속 키는 그대로 남는다.
    expect(window.localStorage.getItem("fleet-console.operations.theater-collapsed")).toBe('["theater-a"]');
  });

  it("keeps the rendered sidebar free of the accessibility defects that shipped here", () => {
    renderSideBar([makeOperation("only", null)], []);

    // 행 전체가 role="button"이면서 정렬·새 Operation·액션 버튼을 품고 있던 구조가 여기서 걸린다.
    // Operation 칩은 같은 결함의 다섯 번째 인스턴스이지만 rename 입력·드래그·재배치 키가 한
    // 요소에 얽혀 있어 아직 풀지 못했다. 지금 상태를 고정해 악화만 막는다 — 이 목록은
    // 줄어들기만 해야 하고, 새 표면을 여기 더하는 것은 계약 위반이다.
    const KNOWN_UNFIXED = ["side-bar-chip"];
    const violations = findAccessibilityViolations(container!)
      .filter((violation) => !KNOWN_UNFIXED.some((known) => violation.detail.includes(known)));
    expect(formatAccessibilityViolations(violations)).toBe("");
  });

  it("holds the known-unfixed list at exactly the Operation chip", () => {
    renderSideBar([makeOperation("only", null)], []);

    const nested = findAccessibilityViolations(container!).filter((violation) => violation.rule === "nested-interactive");
    // 칩 하나가 minimize·close 두 버튼을 품는다. 이 수가 늘면 새 중첩이 들어온 것이고,
    // 0이 되면 칩이 풀린 것이니 위 목록에서 빼야 한다.
    expect(nested.every((violation) => violation.detail.includes("side-bar-chip"))).toBe(true);
    expect(nested).toHaveLength(2);
  });
});

function renderSideBar(
  operations: readonly OperationNode[],
  groups: readonly OperationGroup[] = [],
  onSelectTheater = vi.fn(),
  activeTheaterId: string = THEATER.id,
  theaters: readonly TheaterInfo[] = [THEATER],
  activeOperationId: string | null = null,
  minimized: readonly string[] = [],
  onFocus = vi.fn(),
  onResume = vi.fn(),
): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(sideBarElement(operations, groups, onSelectTheater, activeTheaterId, theaters, activeOperationId, minimized, onFocus, onResume)));
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
  minimized: readonly string[] = [],
  onFocus = vi.fn(),
  onResume = vi.fn(),
) {
  return createElement(MemoryRouter, null, createElement(OperationsSideBar, {
    theaters,
    activeTheaterId,
    operations,
    groups,
    minimized,
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
    onFocus,
    onResume,
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
