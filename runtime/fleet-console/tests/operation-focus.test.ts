import { describe, expect, it } from "vitest";

import {
  getSideBarStatusSectionCollapsed,
  resetSideBarStatusSectionCollapseForTests,
  toggleSideBarStatusSectionCollapsed,
} from "../core/client/src/sidebar/operations-side-bar-store.js";
import { focusCycleOperationIds, getState, nextOperationId, requestOperationKeyboardFocus, setState, statusCycleOperationIds } from "../core/client/src/store.js";
import type { OperationGroup, OperationNode } from "../core/client/src/types.js";

function makeOperation(id: string, groupId: string | null = null, createdAt = 1): OperationNode {
  return {
    id,
    theaterId: "theater",
    type: "shell",
    pluginId: "terminal",
    title: id,
    payload: {},
    geometry: null,
    groupId,
    ts: { createdAt, updatedAt: createdAt },
  };
}

function makeGroup(id: string, order: number): OperationGroup {
  return { id, name: id, color: "blue", order, theaterId: "theater", createdAt: order };
}

describe("nextOperationId — Alt+←/→ focus cycle", () => {
  const order = ["a", "b", "c"];

  it("moves to the next operation, wrapping past the end", () => {
    expect(nextOperationId(order, "a", 1)).toBe("b");
    expect(nextOperationId(order, "b", 1)).toBe("c");
    expect(nextOperationId(order, "c", 1)).toBe("a");
  });

  it("moves to the previous operation, wrapping past the start", () => {
    expect(nextOperationId(order, "c", -1)).toBe("b");
    expect(nextOperationId(order, "b", -1)).toBe("a");
    expect(nextOperationId(order, "a", -1)).toBe("c");
  });

  it("starts from an edge when nothing (or an unknown id) is active", () => {
    expect(nextOperationId(order, null, 1)).toBe("a");
    expect(nextOperationId(order, null, -1)).toBe("c");
    expect(nextOperationId(order, "missing", 1)).toBe("a");
  });

  it("stays on the only operation and returns null when there are none", () => {
    expect(nextOperationId(["solo"], "solo", 1)).toBe("solo");
    expect(nextOperationId(["solo"], "solo", -1)).toBe("solo");
    expect(nextOperationId([], "a", 1)).toBeNull();
  });

  it("excludes minimized panels while preserving grouped and collapsed SideBar order", () => {
    const order = focusCycleOperationIds(
      [
        makeOperation("group-2-visible", "group-2", 1),
        makeOperation("group-1-minimized", "group-1", 2),
        makeOperation("group-1-visible", "group-1", 3),
        makeOperation("collapsed-visible", "collapsed", 4),
        makeOperation("ungrouped-minimized", null, 5),
        makeOperation("ungrouped-visible", null, 6),
      ],
      [makeGroup("group-1", 1), makeGroup("group-2", 2), makeGroup("collapsed", 3)],
      ["group-2-visible", "group-1-minimized", "group-1-visible", "collapsed-visible", "ungrouped-minimized", "ungrouped-visible"],
      ["collapsed"],
      ["group-1-minimized", "ungrouped-minimized"],
    );

    expect(order).toEqual(["group-1-visible", "group-2-visible", "ungrouped-visible"]);
    expect(nextOperationId(order, "group-1-visible", 1)).toBe("group-2-visible");
    expect(nextOperationId(order, "group-1-visible", -1)).toBe("ungrouped-visible");
  });

  it("returns no targets when every visible operation is minimized", () => {
    const order = focusCycleOperationIds(
      [
        makeOperation("grouped", "group", 1),
        makeOperation("collapsed", "collapsed", 2),
        makeOperation("ungrouped", null, 3),
      ],
      [makeGroup("group", 1), makeGroup("collapsed", 2)],
      ["grouped", "collapsed", "ungrouped"],
      ["collapsed"],
      ["grouped", "collapsed", "ungrouped"],
    );

    expect(order).toEqual([]);
    expect(nextOperationId(order, null, 1)).toBeNull();
    expect(nextOperationId(order, null, -1)).toBeNull();
  });

});

describe("Operation keyboard focus requests", () => {
  it("increments exactly once per request, including repeated requests for the same Operation", () => {
    setState({ keyboardFocusRequest: null });

    requestOperationKeyboardFocus("same-operation");
    expect(getState().keyboardFocusRequest).toEqual({ operationId: "same-operation", requestId: 1 });

    requestOperationKeyboardFocus("same-operation");
    expect(getState().keyboardFocusRequest).toEqual({ operationId: "same-operation", requestId: 2 });

    requestOperationKeyboardFocus("other-operation");
    expect(getState().keyboardFocusRequest).toEqual({ operationId: "other-operation", requestId: 3 });
  });
});

describe("statusCycleOperationIds — STATUS 축 Alt+←/→ 순환", () => {
  it("orders by awaiting → running → idle → dormant, keeping operationOrder inside each rank and ignoring group collapse", () => {
    const operations = [
      makeOperation("idle-late", null, 1),
      makeOperation("running-1", "collapsed-group", 2),
      makeOperation("awaiting-1", "collapsed-group", 3),
      makeOperation("idle-early", null, 4),
      makeOperation("dormant-1", null, 5),
    ];
    const order = statusCycleOperationIds(
      operations,
      ["idle-early", "idle-late", "running-1", "awaiting-1", "dormant-1"],
      { "running-1": "running", "awaiting-1": "awaiting", "dormant-1": "dormant" },
      [],
      () => false,
    );
    // 사이드바 STATUS 섹션과 동일한 가시 순서: 접힌 그룹 소속이어도 제외되지 않는다.
    expect(order).toEqual(["awaiting-1", "running-1", "idle-early", "idle-late", "dormant-1"]);
  });

  it("drops minimized operations and treats missing status as idle", () => {
    const operations = [
      makeOperation("plain", null, 1),
      makeOperation("minimized-awaiting", null, 2),
    ];
    const order = statusCycleOperationIds(
      operations,
      ["plain", "minimized-awaiting"],
      { "minimized-awaiting": "awaiting" },
      ["minimized-awaiting"],
      () => false,
    );
    expect(order).toEqual(["plain"]);
  });

  it("ranks a restored operation with providerSession but no live status as dormant", () => {
    const restored = { ...makeOperation("restored", null, 1), payload: { providerSession: { provider: "claude", sessionId: "s1" } } };
    const operations = [makeOperation("plain", null, 2), restored];
    const order = statusCycleOperationIds(
      operations,
      ["restored", "plain"],
      {},
      [],
      () => false,
    );
    // idle(plain) → dormant(restored) 랭크 순서여야 사이드바 STATUS 섹션과 일치한다.
    expect(order).toEqual(["plain", "restored"]);
  });

  it("lets a live status entry win over the providerSession dormant fallback", () => {
    const restored = { ...makeOperation("restored", null, 1), payload: { providerSession: { provider: "claude", sessionId: "s1" } } };
    const order = statusCycleOperationIds(
      [restored, makeOperation("plain", null, 2)],
      ["restored", "plain"],
      { restored: "running" },
      [],
      () => false,
    );
    expect(order).toEqual(["restored", "plain"]);
  });

  it("excludes explicitly collapsed status sections, restores them when expanded, and leaves GROUP cycling unchanged", () => {
    resetSideBarStatusSectionCollapseForTests();
    const operations = [
      makeOperation("awaiting"),
      makeOperation("running"),
      makeOperation("idle"),
    ];
    const operationOrder = operations.map((operation) => operation.id);
    const operationStatus = { awaiting: "awaiting", running: "running" } as const;
    const statusOrder = () => statusCycleOperationIds(
      operations,
      operationOrder,
      operationStatus,
      [],
      (status) => getSideBarStatusSectionCollapsed("theater", status, false),
    );

    try {
      expect(statusOrder()).toEqual(["awaiting", "running", "idle"]);

      toggleSideBarStatusSectionCollapsed("theater", "running", false);

      expect(statusOrder()).toEqual(["awaiting", "idle"]);
      expect(focusCycleOperationIds(operations, [], operationOrder, [], []))
        .toEqual(["awaiting", "running", "idle"]);

      toggleSideBarStatusSectionCollapsed("theater", "running", false);

      expect(statusOrder()).toEqual(["awaiting", "running", "idle"]);
    } finally {
      resetSideBarStatusSectionCollapseForTests();
    }
  });
});
