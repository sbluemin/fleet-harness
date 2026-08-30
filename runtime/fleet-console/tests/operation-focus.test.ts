import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { focusCycleOperationIds, getState, nextOperationId, requestOperationKeyboardFocus, setState } from "../core/client/src/store.js";
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

  // statusAxis 상태는 operations-side-bar-store 모듈에만 존재하므로, Operations 페이지가 그 모듈에서
  // 무엇을 가져오는지가 "순환 순서는 상태 정렬 축과 무관하다"는 계약의 렉시컬 방어선이다.
  // (행동 자체는 focusCycleOperationIds가 statusAxis를 인자로도 받지 않는다는 시그니처가 보장한다.)
  it("Alt+←/→ 순환은 사이드바 'Sort by status' 축에 분기하지 않는다", () => {
    const source = fs.readFileSync(new URL("../core/client/src/pages/operations.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("statusCycleOperationIds");
    const sideBarStoreImport = /import \{([^}]*)\} from "\.\.\/sidebar\/operations-side-bar-store\.js";/.exec(source);
    // useSideBarState는 아레나 인셋(부유 크롬 점유 폭) 계산 전용이다 — 순환 순서에는 여전히
    // 상태 축이 관여하지 않는다(focusCycleOperationIds 시그니처가 보장).
    expect(sideBarStoreImport?.[1]?.split(",").map((symbol) => symbol.trim())).toEqual(["toggleSideBarStatusAxis", "useSideBarState"]);
  });

  // 캡션·칩이 여는 Operation 메뉴는 페이지가 소유하므로 주인 패널이 언마운트돼도 저 혼자 남는다.
  // 무대를 통째로 갈아치우는 두 전환(Theater 전환·War Room 토글)이 회수 신호라는 것이 이 계약이다 —
  // 팔레트의 switch-theater처럼 메뉴를 거치지 않는 경로로도 전환이 들어오기 때문이다.
  it("무대를 갈아치우는 전환은 열린 Operation 메뉴를 회수한다", () => {
    const source = fs.readFileSync(new URL("../core/client/src/pages/operations.tsx", import.meta.url), "utf8");
    const dismissEffect = /useEffect\(\(\) => \{\s*setOperationMenu\(null\);\s*\}, \[([^\]]*)\]\);/.exec(source);
    expect(dismissEffect).not.toBeNull();
    expect(dismissEffect?.[1]?.split(",").map((dep) => dep.trim())).toEqual(["state.activeTheaterId", "triageActive"]);
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
