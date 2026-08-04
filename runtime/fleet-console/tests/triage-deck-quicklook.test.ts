// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { resolveTriageMapMarkerLayout } from "../core/client/src/canvas/triage-store.js";
import {
  resolveTriageMapQuicklookPlacement,
  resolveTriageMorphFrame,
  resolveTriageQuicklookOrigin,
  resolveTriageQuicklookScale,
  TRIAGE_MAP_QUICKLOOK_HEIGHT,
  TRIAGE_MAP_QUICKLOOK_WIDTH,
} from "../core/client/src/canvas/triage-watch-deck.js";

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

describe("resolveTriageQuicklookScale", () => {
  it("keeps the full 1.95 scale when the grid can absorb the growth", () => {
    expect(resolveTriageQuicklookScale(rect(500, 350, 200, 100), GRID)).toBe(1.95);
  });

  it("caps to 1 when a single-column card already fills the grid width", () => {
    // 단일 컬럼 deck — 카드 폭 == grid 폭이면 어떤 확대도 overflow에 잘리므로 확대하지 않는다.
    expect(resolveTriageQuicklookScale(rect(0, 100, 1200, 210), GRID)).toBe(1);
  });

  it("caps to the width ratio when the card is wider than the height allows", () => {
    // grid 800×800에 카드 500×100 — 폭 기준 1.6이 1.95보다 먼저 바닥난다.
    expect(resolveTriageQuicklookScale(rect(0, 0, 500, 100), rect(0, 0, 800, 800))).toBe(1.6);
  });

  it("caps to the height ratio on short grids", () => {
    // grid 높이 300에 카드 높이 210 — 300/210 ≈ 1.4286이 상한이 된다.
    expect(resolveTriageQuicklookScale(rect(0, 0, 300, 210), rect(0, 0, 1200, 300)))
      .toBeCloseTo(300 / 210, 5);
  });

  it("never scales below 1 even when the card overflows the grid", () => {
    expect(resolveTriageQuicklookScale(rect(0, 0, 1400, 900), GRID)).toBe(1);
  });

  it("returns 1 for a degenerate zero-size card", () => {
    expect(resolveTriageQuicklookScale(rect(0, 0, 0, 0), GRID)).toBe(1);
  });
});

describe("resolveTriageMapQuicklookPlacement", () => {
  const dot = (left: number, top: number) => rect(left, top, 14, 14);

  it("anchors the panel just past the dot when the plate has room", () => {
    const placement = resolveTriageMapQuicklookPlacement(dot(600, 400), GRID);
    expect(placement.width).toBe(TRIAGE_MAP_QUICKLOOK_WIDTH);
    expect(placement.height).toBe(TRIAGE_MAP_QUICKLOOK_HEIGHT);
    // 점의 오른쪽 아래에 14px 간격으로 붙는다 — 창 모서리가 포인터 바로 옆에 선다.
    expect(placement.left).toBe(600 + 14 + 14);
    expect(placement.top).toBe(400 + 14 + 14);
  });

  it("flips to the other side of the dot instead of drifting away from it", () => {
    const far = resolveTriageMapQuicklookPlacement(dot(1186, 786), GRID);
    // 오른쪽·아래가 좁으면 점의 왼쪽 위로 뒤집는다. 경계로 밀어내지 않으므로 창은 점에 붙어 있다.
    expect(far.left).toBe(1186 - 14 - TRIAGE_MAP_QUICKLOOK_WIDTH);
    expect(far.top).toBe(786 - 14 - TRIAGE_MAP_QUICKLOOK_HEIGHT);
    expect(far.left + TRIAGE_MAP_QUICKLOOK_WIDTH).toBeLessThanOrEqual(1186);
  });

  it("keeps the panel inside the plate when neither side can hold it", () => {
    // 세로로 짧은 판 — 위아래 어느 쪽도 293을 담지 못하므로 점 중앙 기준으로 경계 안에 넣는다.
    const placement = resolveTriageMapQuicklookPlacement(dot(600, 160), rect(0, 0, 1200, 340));
    expect(placement.top).toBeGreaterThanOrEqual(8);
    expect(placement.top + placement.height).toBeLessThanOrEqual(340 - 8 + 1e-6);
  });

  it("shrinks to the plate on windows narrower than the reading size", () => {
    const placement = resolveTriageMapQuicklookPlacement(dot(100, 60), rect(0, 0, 320, 200));
    expect(placement.width).toBe(320 - 16);
    expect(placement.height).toBe(200 - 16);
    expect(placement.left).toBe(8);
    expect(placement.top).toBe(8);
  });
});

describe("triage map label band", () => {
  const op = (id: string) => ({ id, geometry: null });

  it("keeps markers out of the centered Theater marker band when zones are split", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const zoned = resolveTriageMapMarkerLayout(ids.map(op), true);
    for (const marker of zoned) {
      const insideBand = marker.y > 41 && marker.y < 61 && marker.x > 12 && marker.x < 92;
      expect(insideBand).toBe(false);
    }
  });

  it("leaves the band open for a single fleet that has no centered marker", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const plane = resolveTriageMapMarkerLayout(ids.map(op));
    const zoned = resolveTriageMapMarkerLayout(ids.map(op), true);
    // 같은 입력이라도 표석이 없는 판은 중앙을 비우지 않는다 — 두 배치는 달라야 한다.
    expect(plane).not.toEqual(zoned);
  });
});

describe("resolveTriageMorphFrame", () => {
  it("moves the card onto its dot and shrinks it evenly", () => {
    // 260×150 카드가 (100,100)에, 그 점은 (600,400)에 14×14로 선다.
    const frame = resolveTriageMorphFrame(rect(100, 100, 260, 150), rect(600, 400, 14, 14));
    expect(frame.dx).toBeCloseTo(607 - 230, 5);
    expect(frame.dy).toBeCloseTo(407 - 175, 5);
    // 균등 배율 — 축별로 다르면 카드가 찌그러지며 빨려 들어간다.
    expect(frame.scale).toBeCloseTo(14 / 260, 5);
  });

  it("survives a degenerate zero-size card without dividing by zero", () => {
    const frame = resolveTriageMorphFrame(rect(0, 0, 0, 0), rect(10, 10, 14, 14));
    expect(Number.isFinite(frame.scale)).toBe(true);
    expect(Number.isFinite(frame.dx)).toBe(true);
  });
});
