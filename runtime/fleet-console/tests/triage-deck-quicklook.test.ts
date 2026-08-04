// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { resolveTriageQuicklookOrigin } from "../core/client/src/canvas/triage-watch-deck.js";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

// 1200×800 grid 안의 200×100 카드 — Quick-Look scale 1.95 기준 절반 증가폭은 가로 95, 세로 47.5.
const GRID = rect(0, 0, 1200, 800);

describe("resolveTriageQuicklookOrigin", () => {
  it("returns 'center center' for a card with room on every side", () => {
    expect(resolveTriageQuicklookOrigin(rect(500, 350, 200, 100), GRID)).toBe("center center");
  });

  it("clamps to 'left' when the card hugs the grid's left edge", () => {
    expect(resolveTriageQuicklookOrigin(rect(10, 350, 200, 100), GRID)).toBe("left center");
  });

  it("clamps to 'right' when the card hugs the grid's right edge", () => {
    expect(resolveTriageQuicklookOrigin(rect(990, 350, 200, 100), GRID)).toBe("right center");
  });

  it("clamps to 'top' when the card hugs the grid's top edge", () => {
    expect(resolveTriageQuicklookOrigin(rect(500, 10, 200, 100), GRID)).toBe("center top");
  });

  it("clamps to 'bottom' when the card hugs the grid's bottom edge", () => {
    expect(resolveTriageQuicklookOrigin(rect(500, 690, 200, 100), GRID)).toBe("center bottom");
  });

  it("clamps both axes for a corner card", () => {
    expect(resolveTriageQuicklookOrigin(rect(0, 780, 200, 20), GRID)).toBe("left bottom");
  });

  it("keeps center when the remaining gap exactly fits the half-growth", () => {
    // 좌측 여백이 정확히 95(scale 1.95 기준 절반 증가폭)이면 경계를 넘지 않으므로 center.
    expect(resolveTriageQuicklookOrigin(rect(95, 47.5, 200, 100), GRID)).toBe("center center");
  });
});
