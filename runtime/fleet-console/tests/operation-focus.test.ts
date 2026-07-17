import { describe, expect, it } from "vitest";

import { focusCycleOperationIds, nextOperationId } from "../core/client/src/store.js";
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

  it("falls back to SideBar order when every visible operation is minimized", () => {
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

    expect(order).toEqual(["grouped", "ungrouped"]);
    expect(nextOperationId(order, null, 1)).toBe("grouped");
    expect(nextOperationId(order, null, -1)).toBe("ungrouped");
  });

});
