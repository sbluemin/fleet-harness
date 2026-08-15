import { describe, expect, it } from "vitest";

import { flattenGroupedOrder, resolveOperationGroup } from "../core/client/src/store.js";
import type { OperationGroup, OperationNode } from "../core/client/src/types.js";

function makeOp(id: string, groupId: string | null = null, createdAt = 1): OperationNode {
  return {
    id,
    theaterId: "t1",
    type: "shell",
    pluginId: "terminal",
    title: id,
    payload: {},
    geometry: null,
    groupId,
    ts: { createdAt, updatedAt: createdAt },
  };
}

function makeGroup(id: string, order: number, createdAt = order): OperationGroup {
  return { id, name: id, color: "blue", order, theaterId: "t1", createdAt };
}

describe("flattenGroupedOrder", () => {
  it("그룹 없이 operationOrder 순서대로 반환한다", () => {
    const ops = [makeOp("op-a"), makeOp("op-b"), makeOp("op-c")];
    const result = flattenGroupedOrder(ops, [], ["op-c", "op-a", "op-b"]);
    expect(result.map((o) => o.id)).toEqual(["op-c", "op-a", "op-b"]);
  });

  it("그룹 order가 낮은 그룹의 op이 먼저 온다 — operationOrder는 무시한 경우에도", () => {
    // op-old는 group2 소속이지만 createdAt이 오래됨, op-new는 group1 소속으로 새로 생성
    // operationOrder: [op-old, op-new] (생성 순)
    // group1.order=1 < group2.order=2 이므로 group1의 op-new가 먼저 cycling
    const ops = [makeOp("op-old", "g2", 1), makeOp("op-new", "g1", 2)];
    const groups = [makeGroup("g1", 1), makeGroup("g2", 2)];
    const result = flattenGroupedOrder(ops, groups, ["op-old", "op-new"]);
    expect(result.map((o) => o.id)).toEqual(["op-new", "op-old"]);
  });

  it("그룹 내부는 operationOrder를 따른다", () => {
    const ops = [makeOp("op-a", "g1", 1), makeOp("op-b", "g1", 2), makeOp("op-c", "g1", 3)];
    const groups = [makeGroup("g1", 1)];
    // operationOrder: c → a → b
    const result = flattenGroupedOrder(ops, groups, ["op-c", "op-a", "op-b"]);
    expect(result.map((o) => o.id)).toEqual(["op-c", "op-a", "op-b"]);
  });

  it("ungrouped는 마지막에 온다", () => {
    const ops = [makeOp("op-ungrouped", null, 1), makeOp("op-grouped", "g1", 2)];
    const groups = [makeGroup("g1", 1)];
    const result = flattenGroupedOrder(ops, groups, []);
    expect(result.map((o) => o.id)).toEqual(["op-grouped", "op-ungrouped"]);
  });

  it("존재하지 않는 groupId는 ungrouped로 분류된다", () => {
    const ops = [makeOp("op-a", "nonexistent", 1), makeOp("op-b", "g1", 2)];
    const groups = [makeGroup("g1", 1)];
    const result = flattenGroupedOrder(ops, groups, []);
    expect(result.map((o) => o.id)).toEqual(["op-b", "op-a"]);
  });

  it("그룹 order 동점일 때 createdAt으로 순서를 결정한다", () => {
    const ops = [makeOp("op-a", "g2"), makeOp("op-b", "g1")];
    const g1 = { ...makeGroup("g1", 0), createdAt: 2 };
    const g2 = { ...makeGroup("g2", 0), createdAt: 1 };
    // g2.createdAt=1 < g1.createdAt=2 이므로 g2 먼저
    const result = flattenGroupedOrder(ops, [g1, g2], []);
    expect(result.map((o) => o.id)).toEqual(["op-a", "op-b"]);
  });

  it("그룹이 여러 개일 때 sidebar groupOperations와 동일한 flat 순서를 반환한다", () => {
    // sidebar: sortedGroups=[g1(order=1), g2(order=2)] → g1엔트리→g2엔트리→ungrouped
    // operationOrder: [op-z, op-y, op-x, op-w, op-v]
    const ops = [
      makeOp("op-z", "g2", 5),  // g2 소속
      makeOp("op-y", "g1", 4),  // g1 소속
      makeOp("op-x", null, 3),  // ungrouped
      makeOp("op-w", "g2", 2),  // g2 소속
      makeOp("op-v", "g1", 1),  // g1 소속
    ];
    const groups = [makeGroup("g1", 1), makeGroup("g2", 2)];
    const operationOrder = ["op-z", "op-y", "op-x", "op-w", "op-v"];
    const result = flattenGroupedOrder(ops, groups, operationOrder);
    // g1: operationOrder 기준 [op-y, op-v], g2: [op-z, op-w], ungrouped: [op-x]
    expect(result.map((o) => o.id)).toEqual(["op-y", "op-v", "op-z", "op-w", "op-x"]);
  });

  it("collapsedGroups 지정 시 해당 그룹 멤버를 결과에서 제외한다", () => {
    const ops = [makeOp("op-a", "g1"), makeOp("op-b", "g2"), makeOp("op-c", null)];
    const groups = [makeGroup("g1", 1), makeGroup("g2", 2)];
    // g1이 collapsed → op-a 제외, g2·ungrouped는 포함
    const result = flattenGroupedOrder(ops, groups, [], ["g1"]);
    expect(result.map((o) => o.id)).toEqual(["op-b", "op-c"]);
  });

  it("모든 그룹이 collapsed이면 ungrouped만 반환한다", () => {
    const ops = [makeOp("op-a", "g1"), makeOp("op-b", "g2"), makeOp("op-c", null)];
    const groups = [makeGroup("g1", 1), makeGroup("g2", 2)];
    const result = flattenGroupedOrder(ops, groups, [], ["g1", "g2"]);
    expect(result.map((o) => o.id)).toEqual(["op-c"]);
  });

  it("collapsedGroups 빈 배열이면 모든 멤버를 포함한다(기존 동작 보존)", () => {
    const ops = [makeOp("op-a", "g1"), makeOp("op-b", "g2"), makeOp("op-c", null)];
    const groups = [makeGroup("g1", 1), makeGroup("g2", 2)];
    const result = flattenGroupedOrder(ops, groups, [], []);
    expect(result.map((o) => o.id)).toEqual(["op-a", "op-b", "op-c"]);
  });

  it("collapsedGroups 생략 시 기본값 빈 배열로 동작한다", () => {
    const ops = [makeOp("op-a", "g1"), makeOp("op-b", null)];
    const groups = [makeGroup("g1", 1)];
    const result = flattenGroupedOrder(ops, groups, []);
    expect(result.map((o) => o.id)).toEqual(["op-a", "op-b"]);
  });
});

describe("resolveOperationGroup", () => {
  const groupById = (...groups: OperationGroup[]) => new Map(groups.map((group) => [group.id, group]));

  it("같은 Theater의 그룹을 돌려준다", () => {
    const group = makeGroup("g1", 1);
    expect(resolveOperationGroup(makeOp("op-a", "g1"), groupById(group))).toBe(group);
  });

  it("groupId가 없으면 null이다", () => {
    expect(resolveOperationGroup(makeOp("op-a", null), groupById(makeGroup("g1", 1)))).toBeNull();
  });

  it("존재하지 않는 groupId는 null이다", () => {
    expect(resolveOperationGroup(makeOp("op-a", "missing"), groupById(makeGroup("g1", 1)))).toBeNull();
  });

  // 선별 무대는 활성 Theater 밖 Operation도 올린다. 판정 기준은 활성 Theater가 아니라
  // Operation 자신의 Theater이므로, 외부 무대의 그룹은 그대로 살아 있어야 한다.
  it("외부 Theater Operation도 자기 Theater 그룹이면 돌려준다", () => {
    const foreignOp = { ...makeOp("op-far", "g-far"), theaterId: "t2" };
    const foreignGroup = { ...makeGroup("g-far", 1), theaterId: "t2" };
    expect(resolveOperationGroup(foreignOp, groupById(foreignGroup))).toBe(foreignGroup);
  });

  // 서버 PATCH는 groupId의 Theater 소속을 검사하지 않아 타 Theater 그룹이 붙을 수 있다.
  // 사이드바는 그 조합을 미분류로 읽으므로 캡션도 같은 답을 내야 두 면이 서로를 부정하지 않는다.
  it("Theater가 다른 그룹은 거부한다 — 사이드바의 미분류 판정과 같은 답", () => {
    const crossTheaterGroup = { ...makeGroup("g-other", 1), theaterId: "t2" };
    expect(resolveOperationGroup(makeOp("op-a", "g-other"), groupById(crossTheaterGroup))).toBeNull();
  });
});
