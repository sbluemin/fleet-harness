// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { laneOffset } from "../client/answer-bubble.js";

const GAP = 8;

function bubble(box: { left: number; width: number; height: number } | null): HTMLElement {
  const element = document.createElement("div");
  if (box === null) {
    element.style.visibility = "hidden";
  } else {
    element.style.visibility = "visible";
  }
  element.getBoundingClientRect = () => ({
    left: box?.left ?? 0,
    width: box?.width ?? 0,
    height: box?.height ?? 0,
    top: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}),
  }) as DOMRect;
  return element;
}

/**
 * 감속 모션에서 무리는 한 줄로 정박하고 새 사이는 92px인데 말풍선은 360px까지 벌어진다 —
 * 레인이 없으면 뒤 말풍선이 앞 답을 거의 다 덮는다(실측 268×123px 겹침).
 */
describe("answer bubble lanes", () => {
  it("does not move the first bubble", () => {
    const first = bubble({ left: 1000, width: 360, height: 120 });
    expect(laneOffset(first, [first], 1000, 360, GAP)).toBe(0);
  });

  it("steps a later bubble past every earlier one it actually overlaps", () => {
    const first = bubble({ left: 1000, width: 360, height: 120 });
    const second = bubble({ left: 1092, width: 360, height: 88 });
    const third = bubble({ left: 1100, width: 360, height: 60 });
    const all = [first, second, third];
    expect(laneOffset(second, all, 1092, 360, GAP)).toBe(128);
    // 세 번째는 앞의 둘과 모두 겹치므로 두 레인 바깥에 선다.
    expect(laneOffset(third, all, 1100, 360, GAP)).toBe(128 + 96);
  });

  it("leaves a bubble alone when the earlier one is nowhere near it horizontally", () => {
    const left = bubble({ left: 40, width: 360, height: 120 });
    const right = bubble({ left: 900, width: 360, height: 88 });
    // 화면 반대편 말풍선까지 밀어내면 이유 없이 떠오른다.
    expect(laneOffset(right, [left, right], 900, 360, GAP)).toBe(0);
  });

  it("ignores a sibling that has not been placed yet", () => {
    // 첫 프레임의 형제는 0,0 상자를 돌려주므로 레인 계산에 넣으면 위치가 튄다.
    const unplaced = bubble(null);
    const mine = bubble({ left: 1000, width: 360, height: 88 });
    expect(laneOffset(mine, [unplaced, mine], 1000, 360, GAP)).toBe(0);
  });
});
