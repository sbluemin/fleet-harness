import { describe, expect, it } from "vitest";

import {
  DEFAULT_BIRD_SIZE,
  PERSONAS,
  birdSize,
  clampBirdWidth,
  deckY,
  parkedLayout,
  placeStayPut,
  stayPutFractions,
  stepFlock,
  type BirdBody,
  type BirdPersona,
} from "../client/roaming.js";

const viewport = { width: 800, height: 600 };
const persona = PERSONAS.tori;

function bird(overrides: Partial<BirdBody> = {}): BirdBody {
  return {
    x: 200,
    y: 200,
    vx: 0,
    vy: 0,
    tx: 400,
    ty: 200,
    phase: 0,
    pauseUntil: 0,
    mode: "fly",
    modeUntil: 0,
    deckPlan: false,
    cruise: false,
    grab: null,
    anchored: false,
    moored: false,
    size: DEFAULT_BIRD_SIZE,
    ...overrides,
  };
}

const BIRD_HALF_WIDTH = DEFAULT_BIRD_SIZE.halfWidth;
const BIRD_HALF_HEIGHT = DEFAULT_BIRD_SIZE.halfHeight;

function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? 0;
}

function step(body: BirdBody, random: () => number = () => 0, dt = 0.05, time = 10) {
  return stepFlock([body], [persona], viewport, dt, time, random)[0]!;
}

describe("Scuttlebutt roaming engine", () => {
  it("accelerates toward a waypoint and pauses on arrival", () => {
    const moving = bird();
    step(moving);
    expect(moving.vx).toBeGreaterThan(0);
    expect(moving.vy).toBeCloseTo(0);

    const arriving = bird({ x: 200, y: 200, tx: 200, ty: 200 });
    step(arriving);
    expect(arriving.pauseUntil).toBeCloseTo(11.6);
    expect(arriving.mode).toBe("fly");
  });

  it.each([
    { chance: 0.25, expected: "deck" },
    { chance: 0.26, expected: "preen" },
    { chance: 0.30, expected: "preen" },
    { chance: 0.42, expected: "waypoint" },
    { chance: 0.90, expected: "waypoint" },
  ] as const)("splits pause completion at $chance into $expected", ({ chance, expected }) => {
    const body = bird({ pauseUntil: 1, tx: 250, ty: 250 });
    step(body, sequence(chance, 0.5, 0.5));

    if (expected === "deck") {
      expect(body.deckPlan).toBe(true);
      expect(body.tx).toBeCloseTo(400);
      expect(body.ty).toBeCloseTo(deckY(bird(), viewport));
    } else if (expected === "preen") {
      expect(body.mode).toBe("preen");
      expect(body.modeUntil).toBeCloseTo(13.2);
    } else {
      expect(body.deckPlan).toBe(false);
      expect(body.tx).toBeCloseTo(400);
      expect(body.ty).toBeCloseTo(285);
    }
  });

  it("converges walking birds to the deck and reflects at both walls", () => {
    const left = bird({ x: BIRD_HALF_WIDTH + 13, y: 300, vx: -40, mode: "walk", modeUntil: 20 });
    step(left);
    expect(left.x).toBeCloseTo(BIRD_HALF_WIDTH + 12);
    expect(left.vx).toBeCloseTo(40);
    expect(left.y).toBeCloseTo(300 + (deckY(bird(), viewport) - 300) * 0.4);

    const right = bird({
      x: viewport.width - BIRD_HALF_WIDTH - 13,
      y: deckY(bird(), viewport),
      vx: 40,
      mode: "walk",
      modeUntil: 20,
    });
    step(right);
    expect(right.x).toBeCloseTo(viewport.width - BIRD_HALF_WIDTH - 12);
    expect(right.vx).toBeCloseTo(-40);
  });

  it("separates flying birds only inside the 84-pixel radius", () => {
    const closeLeft = bird({ x: 200, pauseUntil: 20 });
    const closeRight = bird({ x: 250, pauseUntil: 20 });
    stepFlock([closeLeft, closeRight], [persona, persona], viewport, 0.05, 10, () => 0);
    expect(closeLeft.vx).toBeLessThan(0);
    expect(closeRight.vx).toBeGreaterThan(0);

    const farLeft = bird({ x: 200, pauseUntil: 20 });
    const farRight = bird({ x: 284, pauseUntil: 20 });
    stepFlock([farLeft, farRight], [persona, persona], viewport, 0.05, 10, () => 0);
    expect(farLeft.vx).toBeCloseTo(0);
    expect(farRight.vx).toBeCloseTo(0);
  });

  it("uses separate cruise entry and exit thresholds", () => {
    const body = bird({ vx: 61, anchored: true });
    step(body, () => 0, 0);
    expect(body.cruise).toBe(true);

    body.vx = 35;
    step(body, () => 0, 0);
    expect(body.cruise).toBe(true);

    body.vx = 33;
    step(body, () => 0, 0);
    expect(body.cruise).toBe(false);
  });

  it("follows only the pointer while grabbed", () => {
    const grabbed = bird({ x: 200, y: 200, vx: 7, vy: -3, tx: 700, ty: 500, grab: { px: 300, py: 250 } });
    const neighbor = bird({ x: 230, y: 200, pauseUntil: 20 });
    const frame = stepFlock([grabbed, neighbor], [persona, persona], viewport, 0.05, 10, () => 0)[0]!;
    expect(grabbed.x).toBeCloseTo(290);
    expect(grabbed.y).toBeCloseTo(245);
    expect(grabbed.vx).toBeCloseTo(7);
    expect(grabbed.vy).toBeCloseTo(-3);
    expect(frame.flight).toBe("grab");
  });

  it("clamps every coordinate to the bird-safe viewport bounds", () => {
    const high = bird({ x: 400, y: 300, grab: { px: 10_000, py: -10_000 } });
    step(high);
    expect(high.x).toBeCloseTo(viewport.width - BIRD_HALF_WIDTH - 6);
    expect(high.y).toBeCloseTo(BIRD_HALF_HEIGHT + 10);

    const low = bird({ x: 400, y: 300, grab: { px: -10_000, py: 10_000 } });
    step(low);
    expect(low.x).toBeCloseTo(BIRD_HALF_WIDTH + 6);
    expect(low.y).toBeCloseTo(viewport.height - BIRD_HALF_HEIGHT - 2);
  });

  it("damps anchored velocity without waypoint tracking or separation", () => {
    const anchored = bird({ x: 200, y: 200, vx: 100, vy: 20, tx: 700, ty: 500, anchored: true });
    const neighbor = bird({ x: 230, y: 200, anchored: true });
    stepFlock([anchored, neighbor], [persona, persona], viewport, 0.05, 10, () => 0);
    expect(anchored.vx).toBeCloseTo(85);
    expect(anchored.vy).toBeCloseTo(17);
    expect(anchored.x).toBeCloseTo(204.25);
    expect(anchored.y).toBeCloseTo(200.85);
    expect(neighbor.vx).toBeCloseTo(0);
  });

  it.each(["walk", "sleep"] as const)("removes bob and tilt exactly while in %s mode", (mode) => {
    const body = bird({ x: 200, y: deckY(bird(), viewport), vx: 30, vy: 15, phase: 1, mode, modeUntil: 20 });
    const frame = step(body);
    expect(frame.left).toBeCloseTo(body.x - BIRD_HALF_WIDTH);
    expect(frame.top).toBeCloseTo(body.y - BIRD_HALF_HEIGHT);
    expect(frame.tilt).toBeCloseTo(0);
  });

  it("holds a moored bird in place while its behaviour keeps cycling", () => {
    // 이동만 멈춘다 — 걷기·수면·깃단장이 계속 돌아야 애니메이션이 살아 있다.
    const body = bird({ x: 300, y: 250, vx: 120, vy: -90, tx: 700, ty: 500, moored: true, modeUntil: 0 });
    const frame = stepFlock([body], [persona], viewport, 0.1, 5, sequence(0.2, 0.5));

    expect(body.x).toBeCloseTo(300);
    expect(body.y).toBeCloseTo(250);
    expect(body.vx).toBeCloseTo(0);
    expect(body.vy).toBeCloseTo(0);
    expect(body.mode).toBe("walk");
    expect(body.modeUntil).toBeCloseTo(5 + 3 + 0.5 * 3.5);
    expect(frame[0]!.flight).toBe("hover");
    expect(frame[0]!.tilt).toBeCloseTo(0);
  });

  it.each([
    [0.1, "walk"],
    [0.45, "sleep"],
    [0.65, "preen"],
    [0.9, "fly"],
  ] as const)("picks the %s roll as the in-place %s posture", (roll, mode) => {
    const body = bird({ moored: true, modeUntil: 0, mode: "fly" });
    stepFlock([body], [persona], viewport, 0.1, 5, sequence(roll, 0));
    expect(body.mode).toBe(mode);
  });

  it("restores a stay-put fraction onto the current viewport and records it back", () => {
    const body = bird({ x: 10, y: 10, vx: 80, vy: -40 });
    placeStayPut(body, viewport, 0.25, 0.5);
    expect(body.x).toBeCloseTo(200);
    expect(body.y).toBeCloseTo(300);
    expect(body.vx).toBeCloseTo(0);
    expect(body.vy).toBeCloseTo(0);
    expect(stayPutFractions(body, viewport)).toEqual({ nx: 0.25, ny: 0.5 });
  });

  it("keeps a moored bird out of the separation force", () => {
    const moored = bird({ x: 300, y: 250, moored: true, modeUntil: 99 });
    const neighbor = bird({ x: 320, y: 250, tx: 320, ty: 250 });
    stepFlock([moored, neighbor], [persona, persona], viewport, 0.1, 5, sequence(0.9, 0.9));

    expect(moored.x).toBeCloseTo(300);
    expect(moored.vx).toBeCloseTo(0);
    expect(neighbor.vx).not.toBeCloseTo(0);
  });

  it("accepts each persona through the readonly engine contract", () => {
    const personas: readonly BirdPersona[] = [PERSONAS.tori, PERSONAS.bori, PERSONAS.dori];
    expect(personas.map((entry) => entry.max)).toEqual([75, 150, 110]);
  });

  // ── 부관별 크기 ──────────────────────────────────────────────────────────────

  it("derives height and both half-extents from the width alone", () => {
    const size = birdSize(84);
    expect(size.height).toBeCloseTo(96.923, 3);
    // 종전에는 반높이가 47로 못박혀 있어 시각 중심(48.46)과 1.46px 어긋나 있었다.
    expect(size.halfHeight).toBeCloseTo(size.height / 2);
    expect(size.halfWidth).toBeCloseTo(42);
  });

  it("returns a stored width to the contract grid", () => {
    expect(clampBirdWidth(84)).toBe(84);
    expect(clampBirdWidth(4)).toBe(48);
    expect(clampBirdWidth(9_000)).toBe(112);
    expect(clampBirdWidth(63)).toBe(64);
    // 화면을 덮거나 사라진 부관은 설정에 복구 수단이 없으면 되돌릴 길이 없다.
    expect(clampBirdWidth(undefined)).toBe(84);
    expect(clampBirdWidth("84")).toBe(84);
    expect(clampBirdWidth(Number.NaN)).toBe(84);
  });

  it("clamps each bird to the edge its own size allows", () => {
    const small = bird({ x: 5_000, y: 5_000, size: birdSize(48), tx: 5_000, ty: 5_000 });
    const large = bird({ x: 5_000, y: 5_000, size: birdSize(112), tx: 5_000, ty: 5_000 });
    stepFlock([small], [persona], viewport, 0.05, 10, () => 0);
    stepFlock([large], [persona], viewport, 0.05, 10, () => 0);

    expect(small.x).toBeCloseTo(viewport.width - 24 - 6);
    expect(large.x).toBeCloseTo(viewport.width - 56 - 6);
    // 큰 부관이 더 안쪽에서 멈춰야 화면 밖으로 몸이 걸치지 않는다.
    expect(large.x).toBeLessThan(small.x);
  });

  it("stands every walking bird's feet on one deck line whatever its size", () => {
    const small = bird({ size: birdSize(48) });
    const large = bird({ size: birdSize(112) });
    const footLine = (body: BirdBody) => deckY(body, viewport) + body.size.halfHeight;
    expect(footLine(small)).toBeCloseTo(footLine(large));
  });

  it("derives the separation threshold from both bodies, not one", () => {
    // 같은 크기 둘이면 종전의 리터럴 84가 그대로 나온다 — 기존 거동이 보존된다.
    const a = bird({ x: 300, y: 250, tx: 300, ty: 250 });
    const b = bird({ x: 300 + 83, y: 250, tx: 383, ty: 250 });
    stepFlock([a, b], [persona, persona], viewport, 0.1, 5, () => 0.9);
    expect(a.vx).toBeLessThan(0);

    // 작은 둘은 같은 거리에서 서로를 밀지 않는다: 임계가 두 반폭의 합이기 때문이다.
    const smallA = bird({ x: 300, y: 250, tx: 300, ty: 250, size: birdSize(48) });
    const smallB = bird({ x: 383, y: 250, tx: 383, ty: 250, size: birdSize(48) });
    stepFlock([smallA, smallB], [persona, persona], viewport, 0.1, 5, () => 0.9);
    expect(smallA.vx).toBeCloseTo(0);

    // 섞인 쌍은 한쪽 반경이 아니라 두 반폭의 합(80)에서 갈린다.
    const mixedSmall = bird({ x: 300, y: 250, tx: 300, ty: 250, size: birdSize(48) });
    const mixedLarge = bird({ x: 379, y: 250, tx: 379, ty: 250, size: birdSize(112) });
    stepFlock([mixedSmall, mixedLarge], [persona, persona], viewport, 0.1, 5, () => 0.9);
    expect(mixedSmall.vx).toBeLessThan(0);
    expect(mixedLarge.vx).toBeGreaterThan(0);
  });

  it("keeps an oversized bird reachable instead of pinning it outside the viewport", () => {
    const tiny = { width: 60, height: 60 };
    const body = bird({ x: 0, y: 0, size: birdSize(112) });
    stepFlock([body], [persona], tiny, 0.05, 10, () => 0);
    // 화면보다 큰 부관은 하한이 상한을 넘는다 — 그때는 중앙 한 점으로 접어 잡을 수 있게 남긴다.
    expect(body.x).toBeCloseTo(30);
    expect(body.y).toBeCloseTo(30);
    expect(Number.isFinite(body.x)).toBe(true);
  });

  it("restores a stay-put fraction within the bounds the new size allows", () => {
    const large = bird({ size: birdSize(112) });
    placeStayPut(large, viewport, 1, 1);
    // 오른쪽 끝에 저장돼 있었어도 커진 몸이 화면 밖으로 나가지 않는다.
    expect(large.x).toBeCloseTo(viewport.width - 56 - 6);
    expect(large.x + large.size.halfWidth).toBeLessThanOrEqual(viewport.width);
  });

  it("packs mixed-width parked aides on one foot line with an even gap", () => {
    const sizes = [birdSize(112), birdSize(84), birdSize(48)];
    const slots = parkedLayout(sizes, viewport, 8);

    // 간격은 이웃한 두 상자 사이에서 재야 한다 — 보폭 하나로는 폭이 다른 순간 어긋난다.
    const gaps = slots.slice(1).map((slot, index) =>
      slot.left - (slots[index]!.left + sizes[index]!.width));
    expect(gaps.map((gap) => Math.round(gap))).toEqual([8, 8]);

    // 발끝은 크기가 달라도 한 줄에 선다.
    const feet = slots.map((slot, index) => slot.top + sizes[index]!.height);
    expect(feet[0]).toBeCloseTo(feet[1]!);
    expect(feet[1]).toBeCloseTo(feet[2]!);

    // 오른쪽 여백을 지키고 화면 밖으로 나가지 않는다.
    const last = slots.at(-1)!;
    expect(last.left + sizes.at(-1)!.width).toBeCloseTo(viewport.width - 16);
    expect(slots[0]!.left).toBeGreaterThanOrEqual(8);
  });

  it("compresses the parked gap rather than pushing an aide off screen", () => {
    const narrow = { width: 200, height: 600 };
    const sizes = [birdSize(112), birdSize(112), birdSize(112)];
    const slots = parkedLayout(sizes, narrow, 8);

    expect(slots[0]!.left).toBeGreaterThanOrEqual(8);
    expect(slots.at(-1)!.left + 112).toBeLessThanOrEqual(narrow.width - 16 + 0.001);
    // 겹치더라도 화면 안에 남는다 — 밖으로 밀려나면 잡을 수도 되돌릴 수도 없다.
    const gap = slots[1]!.left - (slots[0]!.left + 112);
    expect(gap).toBeLessThan(8);
  });

  it("returns no slots when every aide is off duty", () => {
    expect(parkedLayout([], viewport, 8)).toEqual([]);
  });
});
