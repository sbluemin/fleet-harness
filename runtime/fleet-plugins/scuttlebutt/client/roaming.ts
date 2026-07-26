export type BirdMode = "fly" | "walk" | "sleep" | "preen";
export type FlightState = "hover" | "cruise" | "grab";

export interface BirdPersona {
  readonly max: number;
  readonly pause: readonly [number, number];
  readonly amp: number;
  readonly freq: number;
}

export interface BirdBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  phase: number;
  pauseUntil: number;
  mode: BirdMode;
  modeUntil: number;
  deckPlan: boolean;
  cruise: boolean;
  grab: { px: number; py: number } | null;
  anchored: boolean;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** 한 프레임의 렌더 지시 — 호출자는 이 값을 그대로 transform/클래스에 꽂는다. */
export interface BirdFrame {
  readonly left: number;
  readonly top: number;
  readonly tilt: number;
  readonly flight: FlightState;
  readonly mode: BirdMode;
}

export const PERSONAS: Record<"tori" | "bori" | "dori", BirdPersona> = {
  tori: { max: 75, pause: [1.6, 3.4], amp: 7, freq: 1.6 },
  bori: { max: 150, pause: [0.6, 1.6], amp: 5, freq: 2.6 },
  dori: { max: 110, pause: [1.0, 2.4], amp: 6, freq: 2.0 },
};

export const BIRD_HALF_WIDTH = 52;
export const BIRD_HALF_HEIGHT = 58;

export function createBirdBody(index: number, viewport: Viewport, random: () => number): BirdBody {
  const body: BirdBody = {
    x: viewport.width * (0.25 + 0.25 * index),
    y: viewport.height * 0.45,
    vx: 0,
    vy: 0,
    tx: 0,
    ty: 0,
    pauseUntil: 0,
    phase: random() * Math.PI * 2,
    cruise: false,
    grab: null,
    mode: "fly",
    modeUntil: 0,
    deckPlan: false,
    anchored: false,
  };
  pickWaypoint(body, viewport, random);
  return body;
}

export function pickWaypoint(body: BirdBody, viewport: Viewport, random: () => number): void {
  body.deckPlan = false;
  body.tx = rand(70, viewport.width - 70, random);
  body.ty = rand(80, viewport.height - 110, random);
}

export function deckY(viewport: Viewport): number {
  return viewport.height - BIRD_HALF_HEIGHT - 16;
}

export function stepFlock(
  bodies: readonly BirdBody[],
  personas: readonly BirdPersona[],
  viewport: Viewport,
  dt: number,
  time: number,
  random: () => number,
): readonly BirdFrame[] {
  const frames: BirdFrame[] = [];

  for (let index = 0; index < bodies.length; index += 1) {
    const body = bodies[index]!;
    const persona = personas[index]!;

    if (body.grab) {
      // 포인터 좌표를 직접 대입하면 손의 미세 움직임이 지나치게 딱딱해진다.
      body.x += (body.grab.px - body.x) * Math.min(1, dt * 18);
      body.y += (body.grab.py - body.y) * Math.min(1, dt * 18);
    } else if (body.anchored) {
      body.vx *= Math.max(0, 1 - dt * 3);
      body.vy *= Math.max(0, 1 - dt * 3);
      body.x += body.vx * dt;
      body.y += body.vy * dt;
    } else if (body.mode === "walk") {
      body.x += body.vx * dt;
      body.y += (deckY(viewport) - body.y) * Math.min(1, dt * 8);
      if (body.x < BIRD_HALF_WIDTH + 12) {
        body.x = BIRD_HALF_WIDTH + 12;
        body.vx = Math.abs(body.vx);
      }
      if (body.x > viewport.width - BIRD_HALF_WIDTH - 12) {
        body.x = viewport.width - BIRD_HALF_WIDTH - 12;
        body.vx = -Math.abs(body.vx);
      }
      if (time > body.modeUntil) {
        if (random() < 0.3) {
          body.mode = "sleep";
          body.modeUntil = time + rand(3.5, 6, random);
          body.vx = 0;
        } else {
          body.mode = "fly";
          pickWaypoint(body, viewport, random);
        }
      }
    } else if (body.mode === "sleep" || body.mode === "preen") {
      if (time > body.modeUntil) {
        body.mode = "fly";
        pickWaypoint(body, viewport, random);
      }
    } else if (time < body.pauseUntil) {
      body.vx *= Math.max(0, 1 - dt * 3);
      body.vy *= Math.max(0, 1 - dt * 3);
      body.x += body.vx * dt;
      body.y += body.vy * dt;
    } else {
      let preening = false;
      if (body.pauseUntil) {
        body.pauseUntil = 0;
        const next = random();
        if (next < 0.26) {
          body.deckPlan = true;
          body.tx = rand(80, viewport.width - 80, random);
          body.ty = deckY(viewport);
        } else if (next < 0.42) {
          body.mode = "preen";
          body.modeUntil = time + rand(2.4, 4, random);
          preening = true;
        } else {
          pickWaypoint(body, viewport, random);
        }
      }

      // preen 전환 프레임에는 새 목적지를 향한 힘을 섞지 않는다.
      if (!preening) {
        const dx = body.tx - body.x;
        const dy = body.ty - body.y;
        const dist = Math.hypot(dx, dy) || 1;
        const want = Math.min(persona.max, dist * 2.2);
        body.vx += ((dx / dist) * want - body.vx) * Math.min(1, dt * 2.2);
        body.vy += ((dy / dist) * want - body.vy) * Math.min(1, dt * 2.2);
        body.x += body.vx * dt;
        body.y += body.vy * dt;
        if (dist < 26 && Math.hypot(body.vx, body.vy) < 34) {
          if (body.deckPlan) {
            body.mode = "walk";
            body.modeUntil = time + rand(3, 6.5, random);
            body.vx = (random() < 0.5 ? -1 : 1) * rand(22, 40, random);
            body.vy = 0;
          } else {
            body.pauseUntil = time + rand(persona.pause[0], persona.pause[1], random);
          }
        }
      }
    }

    // 지상 행동과 외부 고정 상태에는 비행 편대의 반발력을 섞지 않는다.
    if (!body.grab && body.mode === "fly" && !body.anchored) {
      for (const other of bodies) {
        if (other === body) continue;
        const dx = body.x - other.x;
        const dy = body.y - other.y;
        const distance = Math.hypot(dx, dy);
        if (distance > 1 && distance < 84) {
          const force = (84 - distance) * 96 * dt;
          body.vx += (dx / distance) * force;
          body.vy += (dy / distance) * force;
        }
      }
    }

    body.x = clamp(body.x, BIRD_HALF_WIDTH + 6, viewport.width - BIRD_HALF_WIDTH - 6);
    body.y = clamp(body.y, BIRD_HALF_HEIGHT + 10, viewport.height - BIRD_HALF_HEIGHT - 2);

    const speed = Math.hypot(body.vx, body.vy);
    const flying = body.mode === "fly" && !body.grab;
    if (!body.cruise && flying && speed > 60) {
      body.cruise = true;
    } else if (body.cruise && (!flying || speed < 34)) {
      body.cruise = false;
    }

    const grounded = body.mode === "walk" || body.mode === "sleep";
    const hovering = flying && speed < 34;
    const bob = grounded
      ? 0
      : Math.sin(time * persona.freq + body.phase) * (hovering ? persona.amp : persona.amp * 0.45);
    const tilt = grounded
      ? 0
      : clamp(body.vx * 0.08, -12, 12) + clamp(body.vy * 0.04, -4, 4);

    frames.push({
      left: body.x - BIRD_HALF_WIDTH,
      top: body.y + bob - BIRD_HALF_HEIGHT,
      tilt,
      flight: body.grab ? "grab" : body.cruise ? "cruise" : "hover",
      mode: body.mode,
    });
  }

  return frames;
}

function rand(minimum: number, maximum: number, random: () => number): number {
  return minimum + random() * (maximum - minimum);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
