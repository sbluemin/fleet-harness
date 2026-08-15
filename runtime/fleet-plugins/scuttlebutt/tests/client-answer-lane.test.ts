// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { laneOffset, type LanePlacement } from "../client/answer-bubble.js";

const GAP = 8;

function bubble(box: { top: number; left: number; width: number; height: number } | null): HTMLElement {
  const element = document.createElement("div");
  element.style.visibility = box === null ? "hidden" : "visible";
  element.getBoundingClientRect = () => ({
    top: box?.top ?? 0,
    bottom: (box?.top ?? 0) + (box?.height ?? 0),
    left: box?.left ?? 0,
    right: (box?.left ?? 0) + (box?.width ?? 0),
    width: box?.width ?? 0,
    height: box?.height ?? 0,
    x: box?.left ?? 0,
    y: box?.top ?? 0,
    toJSON: () => ({}),
  }) as DOMRect;
  return element;
}

function placement(over: Partial<LanePlacement> & Pick<LanePlacement, "bubble" | "siblings">): LanePlacement {
  return {
    left: 1000,
    width: 360,
    height: 100,
    placeAbove: true,
    anchorTop: 700,
    anchorBottom: 784,
    gap: GAP,
    ...over,
  };
}

/**
 * 여러 부관이 동시에 답할 때 말풍선이 서로를 가리지 않아야 한다. 두 배치가 모두 실측으로 나왔다:
 * 감속 모션의 한 줄 정박(새 사이 92px)에서 268×123px, 정상 모션에서 세로 47px 어긋난 두 부관으로
 * 75×77px. 뒤 배치가 높이 합산만으로는 안 되는 이유다.
 */
describe("answer bubble lanes", () => {
  it("does not move the first bubble", () => {
    const first = bubble({ top: 592, left: 1000, width: 360, height: 100 });
    expect(laneOffset(placement({ bubble: first, siblings: [first] }))).toBe(0);
  });

  it("steps past an earlier bubble anchored on the same row", () => {
    // 앞 말풍선은 같은 줄 마스코트 위 lane 0에 서 있다: bottom = 700 - 8, top = 692 - 120.
    const first = bubble({ top: 572, left: 1000, width: 360, height: 120 });
    const mine = bubble({ top: 0, left: 1092, width: 360, height: 100 });
    // 내 아래 변이 앞 말풍선 위 변보다 gap 만큼 위로 물러난다: 700 - 572 = 128.
    expect(laneOffset(placement({ bubble: mine, siblings: [first, mine], left: 1092 }))).toBe(128);
  });

  it("clears an earlier bubble whose mascot sits at a different height", () => {
    // 높이 합산(120+8=128)으로는 47px 어긋난 이 배치에서 다시 겹친다 — 실제 사각형으로 물러나야 한다.
    const first = bubble({ top: 525, left: 1000, width: 360, height: 120 });
    const mine = bubble({ top: 0, left: 1092, width: 360, height: 100 });
    expect(laneOffset(placement({ bubble: mine, siblings: [first, mine], left: 1092, anchorTop: 653 }))).toBe(128);
    // 마스코트가 47px 더 아래면 그만큼 더 물러난다.
    expect(laneOffset(placement({ bubble: mine, siblings: [first, mine], left: 1092, anchorTop: 700 }))).toBe(175);
  });

  it("grows the lane the same way when the bubble opens below its mascot", () => {
    const first = bubble({ top: 800, left: 1000, width: 360, height: 120 });
    const mine = bubble({ top: 0, left: 1092, width: 360, height: 100 });
    expect(laneOffset(placement({
      bubble: mine, siblings: [first, mine], left: 1092, placeAbove: false, anchorBottom: 700,
    }))).toBe(220);
  });

  it("leaves a bubble alone when the earlier one is nowhere near it horizontally", () => {
    // 화면 반대편 말풍선까지 밀어내면 이유 없이 떠오른다.
    const far = bubble({ top: 572, left: 40, width: 360, height: 120 });
    const mine = bubble({ top: 0, left: 900, width: 360, height: 100 });
    expect(laneOffset(placement({ bubble: mine, siblings: [far, mine], left: 900 }))).toBe(0);
  });

  it("leaves a bubble alone when the earlier one clears it vertically already", () => {
    const high = bubble({ top: 100, left: 1000, width: 360, height: 60 });
    const mine = bubble({ top: 0, left: 1000, width: 360, height: 100 });
    expect(laneOffset(placement({ bubble: mine, siblings: [high, mine] }))).toBe(0);
  });

  it("rescans earlier bubbles after a retreat moves it back onto one", () => {
    // 세 부관이 가로로 겹치고 마스코트 높이가 제각각이면, 뒤쪽 형제를 피해 물러난 자리가 앞서
    // 지나쳤던 형제 위로 되돌아간다. 한 번만 훑으면 그 겹침이 매 프레임 그대로 남는다.
    const above = bubble({ top: 100, left: 1000, width: 360, height: 100 });
    const below = bubble({ top: 220, left: 1000, width: 360, height: 100 });
    const mine = bubble({ top: 0, left: 1000, width: 360, height: 100 });
    // 후보는 [250,350]에서 시작한다: anchorTop 358 - gap 8 - lane 0 - height 100.
    const lane = laneOffset(placement({ bubble: mine, siblings: [above, below, mine], anchorTop: 358 }));
    const top = 358 - 8 - lane - 100;
    expect(top + 100).toBeLessThanOrEqual(100);
  });

  it("ignores a sibling that has not been placed yet", () => {
    // 첫 프레임의 형제는 0,0 상자를 돌려주므로 레인 계산에 넣으면 위치가 튄다.
    const unplaced = bubble(null);
    const mine = bubble({ top: 0, left: 1000, width: 360, height: 100 });
    expect(laneOffset(placement({ bubble: mine, siblings: [unplaced, mine] }))).toBe(0);
  });
});
