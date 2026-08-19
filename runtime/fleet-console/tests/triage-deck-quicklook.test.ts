// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { resolveTriageMapMarkerLayout } from "../core/client/src/canvas/triage-store.js";
import {
  resolveTriageMapQuicklookPlacement,
  resolveTriageMorphFrame,
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

// 지도 확대창 배치의 기준 판 — 1200×800.
const GRID = rect(0, 0, 1200, 800);

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

  it("keeps the minimum spacing while the band stays clear", () => {
    // 띠 회피를 마지막에 한 번 스냅하면 그 스냅이 직전 이완이 벌려 둔 간격을 도로 무너뜨린다
    // (띠 아래 절반의 점을 위로 올리면 그 위 이웃과 다시 붙는다). 두 제약은 함께 풀려야 한다.
    // 50개는 이완이 수렴할 시간을 가장 크게 요구하는 규모다 — 정해진 패스가 소진되며 4% 계약이
    // 미달인 채 끝나면 안 된다(줄 나누기와 간격 벌리기가 서로를 되돌리는 구간이 생긴다).
    for (const count of [14, 50]) {
      const ids = Array.from({ length: count }, (unused, index) => `op-${index}`);
      const markers = resolveTriageMapMarkerLayout(ids.map(op), true);
      for (let left = 0; left < markers.length; left += 1) {
        for (let right = left + 1; right < markers.length; right += 1) {
          const a = markers[left]!;
          const b = markers[right]!;
          expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(3.9);
        }
      }
      for (const marker of markers) {
        expect(marker.y > 41 && marker.y < 61 && marker.x > 12 && marker.x < 92).toBe(false);
      }
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
