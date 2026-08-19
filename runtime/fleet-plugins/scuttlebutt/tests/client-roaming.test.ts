import { describe, expect, it } from "vitest";

import {
  BIRD_HALF_HEIGHT,
  BIRD_HALF_WIDTH,
  PERSONAS,
  deckY,
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
    ...overrides,
  };
}

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
      expect(body.ty).toBeCloseTo(deckY(viewport));
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
    expect(left.y).toBeCloseTo(300 + (deckY(viewport) - 300) * 0.4);

    const right = bird({
      x: viewport.width - BIRD_HALF_WIDTH - 13,
      y: deckY(viewport),
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
    const body = bird({ x: 200, y: deckY(viewport), vx: 30, vy: 15, phase: 1, mode, modeUntil: 20 });
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
});
