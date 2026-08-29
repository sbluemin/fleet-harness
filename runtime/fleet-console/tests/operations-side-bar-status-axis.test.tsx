// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSnapshot, loadForTheater, setOperationOrder } from "../core/client/src/canvas/canvas-store.js";
import { getIdleArrivalIds, markIdleArrival } from "../core/client/src/operation-marks.js";
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
  it("stands one axis strip regardless of Theater count, and none when there is no Theater to organise", () => {
    const second: TheaterInfo = { ...THEATER, id: "theater-b", label: "Second" };
    setConsoleState({ operationRuntime: {} });

    renderSideBar([], [], vi.fn(), THEATER.id, [THEATER, second]);
    expect(container?.querySelectorAll(".side-bar-theater-header").length).toBe(2);
    // 두 Theater가 서도 축 스위치는 하나다 — 여기가 사용자가 "공통 버튼인데 Theater마다 있다"고
    // 지적한 지점이고, 카디널리티가 곧 계약이다.
    expect(container?.querySelectorAll(".operations-side-bar-axis").length).toBe(1);

    rerenderSideBar([], [], THEATER.id, []);
    // 정리할 목록이 없으면 정리 축도 서지 않는다.
    expect(container?.querySelectorAll(".operations-side-bar-axis").length).toBe(0);
  });

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

    // 축 스위치는 Theater 수와 무관하게 하나만 선다. Theater 행에 N개를 두면 배치가 국소라고
    // 말하면서 전역 불리언 하나를 뒤집어, 한 번의 클릭이 모든 행을 함께 눌린 상태로 만든다.
    expect(container?.querySelectorAll(".side-bar-status-axis-toggle").length).toBe(0);
    expect(container?.querySelectorAll(".operations-side-bar-axis").length).toBe(1);
    const groupSeg = required<HTMLButtonElement>('.operations-side-bar-axis-seg[data-axis="group"]');
    const statusSeg = required<HTMLButtonElement>('.operations-side-bar-axis-seg[data-axis="status"]');
    expect(groupSeg.textContent).toBe("Groups");
    expect(statusSeg.textContent).toBe("Status");
    expect(groupSeg.getAttribute("aria-pressed")).toBe("true");
    expect(statusSeg.getAttribute("aria-pressed")).toBe("false");
    expect(statusSeg.title).toBe("Sort all Theaters by status (Alt+S)");
    expect(required<HTMLElement>(".operations-side-bar").dataset.sidebarAxis).toBe("group");
    // 대기 틱은 축 스위치가 아니라 그 Theater의 정체성 표식이 진다.
    expect(required<HTMLElement>(".side-bar-theater-anchor .side-bar-status-axis-live-tick")).not.toBeNull();
    expect(container?.querySelector(".side-bar-group-header")).not.toBeNull();

    act(() => statusSeg.click());

    expect(groupSeg.getAttribute("aria-pressed")).toBe("false");
    expect(statusSeg.getAttribute("aria-pressed")).toBe("true");
    expect(required<HTMLElement>(".operations-side-bar").dataset.sidebarAxis).toBe("status");
    expect(container?.querySelector(".side-bar-status-axis-live-tick")).toBeNull();
    expect(Array.from(container?.querySelectorAll(".side-bar-status-header__label") ?? []).map((node) => node.textContent)).toEqual([
      "Awaiting",
      "Running",
      "Idle",
      "Minimized · select to restore",
      "Ended · select to start again",
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


  it("pins three live sections plus both recovery shelves, defaults empty sections collapsed, and toggles empty and occupied sections independently", () => {
    setConsoleState({ operationRuntime: { only: { lifecycle: "live", activity: "running" } } });
    setSideBarStatusAxis(true);
    renderSideBar([makeOperation("only", null)]);

    const sections = Array.from(container?.querySelectorAll<HTMLElement>(".side-bar-status-section") ?? []);
    expect(sections).toHaveLength(5);
    expect(sections.map((section) => section.querySelector(".side-bar-status-header__count")?.textContent)).toEqual(["0", "1", "0", "0", "0"]);
    const recoveryShelves = Array.from(container?.querySelectorAll<HTMLElement>(".side-bar-status-recovery-shelf") ?? []);
    expect(recoveryShelves).toHaveLength(2);
    expect(recoveryShelves.map((shelf) => shelf.className)).toEqual([
      "triage-side-bar-minimized-shelf side-bar-status-recovery-shelf",
      "triage-side-bar-dormant-shelf side-bar-status-recovery-shelf",
    ]);

    const awaiting = required<HTMLElement>(".side-bar-status-section--awaiting");
    expect(awaiting.className).toContain("side-bar-status-section--empty");
    const awaitingToggle = required<HTMLButtonElement>('.side-bar-status-section--awaiting [aria-label="Expand section Awaiting"]');
    expect(awaitingToggle.getAttribute("aria-expanded")).toBe("false");
    expect(awaiting.querySelector(".side-bar-status-empty-hint")).toBeNull();

    act(() => awaitingToggle.click());

    expect(required<HTMLButtonElement>('.side-bar-status-section--awaiting [aria-label="Collapse section Awaiting"]').title).toBe("Collapse");
    expect(required<HTMLElement>(".side-bar-status-section--awaiting .side-bar-status-empty-hint").textContent).toBe("No operations");

    const runningToggle = required<HTMLButtonElement>('.side-bar-status-section--running [aria-label="Collapse section Running"]');
    expect(runningToggle.getAttribute("aria-expanded")).toBe("true");
    act(() => runningToggle.click());
    expect(required<HTMLButtonElement>('.side-bar-status-section--running [aria-label="Expand section Running"]').title).toBe("Expand");
    expect(container?.querySelector('[data-side-bar-chip-id="only"]')).toBeNull();
    act(() => required<HTMLButtonElement>('.side-bar-status-section--running [aria-label="Expand section Running"]').click());
    expect(container?.querySelector('[data-side-bar-chip-id="only"]')).not.toBeNull();
  });

  it("keeps a background Operation in RUNNING with its hollow beacon", () => {
    setConsoleState({
      operationRuntime: {
        turn: { lifecycle: "live", activity: "running" },
        leftover: { lifecycle: "live", activity: "background" },
      },
    });
    setSideBarStatusAxis(true);
    renderSideBar([makeOperation("turn", null), makeOperation("leftover", null)]);

    expect(container?.querySelector(".side-bar-status-section--background")).toBeNull();
    expect(required<HTMLElement>('[data-side-bar-chip-id="turn"]').closest(".side-bar-status-section--running")).not.toBeNull();
    expect(required<HTMLElement>('[data-side-bar-chip-id="leftover"]').closest(".side-bar-status-section--running")).not.toBeNull();
    expect(required<HTMLElement>('[data-side-bar-chip-id="leftover"] .side-bar-chip-status').className)
      .toContain("tenant-beacon is-background");
    expect(required<HTMLElement>('[data-side-bar-chip-id="turn"] .side-bar-chip-status').className)
      .toContain("tenant-beacon is-turn-running");
    expect(required<HTMLElement>(".side-bar-status-section--running .side-bar-status-header__count").textContent).toBe("2");
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
  it("stands an idle arrival in AWAITING but marks it unseen, not awaiting", () => {
    const operation = makeOperation("arrived", null);
    setConsoleState({ operationRuntime: { arrived: { lifecycle: "live", activity: "idle" } } });
    markIdleArrival(operation.id);
    setSideBarStatusAxis(true);
    renderSideBar([operation]);

    // 두 축이 갈라지는 유일한 자리 — 칸은 AWAITING(놓치지 않게 위로), 마크는 unseen(안 본 채 끝난 것).
    const chip = required<HTMLElement>('.side-bar-status-section--awaiting [data-side-bar-chip-id="arrived"]');
    const mark = required<HTMLElement>('.side-bar-status-section--awaiting [data-side-bar-chip-id="arrived"] .side-bar-chip-status');
    expect(chip).not.toBeNull();
    expect(mark.className).toContain("is-unseen");
    expect(mark.className).not.toContain("is-awaiting");
    expect(mark.getAttribute("aria-label")).toBe("Finished, unacknowledged");
  });

  it("marks a genuine awaiting Operation as awaiting even while an arrival shares its section", () => {
    const genuine = { ...makeOperation("genuine", null), title: "genuine" };
    const arrived = { ...makeOperation("arrived", null), title: "arrived" };
    setConsoleState({ operationRuntime: {
      genuine: { lifecycle: "live", activity: "awaiting" },
      arrived: { lifecycle: "live", activity: "idle" },
    } });
    markIdleArrival("arrived");
    setSideBarStatusAxis(true);
    renderSideBar([genuine, arrived]);

    const section = required<HTMLElement>(".side-bar-status-section--awaiting");
    expect(section.querySelectorAll("[data-side-bar-chip-id]").length).toBe(2);
    expect(required<HTMLElement>('[data-side-bar-chip-id="genuine"] .side-bar-chip-status').className).toContain("tenant-beacon is-awaiting");
    expect(required<HTMLElement>('[data-side-bar-chip-id="arrived"] .side-bar-chip-status').className).toContain("tenant-beacon is-unseen");
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

    act(() => required<HTMLButtonElement>('.side-bar-status-section--awaiting [aria-label="Expand section Awaiting"]').click());
    expect(required<HTMLElement>(".side-bar-status-section--awaiting .side-bar-status-empty-hint").textContent).toBe("No operations");

    act(() => setConsoleState({ operationRuntime: { arriving: { lifecycle: "live", activity: "awaiting" } } }));
    rerenderSideBar([makeOperation("arriving", null)]);

    expect(required<HTMLButtonElement>('.side-bar-status-section--awaiting [aria-label="Collapse section Awaiting"]').getAttribute("aria-expanded")).toBe("true");
    expect(container?.querySelector('[data-side-bar-chip-id="arriving"]')).not.toBeNull();

    act(() => setConsoleState({ operationRuntime: {} }));
    rerenderSideBar([]);

    expect(required<HTMLButtonElement>('.side-bar-status-section--awaiting [aria-label="Collapse section Awaiting"]').getAttribute("aria-expanded")).toBe("true");
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
    act(() => alpha.querySelector<HTMLButtonElement>('.side-bar-status-section--running [aria-label="Collapse section Running"]')?.click());

    expect(alpha.querySelector('[data-side-bar-chip-id="alpha-running"]')).toBeNull();
    expect(bravo.querySelector('[data-side-bar-chip-id="bravo-running"]')).not.toBeNull();
    expect(bravo.querySelector('.side-bar-status-section--running [aria-label="Collapse section Running"]')).not.toBeNull();

    act(() => bravo.querySelector<HTMLButtonElement>('.side-bar-status-section--running [aria-label="Collapse section Running"]')?.click());

    expect(alpha.querySelector('.side-bar-status-section--running [aria-label="Expand section Running"]')).not.toBeNull();
    expect(bravo.querySelector('.side-bar-status-section--running [aria-label="Expand section Running"]')).not.toBeNull();
  });

  it("suppresses group pills but keeps the status mark and marks an idle arrival unseen in inactive Theater preview chips", () => {
    setConsoleState({ operationRuntime: { preview: { lifecycle: "live", activity: "running" } } });
    setSideBarStatusAxis(true);
    renderSideBar([makeOperation("preview", "group-a")], [GROUP_A], vi.fn(), "theater-other");

    const preview = required<HTMLElement>('[data-side-bar-chip-id="preview"]');
    expect(preview.querySelector(".side-bar-chip-group-pill")).toBeNull();
    expect(preview.querySelector(".side-bar-chip-group-mark")).toBeNull();
    // preview 칩은 조작 어포던스만 접는다 — 상태는 미리보기에서도 읽혀야 한다.
    expect(preview.querySelector(".side-bar-chip-status")?.className).toContain("tenant-beacon is-turn-running");

    act(() => setConsoleState({ operationRuntime: { preview: { lifecycle: "live", activity: "idle" } } }));

    // 미확인 도착은 별도 표식이 아니라 마크 축의 "unseen"이다 — peek 칩도 마크 하나로만 말한다.
    const arrived = required<HTMLElement>('[data-side-bar-chip-id="preview"]');
    expect(arrived.querySelector(".side-bar-chip-status")?.className).toContain("tenant-beacon is-unseen");
    expect(arrived.querySelector(".side-bar-chip-unseen")).toBeNull();

    // STATUS를 끄면 peek는 groupOperations만 거친다 — 섹션 재작성이 없으므로, 이 단언만이
    // buildTheaterEntries가 마크 축을 싣는 것을 고정한다(칸이 없으니 마크 외엔 관측할 것이 없다).
    act(() => setSideBarStatusAxis(false));
    const grouped = required<HTMLElement>('[data-side-bar-chip-id="preview"]');
    expect(grouped.closest(".side-bar-status-section--awaiting")).toBeNull();
    expect(grouped.querySelector(".side-bar-chip-status")?.className).toContain("tenant-beacon is-unseen");
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

    act(() => required<HTMLButtonElement>('.operations-side-bar-axis-seg[data-axis="group"]').click());
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
    expect(required<HTMLElement>(".side-bar-status-header__label").textContent).toBe("Awaiting");
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
    expect(recordedChip.querySelector(".side-bar-chip-status")?.className).toContain("tenant-beacon is-unseen");
    expect(recordedChip.className).not.toContain("side-bar-chip--status-landed");
    expect(recordedChip.querySelector(".side-bar-chip-unseen")).toBeNull();
    expect(container?.querySelector(".side-bar-status-header__unseen")).toBeNull();
    expect(required<HTMLElement>(".side-bar-status-section--awaiting .side-bar-status-header__count").textContent).toBe("1");
  });

  it("marks an idle arrival unseen while STATUS is off, omits focused transitions, and clears on focus", () => {
    const operations = [makeOperation("unseen", null), makeOperation("focused", null)];
    setConsoleState({ operationRuntime: { unseen: { lifecycle: "live", activity: "running" }, focused: { lifecycle: "live", activity: "running" } } });
    renderSideBar(operations, [], vi.fn(), THEATER.id, [THEATER], "focused");

    act(() => setConsoleState({ operationRuntime: { unseen: { lifecycle: "live", activity: "idle" }, focused: { lifecycle: "live", activity: "idle" } } }));
    // GROUP 축(STATUS off)도 표시 활동을 읽는다 — 예전에는 여기서만 raw idle을 그려, 우측 미확인 점이
    // 유일한 대기 신호였고 같은 사실이 초록 마크와 초록 점으로 두 번 그려졌다.
    expect(required<HTMLElement>('[data-side-bar-chip-id="unseen"] .side-bar-chip-status').className).toContain("tenant-beacon is-unseen");
    expect(required<HTMLElement>('[data-side-bar-chip-id="focused"] .side-bar-chip-status').className).toContain("tenant-beacon is-idle");
    expect(container?.querySelector(".side-bar-chip-unseen")).toBeNull();

    act(() => setSideBarStatusAxis(true));

    const unseenChip = required<HTMLElement>('[data-side-bar-chip-id="unseen"]');
    expect(unseenChip.querySelector(".side-bar-chip-status")?.getAttribute("aria-label")).toBe("Finished, unacknowledged");
    // 접근성 이름에는 더 이상 미확인 접미가 붙지 않는다 — 상태는 마크의 이름이 진다.
    expect(unseenChip.getAttribute("aria-label")).toBe("Focus operation unseen");
    expect(unseenChip.closest(".side-bar-status-section--awaiting")).not.toBeNull();
    expect(container?.querySelector(".side-bar-status-header__unseen")).toBeNull();

    act(() => setActiveOperation("unseen"));
    rerenderSideBar(operations, [], THEATER.id, [THEATER], "unseen");

    expect(required<HTMLElement>('[data-side-bar-chip-id="unseen"] .side-bar-chip-status').className).toContain("tenant-beacon is-idle");
    expect(getIdleArrivalIds().has("unseen")).toBe(false);
  });

  it("drops the unseen mark on exit and grants it again on a later idle episode", () => {
    const operations = [makeOperation("repeat", null)];
    setConsoleState({ operationRuntime: { repeat: { lifecycle: "live", activity: "running" } } });
    setSideBarStatusAxis(true);
    renderSideBar(operations);
    const mark = () => required<HTMLElement>('[data-side-bar-chip-id="repeat"] .side-bar-chip-status').className;

    act(() => setConsoleState({ operationRuntime: { repeat: { lifecycle: "live", activity: "idle" } } }));
    expect(mark()).toContain("tenant-beacon is-unseen");

    act(() => setConsoleState({ operationRuntime: { repeat: { lifecycle: "live", activity: "running" } } }));
    expect(mark()).toContain("tenant-beacon is-turn-running");

    act(() => setConsoleState({ operationRuntime: { repeat: { lifecycle: "live", activity: "idle" } } }));
    expect(mark()).toContain("tenant-beacon is-unseen");
  });

  it("does not mark an Operation that is already idle on page load", () => {
    setConsoleState({ operationRuntime: { initial: { lifecycle: "live", activity: "idle" } } });
    setSideBarStatusAxis(true);
    renderSideBar([makeOperation("initial", null)]);

    const initial = required<HTMLElement>('[data-side-bar-chip-id="initial"]');
    expect(initial.querySelector(".side-bar-chip-status")?.className).toContain("tenant-beacon is-idle");
    expect(initial.closest(".side-bar-status-section--idle")).not.toBeNull();
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
    // 최소화 선반도 표시 활동을 읽는다 — 예전에는 raw idle 마크 옆에 미확인 점이 따로 붙었다.
    expect(minimizedChip.querySelector(".side-bar-chip-status")?.className).toContain("tenant-beacon is-unseen");
    expect(minimizedChip.className).toContain("side-bar-chip--status-landed");
    expect(dormantChip.querySelector(".side-bar-chip-status")?.className).toContain("tenant-beacon is-ended");
    expect(dormantChip.className).not.toContain("side-bar-chip--status-landed");
    expect(minimizedShelf.querySelector(".side-bar-status-header__unseen")).toBeNull();
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
    expect(firstLiveChip.querySelector(".side-bar-chip-status")?.className).toContain("tenant-beacon is-idle");
    expect(firstLiveChip.className).not.toContain("side-bar-chip--status-landed");
    expect(container?.querySelector(".side-bar-status-header__unseen")).toBeNull();

    act(() => setConsoleState({ operationRuntime: { restored: { lifecycle: "live", activity: "running" } } }));
    const runningTick = getStatusTransitionTick("restored");
    expect(runningTick).toBeDefined();

    act(() => setConsoleState({ operationRuntime: { restored: { lifecycle: "live", activity: "idle" } } }));

    const transitionedChip = required<HTMLElement>('[data-side-bar-chip-id="restored"]');
    expect(getStatusTransitionTick("restored")).toBeGreaterThan(runningTick ?? 0);
    expect(transitionedChip.querySelector(".side-bar-chip-status")?.className).toContain("tenant-beacon is-unseen");
    expect(transitionedChip.className).toContain("side-bar-chip--status-landed");
    expect(required<HTMLElement>(".side-bar-status-section--awaiting .side-bar-status-header__count").textContent).toBe("1");
  });

  it("separates Theater selection from persisted collapse and exposes the split control accessibility contract", () => {
    const onSelectTheater = vi.fn();
    renderSideBar([makeOperation("only", null)], [], onSelectTheater);

    expect(container?.querySelector(".side-bar-theater-count")).toBeNull();
    const activeTheater = required<HTMLButtonElement>(".side-bar-theater-activate");
    expect(activeTheater.getAttribute("aria-current")).toBe("true");
    expect(activeTheater.getAttribute("aria-disabled")).toBe("true");
    act(() => activeTheater.click());
    expect(onSelectTheater).not.toHaveBeenCalled();
    expect(required<HTMLButtonElement>(".side-bar-theater-split-plus").getAttribute("aria-label")).toBe("New Operation in Alpha");
    const collapse = required<HTMLButtonElement>(".side-bar-theater-collapse-btn");
    expect(collapse.getAttribute("aria-label")).toBe("Collapse Alpha");
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    const caret = required<HTMLButtonElement>(".side-bar-theater-split-caret");
    expect(caret.getAttribute("aria-haspopup")).toBe("menu");
    expect(caret.getAttribute("aria-expanded")).toBe("false");
    expect(caret.querySelectorAll("circle")).toHaveLength(3);
    expect(caret.querySelector("path")).toBeNull();

    act(() => collapse.click());

    expect(onSelectTheater).not.toHaveBeenCalled();
    expect(collapse.getAttribute("aria-label")).toBe("Expand Alpha");
    expect(collapse.getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem("fleet-console.operations.theater-collapsed")).toBe('["theater-a"]');
  });

  it("selects an inactive Theater by name without mutating its persisted collapse preference", () => {
    setTheaterCollapsed("theater-a", true);
    const onSelectTheater = vi.fn();
    renderSideBar([makeOperation("only", null)], [], onSelectTheater, "theater-other");

    act(() => required<HTMLElement>(".side-bar-theater-activate").click());

    expect(onSelectTheater).toHaveBeenCalledWith("theater-a");
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

// 이 파일의 기본 픽스처는 활동 축의 대역이다 — Shell은 활동 축을 발행하지 않아 마크가 종류
// 글리프로 갈리므로, 상태 칸·마크를 재는 픽스처는 에이전트여야 한다(Shell 사례는 아래 전용 테스트).
function makeOperation(id: string, groupId: string | null, accent?: string, theaterId: string = THEATER.id, type = "agent"): OperationNode {
  return {
    id,
    theaterId,
    type,
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
