// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { applyVisibleReorder, dropTargetFromPoint, insertIntoSegment, moveByTargetIndex, reorderWithinSegment, type DropSectionInfo } from "../core/client/src/sidebar/operations-side-bar-hit-test.js";
import { groupOperations, groupOperationsByStatus, hasAwaitingOperation, theaterInitials } from "../core/client/src/sidebar/operations-side-bar.js";
import type { SideBarEntry } from "../core/client/src/sidebar/operations-side-bar-chip.js";
import {
  getIdleUnseenIds,
  getStatusTransitionTick,
  markIdleUnseen,
  recordStatusTransitions,
  resetSideBarStatusRecencyForTests,
  trackOperationActivityTransitions,
} from "../core/client/src/sidebar/operations-side-bar-store.js";
import type { OperationGroup, OperationNode } from "../core/client/src/types.js";

function makeNode(id: string, groupId?: string | null): OperationNode {
  return {
    id,
    theaterId: "t1",
    type: "shell",
    pluginId: "terminal",
    title: id,
    payload: {},
    geometry: null,
    groupId,
    ts: { createdAt: 1, updatedAt: 1 },
  };
}

function makeEntry(id: string, groupId?: string | null, status?: OperationActivity): SideBarEntry {
  return {
    operation: makeNode(id, groupId),
    active: false,
    minimized: false,
    notificationCount: 0,
    status,
    icon: null,
  };
}

beforeEach(() => resetSideBarStatusRecencyForTests());
afterEach(() => resetSideBarStatusRecencyForTests());

function makeGroup(id: string, order: number): OperationGroup {
  return { id, name: id, color: "blue", order, theaterId: "t1", createdAt: order };
}

// ── dropTargetFromPoint ──────────────────────────────────────────────────────────

function buildChipsContainer(sections: Array<{
  sectionId: string | null;
  chipIds: string[];
  chipHeight?: number;
  headerHeight?: number; // 그룹 헤더 영역 높이 (기본 0)
  collapsed?: boolean;   // chips ol 없음 (collapsed 그룹 시뮬레이션)
}>): HTMLOListElement {
  const ol = document.createElement("ol");
  let yOffset = 0;

  for (const section of sections) {
    const headerH = section.headerHeight ?? 0;
    const chipH = section.chipHeight ?? 36;
    const key = sectionId(section.sectionId);

    // wrapper li: 헤더+chips를 감싸는 요소 (data-drop-zone-group-id)
    const wrapperLi = document.createElement("li");
    wrapperLi.dataset.dropZoneGroupId = key;
    const wrapperTop = yOffset;

    yOffset += headerH;

    if (!section.collapsed) {
      // chips ol (data-group-section-id)
      const innerOl = document.createElement("ol");
      innerOl.dataset.groupSectionId = key;
      const chipsTop = yOffset;

      for (const id of section.chipIds) {
        const li = document.createElement("li");
        li.dataset.sideBarChipId = id;
        const top = yOffset;
        li.getBoundingClientRect = () => ({
          top, bottom: top + chipH, height: chipH, left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => ({}),
        });
        innerOl.append(li);
        yOffset += chipH;
      }

      const chipsBottom = yOffset;
      innerOl.getBoundingClientRect = () => ({
        top: chipsTop, bottom: chipsBottom, height: chipsBottom - chipsTop,
        left: 0, right: 200, width: 200, x: 0, y: chipsTop, toJSON: () => ({}),
      });
      wrapperLi.append(innerOl);
    }

    const wrapperBottom = yOffset;
    wrapperLi.getBoundingClientRect = () => ({
      top: wrapperTop, bottom: wrapperBottom, height: wrapperBottom - wrapperTop,
      left: 0, right: 200, width: 200, x: 0, y: wrapperTop, toJSON: () => ({}),
    });

    ol.append(wrapperLi);
  }

  return ol as unknown as HTMLOListElement;
}

function sectionId(groupId: string | null): string {
  return groupId ?? "__ungrouped__";
}

describe("dropTargetFromPoint", () => {
  it("returns index 0 when container is null", () => {
    expect(dropTargetFromPoint(0, [], null)).toEqual({ groupId: null, index: 0 });
  });

  it("returns correct groupId and chip index when pointer is over first chip of group", () => {
    const sections: DropSectionInfo[] = [
      { groupId: "g1", entryIds: ["op-a", "op-b"] },
      { groupId: null, entryIds: ["op-c"] },
    ];
    const container = buildChipsContainer([
      { sectionId: "g1", chipIds: ["op-a", "op-b"] },
      { sectionId: null, chipIds: ["op-c"] },
    ]);
    // clientY = 5 → top half of first chip (op-a, top=0 height=36, midpoint=18)
    expect(dropTargetFromPoint(5, sections, container)).toEqual({ groupId: "g1", index: 0 });
  });

  it("returns index after last chip when pointer is below all chips in a section", () => {
    const sections: DropSectionInfo[] = [
      { groupId: "g1", entryIds: ["op-a"] },
      { groupId: null, entryIds: ["op-b"] },
    ];
    const container = buildChipsContainer([
      { sectionId: "g1", chipIds: ["op-a"] },
      { sectionId: null, chipIds: ["op-b"] },
    ]);
    // clientY = 35 → bottom of op-a (top=0, height=36, midpoint=18), so past midpoint → index 1 (after op-a)
    expect(dropTargetFromPoint(35, sections, container)).toEqual({ groupId: "g1", index: 1 });
  });

  it("skips sourceId chip when computing drop index", () => {
    const sections: DropSectionInfo[] = [{ groupId: null, entryIds: ["op-a", "op-b", "op-c"] }];
    const container = buildChipsContainer([
      { sectionId: null, chipIds: ["op-a", "op-b", "op-c"] },
    ]);
    // pointer at y=5, sourceId=op-a → op-a is skipped, first candidate is op-b (top=36, midpoint=54)
    // y=5 < 54, so index = indexOf("op-b") = 1
    expect(dropTargetFromPoint(5, sections, container, "op-a")).toEqual({ groupId: null, index: 1 });
  });

  it("selects ungrouped section when pointer is over it", () => {
    const sections: DropSectionInfo[] = [
      { groupId: "g1", entryIds: ["op-a"] },
      { groupId: null, entryIds: ["op-b"] },
    ];
    const container = buildChipsContainer([
      { sectionId: "g1", chipIds: ["op-a"] },
      { sectionId: null, chipIds: ["op-b"] },
    ]);
    // op-b starts at y=36, midpoint=54; pointer at y=36 → below midpoint of nothing → index=0 for ungrouped
    expect(dropTargetFromPoint(37, sections, container)).toEqual({ groupId: null, index: 0 });
  });

  it("그룹 헤더 영역(chips ol 위)에서 드롭 시 해당 그룹 index=0 반환", () => {
    // g1: headerHeight=32, chips top=32, op-a top=32, op-b top=68
    // clientY=10 → wrapper(top=0) 안, chips ol top=32보다 위 → 헤더 영역 → {g1, 0}
    const sections: DropSectionInfo[] = [
      { groupId: "g1", entryIds: ["op-a", "op-b"] },
      { groupId: null, entryIds: ["op-c"] },
    ];
    const container = buildChipsContainer([
      { sectionId: "g1", chipIds: ["op-a", "op-b"], headerHeight: 32 },
      { sectionId: null, chipIds: ["op-c"] },
    ]);
    expect(dropTargetFromPoint(10, sections, container)).toEqual({ groupId: "g1", index: 0 });
  });

  it("collapsed 그룹(chips ol 없음) 위에서 드롭 시 해당 그룹 index=0 반환", () => {
    // g1 collapsed: wrapper top=0 bottom=32 (헤더만), chips ol 없음
    // null: wrapper top=32 bottom=68
    const sections: DropSectionInfo[] = [
      { groupId: "g1", entryIds: [] },
      { groupId: null, entryIds: ["op-c"] },
    ];
    const container = buildChipsContainer([
      { sectionId: "g1", chipIds: [], headerHeight: 32, collapsed: true },
      { sectionId: null, chipIds: ["op-c"] },
    ]);
    expect(dropTargetFromPoint(16, sections, container)).toEqual({ groupId: "g1", index: 0 });
  });

  it("빈 그룹(chips ol 있지만 멤버 0)에서 드롭 시 해당 그룹 index=0 반환", () => {
    const sections: DropSectionInfo[] = [
      { groupId: "g1", entryIds: [] },
      { groupId: null, entryIds: ["op-c"] },
    ];
    const container = buildChipsContainer([
      { sectionId: "g1", chipIds: [], headerHeight: 32 },
      { sectionId: null, chipIds: ["op-c"] },
    ]);
    // clientY=10: 헤더 영역 → {g1, 0}
    expect(dropTargetFromPoint(10, sections, container)).toEqual({ groupId: "g1", index: 0 });
  });

  it("컨테이너 빈 하단 영역(마지막 섹션 이후)은 fallback으로 마지막 그룹 반환", () => {
    const sections: DropSectionInfo[] = [
      { groupId: "g1", entryIds: ["op-a"] },
      { groupId: null, entryIds: ["op-b"] },
    ];
    const container = buildChipsContainer([
      { sectionId: "g1", chipIds: ["op-a"] },
      { sectionId: null, chipIds: ["op-b"] },
    ]);
    // clientY=999: 모든 wrapper 밖 → fallback = 마지막 섹션(null) index=1
    expect(dropTargetFromPoint(999, sections, container)).toEqual({ groupId: null, index: 1 });
  });
});

// ── reorderWithinSegment ─────────────────────────────────────────────────────────

describe("reorderWithinSegment", () => {
  it("moves source to the beginning of the segment", () => {
    const allIds = ["a", "b", "c", "x", "y"];
    const segment = ["b", "c"];
    expect(reorderWithinSegment(allIds, "c", 0, segment)).toEqual(["a", "c", "b", "x", "y"]);
  });

  it("moves source to the end of the segment", () => {
    const allIds = ["a", "b", "c", "x"];
    const segment = ["b", "c"];
    expect(reorderWithinSegment(allIds, "b", 2, segment)).toEqual(["a", "c", "b", "x"]);
  });

  it("preserves non-segment entries in their original positions", () => {
    const allIds = ["a", "b", "c", "d", "e"];
    const segment = ["b", "d"];
    // move d before b
    expect(reorderWithinSegment(allIds, "d", 0, segment)).toEqual(["a", "d", "c", "b", "e"]);
  });

  it("clamps drop index to segment bounds", () => {
    const allIds = ["a", "b", "c"];
    const segment = ["a", "b", "c"];
    expect(reorderWithinSegment(allIds, "a", 100, segment)).toEqual(["b", "c", "a"]);
    expect(reorderWithinSegment(allIds, "c", -5, segment)).toEqual(["c", "a", "b"]);
  });

  it("returns stable order when source and destination are the same", () => {
    const allIds = ["a", "b", "c"];
    const segment = ["a", "b", "c"];
    expect(reorderWithinSegment(allIds, "b", 1, segment)).toEqual(["a", "b", "c"]);
  });
});

// ── groupOperations ──────────────────────────────────────────────────────────────

describe("groupOperations", () => {
  it("places groups in ascending order by group.order, ungrouped last", () => {
    const entries = [
      makeEntry("op-a", "g2"),
      makeEntry("op-b", "g1"),
      makeEntry("op-c", null),
    ];
    const groups = [makeGroup("g1", 1), makeGroup("g2", 2)];
    const sections = groupOperations(entries, groups, []);

    expect(sections.map((s) => s.groupId)).toEqual(["g1", "g2", null]);
    expect(sections[0]?.entries.map((e) => e.operation.id)).toEqual(["op-b"]);
    expect(sections[1]?.entries.map((e) => e.operation.id)).toEqual(["op-a"]);
    expect(sections[2]?.entries.map((e) => e.operation.id)).toEqual(["op-c"]);
  });

  it("puts operations with unknown groupId in ungrouped", () => {
    const entries = [makeEntry("op-a", "nonexistent"), makeEntry("op-b", null)];
    const groups: OperationGroup[] = [];
    const sections = groupOperations(entries, groups, []);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.groupId).toBeNull();
    expect(sections[0]?.entries.map((e) => e.operation.id)).toEqual(["op-a", "op-b"]);
  });

  it("breaks group.order ties by createdAt", () => {
    const entries = [makeEntry("op-a", "g2"), makeEntry("op-b", "g1")];
    const g1 = { ...makeGroup("g1", 0), createdAt: 2 };
    const g2 = { ...makeGroup("g2", 0), createdAt: 1 };
    const sections = groupOperations(entries, [g1, g2], []);
    expect(sections.map((s) => s.groupId)).toEqual(["g2", "g1", null]);
  });

  it("always appends ungrouped section even when empty", () => {
    const entries = [makeEntry("op-a", "g1")];
    const groups = [makeGroup("g1", 1)];
    const sections = groupOperations(entries, groups, []);
    expect(sections[sections.length - 1]?.groupId).toBeNull();
    expect(sections[sections.length - 1]?.entries).toHaveLength(0);
  });
});

describe("groupOperationsByStatus", () => {
  it("renders only non-empty sections in the literal status order and treats a missing key as idle", () => {
    const entries = [
      makeEntry("idle-missing"),
      makeEntry("dormant", null, "dormant"),
      makeEntry("awaiting", null, "awaiting"),
      makeEntry("running", null, "running"),
      makeEntry("idle-explicit", null, "idle"),
    ];

    const sections = groupOperationsByStatus(entries);

    expect(sections.map((section) => [section.status, section.label])).toEqual([
      ["awaiting", "AWAITING"],
      ["running", "RUNNING"],
      ["idle", "IDLE"],
      ["dormant", "DORMANT"],
    ]);
    expect(sections[2]?.entries.map((entry) => entry.operation.id)).toEqual(["idle-missing", "idle-explicit"]);
  });

  it("preserves the incoming sortOperationsByOrder sequence inside each status section", () => {
    const sections = groupOperationsByStatus([
      makeEntry("running-second", null, "running"),
      makeEntry("awaiting", null, "awaiting"),
      makeEntry("running-first", null, "running"),
    ]);

    expect(sections.find((section) => section.status === "running")?.entries.map((entry) => entry.operation.id))
      .toEqual(["running-second", "running-first"]);
  });

  it("orders transitioned entries by descending tick before untouched entries", () => {
    recordStatusTransitions(["earlier"]);
    recordStatusTransitions(["latest"]);
    const sections = groupOperationsByStatus([
      makeEntry("untouched-first", null, "running"),
      makeEntry("latest", null, "running"),
      makeEntry("earlier", null, "running"),
      makeEntry("untouched-second", null, "running"),
    ], getStatusTransitionTick);

    expect(sections.find((section) => section.status === "running")?.entries.map((entry) => entry.operation.id))
      .toEqual(["latest", "earlier", "untouched-first", "untouched-second"]);
  });

  it("resets transition ticks and idle unseen state together", () => {
    recordStatusTransitions(["operation"]);
    markIdleUnseen("operation");
    expect(getStatusTransitionTick("operation")).toBe(1);
    expect(getIdleUnseenIds().has("operation")).toBe(true);

    resetSideBarStatusRecencyForTests();

    expect(getStatusTransitionTick("operation")).toBeUndefined();
    expect(getIdleUnseenIds().size).toBe(0);
    recordStatusTransitions(["next-operation"]);
    expect(getStatusTransitionTick("next-operation")).toBe(1);
  });

  it("marks an idle transition when the preserved active Operation belongs to another Theater", () => {
    const operation = { ...makeNode("operation"), theaterId: "theater-a" };
    trackOperationActivityTransitions({
      operations: [operation],
      operationStatus: { operation: "running" },
      activeTheaterId: "theater-b",
      activeOperationId: operation.id,
    });

    expect(trackOperationActivityTransitions({
      operations: [operation],
      operationStatus: { operation: "idle" },
      activeTheaterId: "theater-b",
      activeOperationId: operation.id,
    })).toEqual([operation.id]);
    expect(getIdleUnseenIds().has(operation.id)).toBe(true);
    const tick = getStatusTransitionTick(operation.id);

    expect(trackOperationActivityTransitions({
      operations: [operation],
      operationStatus: { operation: "idle" },
      activeTheaterId: "theater-b",
      activeOperationId: operation.id,
    })).toEqual([]);
    expect(getStatusTransitionTick(operation.id)).toBe(tick);
    expect(getIdleUnseenIds().has(operation.id)).toBe(true);

    expect(trackOperationActivityTransitions({
      operations: [operation],
      operationStatus: { operation: "idle" },
      activeTheaterId: operation.theaterId,
      activeOperationId: operation.id,
    })).toEqual([]);
    expect(getIdleUnseenIds().has(operation.id)).toBe(false);
  });

  it("does not mark an idle transition for the focused Operation in the active Theater", () => {
    const operation = { ...makeNode("focused"), theaterId: "theater-a" };
    trackOperationActivityTransitions({
      operations: [operation],
      operationStatus: { focused: "running" },
      activeTheaterId: operation.theaterId,
      activeOperationId: operation.id,
    });

    expect(trackOperationActivityTransitions({
      operations: [operation],
      operationStatus: { focused: "idle" },
      activeTheaterId: operation.theaterId,
      activeOperationId: operation.id,
    })).toEqual([operation.id]);
    expect(getIdleUnseenIds().has(operation.id)).toBe(false);
  });

  it("clears unseen for the active Operation on every tracker call", () => {
    const operation = makeNode("focused");
    markIdleUnseen("focused");

    expect(trackOperationActivityTransitions({
      operations: [operation],
      operationStatus: {},
      activeTheaterId: operation.theaterId,
      activeOperationId: "focused",
    })).toEqual([]);
    expect(getIdleUnseenIds().has("focused")).toBe(false);
  });

  it("detects the GROUP-axis live tick only for an explicit awaiting status", () => {
    const operations = [makeNode("a"), makeNode("b")];
    expect(hasAwaitingOperation(operations, { a: "running", b: "awaiting" })).toBe(true);
    expect(hasAwaitingOperation(operations, { a: "running" })).toBe(false);
  });
});

// ── insertIntoSegment ────────────────────────────────────────────────────────────

describe("insertIntoSegment", () => {
  it("cross-group: sourceId를 대상 segment의 첫 번째 위치(index=0)에 삽입한다", () => {
    // allIds: [op-a(g1), op-b(g1), op-c(g2), op-d(g2)]
    // op-e(현재 g1)를 g2 index=0 위치로 이동
    const allIds = ["op-a", "op-b", "op-c", "op-d", "op-e"];
    const segmentIds = ["op-c", "op-d"]; // g2 현재 멤버
    expect(insertIntoSegment(allIds, "op-e", 0, segmentIds)).toEqual([
      "op-a", "op-b", "op-e", "op-c", "op-d",
    ]);
  });

  it("cross-group: sourceId를 대상 segment의 마지막(index=segment.length) 위치에 삽입한다", () => {
    const allIds = ["op-a", "op-b", "op-c", "op-d", "op-e"];
    const segmentIds = ["op-c", "op-d"];
    expect(insertIntoSegment(allIds, "op-e", 2, segmentIds)).toEqual([
      "op-a", "op-b", "op-c", "op-d", "op-e",
    ]);
  });

  it("cross-group: sourceId를 대상 segment의 중간(index=1) 위치에 삽입한다", () => {
    const allIds = ["op-a", "op-b", "op-c", "op-d", "op-e"];
    const segmentIds = ["op-c", "op-d"];
    expect(insertIntoSegment(allIds, "op-e", 1, segmentIds)).toEqual([
      "op-a", "op-b", "op-c", "op-e", "op-d",
    ]);
  });

  it("빈 segment(collapsed 그룹 등)로의 드롭 시 sourceId를 allIds 끝에 추가한다", () => {
    const allIds = ["op-a", "op-b", "op-c"];
    expect(insertIntoSegment(allIds, "op-a", 0, [])).toEqual(["op-b", "op-c", "op-a"]);
  });

  it("dropIndex가 범위를 초과해도 segment 마지막에 안전하게 삽입한다", () => {
    const allIds = ["op-a", "op-b", "op-c"];
    const segmentIds = ["op-b", "op-c"];
    expect(insertIntoSegment(allIds, "op-a", 99, segmentIds)).toEqual(["op-b", "op-c", "op-a"]);
  });

  it("dropIndex 음수는 0으로 처리해 segment 첫 번째에 삽입한다", () => {
    const allIds = ["op-a", "op-b", "op-c"];
    const segmentIds = ["op-b", "op-c"];
    expect(insertIntoSegment(allIds, "op-a", -5, segmentIds)).toEqual(["op-a", "op-b", "op-c"]);
  });
});

// ── reorderWithinSegment (P2-6 드롭 인덱스 보정) ─────────────────────────────────

describe("reorderWithinSegment — downward/upward 보정", () => {
  it("downward: A→C 앞(index=2)으로 드래그 시 [B,A,C]가 된다", () => {
    // [A,B,C], source=A(index=0), drop=index 2(C 앞) → 기대 [B,A,C]
    // 보정: 2 > 0 → 2-1=1, splice(1)=[B,A,C]
    const result = reorderWithinSegment(["A", "B", "C"], "A", 2, ["A", "B", "C"]);
    expect(result).toEqual(["B", "A", "C"]);
  });

  it("downward: A→끝(index=3)으로 드래그 시 [B,C,A]가 된다", () => {
    // [A,B,C], source=A(index=0), drop=3(끝) → 보정: 3-1=2 → [B,C,A]
    const result = reorderWithinSegment(["A", "B", "C"], "A", 3, ["A", "B", "C"]);
    expect(result).toEqual(["B", "C", "A"]);
  });

  it("upward: C→B 앞(index=1)으로 드래그 시 [A,C,B]가 된다", () => {
    // [A,B,C], source=C(index=2), drop=1(B 앞) → 보정 없음(1 <= 2) → splice(1)=[A,C,B]
    const result = reorderWithinSegment(["A", "B", "C"], "C", 1, ["A", "B", "C"]);
    expect(result).toEqual(["A", "C", "B"]);
  });

  it("upward: C→A 앞(index=0)으로 드래그 시 [C,A,B]가 된다", () => {
    const result = reorderWithinSegment(["A", "B", "C"], "C", 0, ["A", "B", "C"]);
    expect(result).toEqual(["C", "A", "B"]);
  });

  it("segment 밖 op이 포함된 allIds에서도 segment 내 순서만 변경된다", () => {
    // allIds: [X, A, B, C, Y], segment=[A,B,C], A→C 앞
    const result = reorderWithinSegment(["X", "A", "B", "C", "Y"], "A", 2, ["A", "B", "C"]);
    expect(result).toEqual(["X", "B", "A", "C", "Y"]);
  });
});

// ── applyVisibleReorder (P2-7 keyboard 재배치 hidden 보존) ───────────────────────

describe("applyVisibleReorder", () => {
  it("visible op만 재배치하고 hidden(collapsed) op은 제자리를 유지한다", () => {
    // currentOrder: [h1, v1, h2, v2, v3]  (h=hidden, v=visible)
    // visibleOrder: [v1, v2, v3], nextVisibleOrder: [v3, v1, v2]
    // 기대: [h1, v3, h2, v1, v2]
    const result = applyVisibleReorder(
      ["h1", "v1", "h2", "v2", "v3"],
      ["v1", "v2", "v3"],
      ["v3", "v1", "v2"],
    );
    expect(result).toEqual(["h1", "v3", "h2", "v1", "v2"]);
  });

  it("hidden op이 없을 때 nextVisibleOrder와 동일하다", () => {
    const result = applyVisibleReorder(["a", "b", "c"], ["a", "b", "c"], ["c", "a", "b"]);
    expect(result).toEqual(["c", "a", "b"]);
  });

  it("visible op이 없을 때 currentOrder를 그대로 반환한다", () => {
    const result = applyVisibleReorder(["h1", "h2"], [], []);
    expect(result).toEqual(["h1", "h2"]);
  });

  it("visible 재배치가 인접하지 않은 hidden op 사이를 올바르게 채운다", () => {
    // currentOrder: [v1, h1, v2, h2, v3]
    // visibleOrder: [v1, v2, v3] → nextVisibleOrder: [v2, v3, v1]
    // 기대: [v2, h1, v3, h2, v1]
    const result = applyVisibleReorder(
      ["v1", "h1", "v2", "h2", "v3"],
      ["v1", "v2", "v3"],
      ["v2", "v3", "v1"],
    );
    expect(result).toEqual(["v2", "h1", "v3", "h2", "v1"]);
  });

  it("nextVisibleOrder 길이가 visibleOrder와 다르면 currentOrder를 그대로 반환한다(op 손실 방지)", () => {
    // 길이 불일치 → fallback
    const currentOrder = ["a", "b", "c", "h1"];
    const result = applyVisibleReorder(currentOrder, ["a", "b", "c"], ["a", "b"]);
    expect(result).toEqual(currentOrder);
  });
});

// ── moveByTargetIndex (keyboard ArrowDown/Up 전용) ───────────────────────────────

describe("moveByTargetIndex", () => {
  it("ArrowDown: A(index=0)를 targetIndex=1로 이동 시 [B,A,C]가 된다", () => {
    // drag reorderIds와 달리 -1 보정이 없으므로 targetIndex=1이 그대로 삽입 위치
    expect(moveByTargetIndex(["A", "B", "C"], "A", 1)).toEqual(["B", "A", "C"]);
  });

  it("ArrowDown: A(index=0)를 targetIndex=2로 이동 시 [B,C,A]가 된다", () => {
    expect(moveByTargetIndex(["A", "B", "C"], "A", 2)).toEqual(["B", "C", "A"]);
  });

  it("ArrowUp: C(index=2)를 targetIndex=1로 이동 시 [A,C,B]가 된다", () => {
    expect(moveByTargetIndex(["A", "B", "C"], "C", 1)).toEqual(["A", "C", "B"]);
  });

  it("ArrowUp: C(index=2)를 targetIndex=0으로 이동 시 [C,A,B]가 된다", () => {
    expect(moveByTargetIndex(["A", "B", "C"], "C", 0)).toEqual(["C", "A", "B"]);
  });

  it("경계값: targetIndex가 0이면 맨 앞으로 이동한다", () => {
    expect(moveByTargetIndex(["A", "B", "C"], "B", 0)).toEqual(["B", "A", "C"]);
  });

  it("경계값: targetIndex가 배열 끝을 넘으면 맨 뒤로 이동한다", () => {
    expect(moveByTargetIndex(["A", "B", "C"], "A", 99)).toEqual(["B", "C", "A"]);
  });

  it("sourceId가 없으면 배열을 그대로 반환한다", () => {
    expect(moveByTargetIndex(["A", "B", "C"], "X", 1)).toEqual(["A", "B", "C"]);
  });
});

describe("theaterInitials", () => {
  it("uses two graphemes for a single word", () => {
    expect(theaterInitials("fleet")).toBe("FL");
  });

  it("preserves Korean and CJK graphemes", () => {
    expect(theaterInitials("함대")).toBe("함대");
    expect(theaterInitials("東京")).toBe("東京");
  });

  it("keeps a supplementary-plane grapheme intact", () => {
    expect(theaterInitials("𝔘nicode Lab")).toBe("𝔘L");
  });

  it("keeps an emoji-prefix grapheme in a multi-word Theater", () => {
    expect(theaterInitials("🚀 Fleet")).toBe("🚀F");
  });
});
