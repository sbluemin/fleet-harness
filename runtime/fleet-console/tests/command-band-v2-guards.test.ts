// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { commandBandActiveOperation, commandBandCenterFits, commandBandCenterGutter, commandBandMenuClampedLeft, commandBandRenameCommitTarget, commandBandSwitcherFocusLeft, commandBandTheaterOperations } from "../core/client/src/components/command-band-guards.js";
import type { OperationGroup, OperationNode } from "../core/client/src/types.js";

describe("Command Band v2 guards", () => {
  it("does not commit a previous Operation draft after another panel becomes active", () => {
    const draft = "previous-operation draft";
    const capturedOperationId = "operation-a";
    const activeOperationId = "operation-b";

    expect(draft).toBe("previous-operation draft");
    expect(commandBandRenameCommitTarget(capturedOperationId, activeOperationId)).toBeNull();
  });

  it("disables Fit all panels until Operations hydrate", () => {
    const source = readFileSync(resolve(process.cwd(), "core/client/src/components/command-band.tsx"), "utf8");

    expect(source).toContain("disabled={state.activeTheaterId === null || triageActive || !state.operationsHydrated}");
  });
});

describe("Command Band active Operation display guard", () => {
  const operations: readonly OperationNode[] = [
    makeOperation("op-a", "theater-a"),
    makeOperation("op-b", "theater-b"),
  ];

  it("returns the active Operation when it belongs to the active Theater", () => {
    expect(commandBandActiveOperation(operations, "op-a", "theater-a")?.id).toBe("op-a");
  });

  it("hides a stale Operation after switching to another Theater", () => {
    // setActiveTheater는 activeOperationId를 지우지 않는다 — 타 Theater op는 표시하지 않는다.
    expect(commandBandActiveOperation(operations, "op-b", "theater-a")).toBeNull();
  });

  it("returns null without an active Theater or Operation", () => {
    expect(commandBandActiveOperation(operations, null, "theater-a")).toBeNull();
    expect(commandBandActiveOperation(operations, "op-a", null)).toBeNull();
    expect(commandBandActiveOperation(operations, "op-gone", "theater-a")).toBeNull();
  });
});

describe("Command Band rename cancel follows the displayed Operation", () => {
  const operations: readonly OperationNode[] = [makeOperation("op-a", "theater-a")];

  it("keeps the draft while the captured Operation is still displayed", () => {
    const displayed = commandBandActiveOperation(operations, "op-a", "theater-a");
    expect(commandBandRenameCommitTarget("op-a", displayed?.id ?? null)).toBe("op-a");
  });

  it("drops the draft when a Theater switch hides the captured Operation even though activeOperationId is unchanged", () => {
    // setActiveTheater는 activeOperationId를 유지한다 — 표시 대상(P0 가드) 기준으로는 어긋나야 취소된다.
    const displayed = commandBandActiveOperation(operations, "op-a", "theater-b");
    expect(displayed).toBeNull();
    expect(commandBandRenameCommitTarget("op-a", displayed?.id ?? null)).toBeNull();
  });
});

describe("Command Band switcher focusout close decision", () => {
  it("stays open while focus moves within the wrapper and closes when it leaves or vanishes", () => {
    const wrapper = document.createElement("div");
    const inside = document.createElement("button");
    wrapper.append(inside);
    const outside = document.createElement("button");
    document.body.append(wrapper, outside);

    expect(commandBandSwitcherFocusLeft(wrapper, inside)).toBe(false);
    expect(commandBandSwitcherFocusLeft(wrapper, outside)).toBe(true);
    // relatedTarget null = 창 블러/비포커서블 클릭 — 메뉴를 남기지 않는다.
    expect(commandBandSwitcherFocusLeft(wrapper, null)).toBe(true);

    wrapper.remove();
    outside.remove();
  });
});

describe("Command Band menu viewport clamp", () => {
  it("keeps the desired left when the menu already fits", () => {
    expect(commandBandMenuClampedLeft(40, 300, 236, 1440)).toBe(40);
  });

  it("pulls an overflowing menu inside the right gutter (sentinel 480px measurements)", () => {
    // Theater 메뉴: wrapper left 292, width 236 → viewport 우측 468(=480-12)에 정렬.
    expect(commandBandMenuClampedLeft(0, 292, 236, 480)).toBe(-60);
    expect(292 + commandBandMenuClampedLeft(0, 292, 236, 480) + 236).toBe(480 - 12);
    // Operation 메뉴: 트리거 offsetLeft 98(viewport 390), width 274 → right 664가 468로 당겨진다.
    expect(292 + commandBandMenuClampedLeft(98, 292, 274, 480) + 274).toBe(480 - 12);
  });

  it("prioritizes the left gutter when the menu is wider than the viewport", () => {
    expect(commandBandMenuClampedLeft(0, 20, 500, 480)).toBe(12 - 20);
  });
});

describe("Command Band center visibility measurements", () => {
  it("uses the floor gutter while map controls are unmeasured or narrower than the floor", () => {
    expect(commandBandCenterGutter(0, 0)).toBe(44);
    expect(commandBandCenterGutter(0, 1)).toBe(44);
  });

  it("derives the gutter from the measured map control width", () => {
    expect(commandBandCenterGutter(0, 163)).toBe(8 + 163 + 12);
    // 사이드바를 접으면 좌측 캡(280px)이 스테이지 원점보다 앞서므로 그만큼 하한이 커진다.
    expect(commandBandCenterGutter(280, 163)).toBe(280 + 8 + 163 + 12);
  });

  it("keeps the center visible while the track is unmeasured", () => {
    expect(commandBandCenterFits(0, 183)).toBe(true);
    expect(commandBandCenterFits(-1, 183)).toBe(true);
  });

  it("requires the two gutters plus the minimum readable center width", () => {
    const gutter = 183;
    expect(commandBandCenterFits(gutter * 2 + 168, gutter)).toBe(true);
    expect(commandBandCenterFits(gutter * 2 + 168 - 1, gutter)).toBe(false);
  });
});

describe("Command Band operation menu ordering", () => {
  const grouped = (id: string, theaterId: string, groupId: string | null): OperationNode => ({
    ...makeOperation(id, theaterId),
    ...(groupId !== null ? { groupId } : {}),
  });
  const makeGroup = (id: string, theaterId: string, order: number): OperationGroup => ({
    id,
    theaterId,
    name: id,
    color: "crimson",
    order,
    createdAt: order,
  });

  it("mirrors the grouped sidebar order, not the flat operationOrder", () => {
    // flat 순서상 g2 소속 op-b가 앞서지만, 사이드바는 그룹 순서(g1 먼저)로 평탄화한다.
    const operations = [grouped("op-b", "t1", "g2"), grouped("op-a", "t1", "g1"), grouped("op-c", "t1", null)];
    const groups = [makeGroup("g1", "t1", 0), makeGroup("g2", "t1", 1)];
    const ids = commandBandTheaterOperations(operations, groups, "t1", ["op-b", "op-a", "op-c"]).map((op) => op.id);
    expect(ids).toEqual(["op-a", "op-b", "op-c"]);
  });

  it("keeps every active-theater operation reachable and excludes other theaters", () => {
    const operations = [grouped("op-a", "t1", "g1"), grouped("op-x", "t2", null)];
    const groups = [makeGroup("g1", "t1", 0), makeGroup("g9", "t2", 0)];
    const ids = commandBandTheaterOperations(operations, groups, "t1", []).map((op) => op.id);
    expect(ids).toEqual(["op-a"]);
  });
});

function makeOperation(id: string, theaterId: string): OperationNode {
  return {
    id,
    theaterId,
    type: "shell",
    pluginId: "terminal",
    title: id,
    payload: {},
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
  };
}
