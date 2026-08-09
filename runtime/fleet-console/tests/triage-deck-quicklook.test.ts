// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { resolveTriageMapMarkerLayout } from "../core/client/src/canvas/triage-store.js";
import {
  resolveTriageMapQuicklookPlacement,
  resolveTriageMorphFrame,
  resolveTriagePreviewContentHeight,
  resolveTriagePreviewFit,
  resolveTriagePreviewMinScale,
  resolveTriageQuicklookOrigin,
  resolveTriageQuicklookScale,
  TRIAGE_DECK_QUICKLOOK_SCALE,
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

describe("resolveTriagePreviewFit", () => {
  // 에이전트 CLI kind가 선언하는 바닥 크롬(입력 컴포저 + 상태줄) 높이.
  const AGENT_CHROME = 104;

  it("pushes the declared bottom chrome out of frame and lands the output edge on the bottom", () => {
    const fit = resolveTriagePreviewFit({ width: 200, height: 120 }, { width: 800, height: 600 }, AGENT_CHROME)!;
    // 프레임 바닥에 닿는 것은 패널 바닥이 아니라 크롬을 뺀 출력 영역의 바닥이다.
    expect(fit.top + (600 - AGENT_CHROME) * fit.scale).toBeCloseTo(120, 5);
    // 상태줄·컴포저는 프레임 아래로 밀려난다.
    expect(fit.top + 600 * fit.scale).toBeGreaterThan(120);
  });

  it("crops nothing for a body that declares no chrome", () => {
    // 순정 셸·문서형 패널 — 바닥까지 출력이 흐르므로 최신 행이 프레임 안에 남아야 한다.
    const fit = resolveTriagePreviewFit({ width: 200, height: 120 }, { width: 800, height: 600 })!;
    expect(fit.top + 600 * fit.scale).toBeCloseTo(120, 5);
    const explicitZero = resolveTriagePreviewFit({ width: 200, height: 120 }, { width: 800, height: 600 }, 0)!;
    expect(explicitZero).toEqual(fit);
  });

  it("never crops horizontally, whatever the aspect ratio", () => {
    // 왼쪽 정렬 텍스트는 줄의 시작을 잃으면 읽히지 않는다 — 폭은 어떤 종횡비에서도 온전해야 한다.
    for (const viewport of [{ width: 200, height: 120 }, { width: 640, height: 400 }, { width: 300, height: 40 }, { width: 200, height: 200 }, { width: 473, height: 209 }]) {
      const fit = resolveTriagePreviewFit(viewport, { width: 800, height: 600 }, AGENT_CHROME)!;
      expect(fit.left).toBe(0);
      expect(800 * fit.scale).toBeCloseTo(viewport.width, 5);
    }
  });

  it("opens no top strip once the frame carries the output's own aspect", () => {
    // 프레임은 칸을 꽉 채우지 않고 출력의 모양을 입는다(CSS aspect-ratio) — 종전에 상단 빈 띠를
    // 열던 정사각 칸(200×200)에서도 프레임은 200×124로 서고 출력이 프레임을 정확히 채운다.
    const contentHeight = resolveTriagePreviewContentHeight(600, AGENT_CHROME);
    const frameHeight = Math.min(200, 200 * contentHeight / 800);
    expect(frameHeight).toBeCloseTo(124, 10);
    const fit = resolveTriagePreviewFit({ width: 200, height: frameHeight }, { width: 800, height: 600 }, AGENT_CHROME)!;
    expect(fit.scale).toBeCloseTo(0.25, 10);
    expect(fit.left).toBe(0);
    expect(fit.top).toBeCloseTo(0, 10);
    // 크롬은 여전히 프레임 아래로 밀려난다 — 여백을 없앤 대가로 컴포저가 돌아오지는 않는다.
    expect(600 * fit.scale).toBeGreaterThan(frameHeight);
  });

  it("still crops the oldest rows when the output area is taller than the frame", () => {
    const fit = resolveTriagePreviewFit({ width: 400, height: 100 }, { width: 800, height: 600 }, AGENT_CHROME)!;
    expect(fit.top).toBeLessThan(0);
    expect(fit.top + (600 - AGENT_CHROME) * fit.scale).toBeCloseTo(100, 5);
  });

  it("treats a negative or non-finite chrome declaration as zero", () => {
    const baseline = resolveTriagePreviewFit({ width: 200, height: 120 }, { width: 800, height: 600 }, 0)!;
    expect(resolveTriagePreviewFit({ width: 200, height: 120 }, { width: 800, height: 600 }, -40)).toEqual(baseline);
    expect(resolveTriagePreviewFit({ width: 200, height: 120 }, { width: 800, height: 600 }, Number.NaN)).toEqual(baseline);
    expect(resolveTriagePreviewFit({ width: 200, height: 120 }, { width: 800, height: 600 }, Number.POSITIVE_INFINITY)).toEqual(baseline);
  });

  it("caps the chrome band on a minimum-size panel so the output area keeps the frame", () => {
    // 320×200 하한 패널 — 104px를 그대로 빼면 남는 출력이 절반 밑으로 떨어지므로 30%로 제한된다.
    const fit = resolveTriagePreviewFit({ width: 160, height: 100 }, { width: 320, height: 200 }, AGENT_CHROME)!;
    expect(fit.top + (200 - 60) * fit.scale).toBeCloseTo(100, 5);
  });

  it("returns null for a collapsed viewport", () => {
    expect(resolveTriagePreviewFit({ width: 0, height: 120 }, { width: 800, height: 600 }, AGENT_CHROME)).toBeNull();
    expect(resolveTriagePreviewFit({ width: 200, height: 0 }, { width: 800, height: 600 }, AGENT_CHROME)).toBeNull();
  });

  // 프레임의 종횡비와 fit 산술은 같은 출력 높이를 보아야 한다 — 둘이 갈리면 프레임이 출력보다
  // 길거나 짧아져 이 결함이 그대로 돌아온다. 두 소비자가 공유하는 이 함수가 그 접점이다.
  it("shares one output height between the frame's aspect and the fit arithmetic", () => {
    expect(resolveTriagePreviewContentHeight(400, 98)).toBe(302);
    expect(resolveTriagePreviewContentHeight(400, 0)).toBe(400);
    // 선언값 검증과 30% 상한은 이 함수가 소유한다.
    expect(resolveTriagePreviewContentHeight(400, -40)).toBe(400);
    expect(resolveTriagePreviewContentHeight(400, Number.NaN)).toBe(400);
    expect(resolveTriagePreviewContentHeight(400, Number.POSITIVE_INFINITY)).toBe(400);
    expect(resolveTriagePreviewContentHeight(200, 104)).toBe(140);
  });

  // 실측 회귀 — 1440×900 창, 덱 밀도 2.0×에서 Agent 카드가 상단 101.8px(뷰포트의 30.6%)의 빈
  // 띠를 열던 조합이다. 프레임이 출력 종횡비를 입으면 같은 칸에서 프레임은 490×231.21875로 서고
  // 출력이 그 프레임을 정확히 채운다.
  it("closes the worst measured letterbox (1440x900, density 2.0x, agent card)", () => {
    const SLOT = { width: 490, height: 333 };
    const SOURCE = { width: 640, height: 400 };
    const contentHeight = resolveTriagePreviewContentHeight(SOURCE.height, 98);
    expect(contentHeight).toBe(302);
    const frameHeight = Math.min(SLOT.height, SLOT.width * contentHeight / SOURCE.width);
    expect(frameHeight).toBeCloseTo(231.21875, 10);
    const fit = resolveTriagePreviewFit({ width: SLOT.width, height: frameHeight }, SOURCE, 98)!;
    expect(fit.scale).toBeCloseTo(0.765625, 10);
    expect(fit.left).toBe(0);
    expect(fit.top).toBeCloseTo(0, 10);
    // 종전 산술을 같은 칸에 그대로 대입하면 빈 띠가 나온다 — 이 fixture가 지키는 것이 그 차이다.
    const previous = resolveTriagePreviewFit(SLOT, SOURCE, 98)!;
    expect(previous.top).toBeGreaterThan(100);
  });
});

describe("resolveTriagePreviewMinScale", () => {
  it("asks for no floor outside a magnified window", () => {
    // 평상시 카드는 함대를 한눈에 담는 축소판이다 — 확대창이 아니므로 하한도 없다.
    expect(resolveTriagePreviewMinScale(0)).toBe(0);
  });

  it("turns a surface magnification into the floor that cancels it", () => {
    expect(resolveTriagePreviewMinScale(TRIAGE_DECK_QUICKLOOK_SCALE)).toBeCloseTo(1 / 1.95, 10);
    // 지도 확대창은 transform 없이 제 크기로 뜨므로 표면 배율이 1이고, 하한도 그대로 실물 크기다.
    expect(resolveTriagePreviewMinScale(1)).toBe(1);
  });

  it("falls back to no floor for degenerate input", () => {
    expect(resolveTriagePreviewMinScale(-1)).toBe(0);
    expect(resolveTriagePreviewMinScale(Number.NaN)).toBe(0);
    expect(resolveTriagePreviewMinScale(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("resolveTriagePreviewFit — actual-size floor", () => {
  // 실측 기하(1680×1050 창, 덱 줌 1.0): 카드 프리뷰 뷰포트 282×123, 지도 확대창 471×206,
  // 프리뷰 소스 640×400.
  const SOURCE = { width: 640, height: 400 };

  it("lands the card Quick-Look on exactly 1:1 once the card magnification is applied", () => {
    const surface = TRIAGE_DECK_QUICKLOOK_SCALE;
    const fit = resolveTriagePreviewFit(
      { width: 282, height: 123 },
      SOURCE,
      0,
      resolveTriagePreviewMinScale(surface),
    )!;
    expect(surface * fit.scale).toBeCloseTo(1, 10);
  });

  it("lands the map Quick-Look on exactly 1:1", () => {
    const fit = resolveTriagePreviewFit(
      { width: 471, height: 206 },
      SOURCE,
      0,
      resolveTriagePreviewMinScale(1),
    )!;
    expect(fit.scale).toBeCloseTo(1, 10);
  });

  it("still reaches actual size when the grid cap shaved the card scale down to 1", () => {
    // 좁은 창에서 카드가 커지지 못해도 판독이라는 목적은 남는다.
    const fit = resolveTriagePreviewFit({ width: 282, height: 123 }, SOURCE, 0, resolveTriagePreviewMinScale(1))!;
    expect(fit.scale).toBeCloseTo(1, 10);
  });

  it("leaves the unmagnified card on the plain width fit", () => {
    const floored = resolveTriagePreviewFit({ width: 282, height: 123 }, SOURCE, 0, 0)!;
    const plain = resolveTriagePreviewFit({ width: 282, height: 123 }, SOURCE, 0)!;
    expect(floored).toEqual(plain);
    expect(plain.scale).toBeCloseTo(282 / 640, 10);
  });

  it("keeps the frame width even where a taller fit would have magnified further", () => {
    // 왼쪽 정렬 텍스트에서는 줄의 시작을 잃는 쪽이 더 비싸므로 폭(1.51875)이 이긴다. 남는 세로는
    // 이제 프레임 안의 빈 띠가 아니라 프레임 밖이다 — 칸 336px 중 프레임은 303.75px만 쓴다.
    // 실물 크기 하한은 그대로 살아 있다 — 다만 이 뷰포트에서는 폭이 이미 하한을 넘는다.
    const frameHeight = Math.min(336, 486 * resolveTriagePreviewContentHeight(200, 0) / 320);
    expect(frameHeight).toBeCloseTo(303.75, 10);
    const fit = resolveTriagePreviewFit(
      { width: 486, height: frameHeight },
      { width: 320, height: 200 },
      0,
      resolveTriagePreviewMinScale(TRIAGE_DECK_QUICKLOOK_SCALE),
    )!;
    expect(fit.scale).toBeCloseTo(486 / 320, 10);
    expect(fit.left).toBe(0);
    expect(fit.top).toBeCloseTo(0, 10);
  });

  it("keeps the crop anchors under the floor", () => {
    // 이 케이스는 아래 배선 계약과 짝이다 — 산술만 맞고 배선이 끊기면 화면은 여전히 축소판이다.
    const fit = resolveTriagePreviewFit(
      { width: 282, height: 123 },
      SOURCE,
      104,
      resolveTriagePreviewMinScale(TRIAGE_DECK_QUICKLOOK_SCALE),
    )!;
    // 상단에 빈 띠가 열리지 않는다.
    expect(fit.top).toBeLessThanOrEqual(0);
    // 하한이 폭을 넘어 실물이 프레임보다 넓어져도 왼쪽은 앵커된다 — 줄의 시작을 나눠 버리는
    // 중앙 크롭과 달리, 넘치는 폭이 전부 오른쪽으로 나가야 모든 줄을 처음부터 읽을 수 있다.
    expect(fit.left).toBe(0);
    expect(640 * fit.scale).toBeGreaterThan(282);
    // 크롬을 뺀 출력 영역의 바닥은 여전히 프레임 바닥에 닿는다.
    expect(fit.top + (400 - 104) * fit.scale).toBeCloseTo(123, 10);
  });
});

