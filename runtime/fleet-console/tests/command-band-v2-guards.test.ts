// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { commandBandActiveOperation, commandBandMenuClampedLeft, commandBandRenameCommitTarget, commandBandSwitcherFocusLeft } from "../core/client/src/components/command-band-guards.js";
import type { OperationNode } from "../core/client/src/types.js";

describe("Command Band v2 guards", () => {
  it("does not commit a previous Operation draft after another panel becomes active", () => {
    const draft = "previous-operation draft";
    const capturedOperationId = "operation-a";
    const activeOperationId = "operation-b";

    expect(draft).toBe("previous-operation draft");
    expect(commandBandRenameCommitTarget(capturedOperationId, activeOperationId)).toBeNull();
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
