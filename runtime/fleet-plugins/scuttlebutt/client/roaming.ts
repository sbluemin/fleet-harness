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
  /** 사용자가 제자리에 묶어 둔 상태 — 이동만 멈추고 행동은 계속 돈다. */
  moored: boolean;
  /**
   * 이 부관의 렌더 치수. 크기는 칠하는 값이 아니라 엔진 입력이다 — 화면 경계, 갑판 바닥,
   * 걷기 벽, 편대 반발력, 프레임 원점이 모두 여기서 나온다. CSS `transform: scale()`로
   * 대신하면 DOM 사각형만 커지고 이 계산은 옛 크기에 남아 조용히 어긋난다.
   */
  size: BirdSize;
}

/** 정박 중 제자리 행동 전환 확률의 누적 경계와 지속 시간. */
const MOORED_CYCLE = [
  { mode: "walk", until: 0.35, span: [3, 6.5] },
  { mode: "sleep", until: 0.55, span: [3.5, 6] },
  { mode: "preen", until: 0.75, span: [2.4, 4] },
  { mode: "fly", until: 1, span: [2.5, 5] },
] as const;

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** 부관이 서면 안 되는 화면 영역(열린 페인·Quick Launch·대화상자). 호스트가 실측해 준다. */
export interface KeepOutRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const KEEP_OUT_PADDING = 12;

/** 중심 (x, y)에 선 부관의 상자가 회피 영역과 겹치는가. */
export function insideKeepOut(x: number, y: number, size: BirdSize, keepOut: readonly KeepOutRect[]): boolean {
  for (const rect of keepOut) {
    if (x + size.halfWidth + KEEP_OUT_PADDING <= rect.left) continue;
    if (x - size.halfWidth - KEEP_OUT_PADDING >= rect.left + rect.width) continue;
    if (y + size.halfHeight + KEEP_OUT_PADDING <= rect.top) continue;
    if (y - size.halfHeight - KEEP_OUT_PADDING >= rect.top + rect.height) continue;
    return true;
  }
  return false;
}

/**
 * 회피 영역 안에 선 부관을 가장 가까운 바깥 자리로 옮긴다 — 표면이 부관 위에 열렸을 때 쓴다.
 * 네 방향 중 가장 짧은 이동을 고르고, 화면 밖이면 그다음을 본다. 모두 막히면 제자리다.
 */
export function nearestOutside(
  body: BirdBody,
  viewport: Viewport,
  keepOut: readonly KeepOutRect[],
): { readonly x: number; readonly y: number } | null {
  if (!insideKeepOut(body.x, body.y, body.size, keepOut)) return null;
  const [minX, maxX] = horizontalBounds(body, viewport);
  const [minY, maxY] = verticalBounds(body, viewport);
  const candidates: { x: number; y: number; cost: number }[] = [];
  for (const rect of keepOut) {
    const pad = KEEP_OUT_PADDING + 4;
    const options = [
      { x: rect.left - body.size.halfWidth - pad, y: body.y },
      { x: rect.left + rect.width + body.size.halfWidth + pad, y: body.y },
      { x: body.x, y: rect.top - body.size.halfHeight - pad },
      { x: body.x, y: rect.top + rect.height + body.size.halfHeight + pad },
    ];
    for (const option of options) {
      if (option.x < minX || option.x > maxX || option.y < minY || option.y > maxY) continue;
      if (insideKeepOut(option.x, option.y, body.size, keepOut)) continue;
      candidates.push({ ...option, cost: Math.hypot(option.x - body.x, option.y - body.y) });
    }
  }
  candidates.sort((left, right) => left.cost - right.cost);
  const best = candidates[0];
  return best ? { x: best.x, y: best.y } : null;
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

/**
 * 도형의 종횡비. quaker-figure.tsx 의 viewBox("0 0 260 300")가 원본이고, 버튼의 svg는
 * `width: 100%; height: auto`라 폭 하나가 높이를 정한다.
 */
export const BIRD_ASPECT = 300 / 260;

/** 사용자가 고르는 폭의 계약. 48은 실측 정체성 하한, 84는 종전 고정값이다. */
export const DEFAULT_BIRD_WIDTH = 84;
export const MIN_BIRD_WIDTH = 48;
export const MAX_BIRD_WIDTH = 112;
export const BIRD_WIDTH_STEP = 4;

export interface BirdSize {
  readonly width: number;
  readonly height: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/**
 * 폭에서 한 부관의 치수 일습을 만든다. 높이와 반치수를 폭에서 파생시키는 것이 요점 —
 * 종전에는 높이 97과 반높이 47이 각각 상수라 실제 렌더 높이(96.92)와 1.46px 어긋나 있었고,
 * 그래서 시각 중심과 물리 앵커가 서로 다른 자리를 가리켰다.
 */
export function birdSize(width: number): BirdSize {
  const height = width * BIRD_ASPECT;
  return { width, height, halfWidth: width / 2, halfHeight: height / 2 };
}

/** 저장값·입력값을 계약 범위의 격자 위로 되돌린다. 범위를 벗어난 값은 복구 불가 상태를 만든다. */
export function clampBirdWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_BIRD_WIDTH;
  const stepped = Math.round(value / BIRD_WIDTH_STEP) * BIRD_WIDTH_STEP;
  return Math.max(MIN_BIRD_WIDTH, Math.min(MAX_BIRD_WIDTH, stepped));
}

export const DEFAULT_BIRD_SIZE: BirdSize = birdSize(DEFAULT_BIRD_WIDTH);

export function createBirdBody(
  index: number,
  viewport: Viewport,
  random: () => number,
  width: number = DEFAULT_BIRD_WIDTH,
): BirdBody {
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
    moored: false,
    size: birdSize(clampBirdWidth(width)),
  };
  pickWaypoint(body, viewport, random);
  return body;
}

/**
 * 정박 중에는 웨이포인트에 도착할 일이 없어 행동 전환이 영영 오지 않는다 — 날갯짓만 남고
 * 걷기·수면·깃단장이 사라진다. 그래서 이동 대신 시간으로 다음 자세를 고른다.
 */
function stepMooredBehavior(body: BirdBody, time: number, random: () => number): void {
  body.vx = 0;
  body.vy = 0;
  body.cruise = false;
  if (time <= body.modeUntil) return;
  const roll = random();
  const picked = MOORED_CYCLE.find((entry) => roll < entry.until) ?? MOORED_CYCLE.at(-1)!;
  body.mode = picked.mode;
  body.modeUntil = time + rand(picked.span[0], picked.span[1], random);
}

/** 저장된 화면비 좌표가 현재 뷰포트에서 가리키는 중심점. */
export function stayPutPoint(body: BirdBody, viewport: Viewport, nx: number, ny: number): { readonly x: number; readonly y: number } {
  return {
    x: clamp(nx * viewport.width, ...horizontalBounds(body, viewport)),
    y: clamp(ny * viewport.height, ...verticalBounds(body, viewport)),
  };
}

/** 저장된 화면비 좌표를 현재 뷰포트에 다시 얹는다 — 창 크기가 바뀌어도 같은 자리에 가깝게 선다. */
export function placeStayPut(body: BirdBody, viewport: Viewport, nx: number, ny: number): void {
  const point = stayPutPoint(body, viewport, nx, ny);
  body.x = point.x;
  body.y = point.y;
  body.vx = 0;
  body.vy = 0;
}

/**
 * 화면 안에 머무를 수 있는 중심 좌표의 범위. 크기가 부관마다 다르므로 전역 상수 하나로는
 * 답이 나오지 않는다 — 큰 부관은 가장자리를 넘고 작은 부관은 닿지 못한다.
 * 화면보다 큰 부관이면 하한이 상한을 넘으므로, 그때는 화면 중앙 한 점으로 접는다.
 */
function horizontalBounds(body: BirdBody, viewport: Viewport): [number, number] {
  const low = body.size.halfWidth + 6;
  const high = viewport.width - body.size.halfWidth - 6;
  return low > high ? [viewport.width / 2, viewport.width / 2] : [low, high];
}

function verticalBounds(body: BirdBody, viewport: Viewport): [number, number] {
  const low = body.size.halfHeight + 10;
  const high = viewport.height - body.size.halfHeight - 2;
  return low > high ? [viewport.height / 2, viewport.height / 2] : [low, high];
}

export function stayPutFractions(body: BirdBody, viewport: Viewport): { nx: number; ny: number } {
  const nx = viewport.width > 0 ? body.x / viewport.width : 0.5;
  const ny = viewport.height > 0 ? body.y / viewport.height : 0.5;
  return {
    nx: clamp(nx, 0, 1),
    ny: clamp(ny, 0, 1),
  };
}

/**
 * 다음 목적지. 여백은 부관이 실제로 도달할 수 있는 범위 안으로 좁힌다 — 종전의 고정 여백
 * (70/80/110)은 84px 한 크기를 전제한 값이라, 더 큰 부관에게는 clamp 밖의 목표를 주어
 * 도착 판정(dist < 26)이 영영 오지 않는 가장자리 배회를 만든다.
 */
export function pickWaypoint(
  body: BirdBody,
  viewport: Viewport,
  random: () => number,
  keepOut: readonly KeepOutRect[] = [],
): void {
  const [minX, maxX] = horizontalBounds(body, viewport);
  const [minY, maxY] = verticalBounds(body, viewport);
  body.deckPlan = false;
  // 회피 영역 밖의 목적지를 몇 번 더 뽑는다. 다 막혀 있으면 마지막 후보로 간다 — 서 있을 곳이
  // 없는 화면에서 영영 고르지 못하는 것보다 낫다.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    body.tx = randWithin(Math.max(70, minX), Math.min(viewport.width - 70, maxX), minX, maxX, random);
    body.ty = randWithin(Math.max(80, minY), Math.min(viewport.height - 110, maxY), minY, maxY, random);
    if (!insideKeepOut(body.tx, body.ty, body.size, keepOut)) return;
  }
}

/**
 * 선호 여백 안에서 고르되, 그 여백이 도달 가능 범위를 넘어 뒤집히면 범위 자체로 물러난다.
 * 뒤집힌 채로 rand에 넘기면 목표가 범위 밖으로 나가 도착 판정이 오지 않는다.
 */
function randWithin(
  preferredLow: number,
  preferredHigh: number,
  reachableLow: number,
  reachableHigh: number,
  random: () => number,
): number {
  if (preferredLow <= preferredHigh) return rand(preferredLow, preferredHigh, random);
  return rand(reachableLow, reachableHigh, random);
}

export function deckY(body: BirdBody, viewport: Viewport): number {
  return viewport.height - body.size.halfHeight - 16;
}

/**
 * 모션을 줄인 화면에서 부관들을 아래쪽에 나란히 세울 자리. 폭이 부관마다 다르므로 보폭을
 * 스칼라 하나로 셀 수 없다 — 각자의 폭을 누적해 오른쪽부터 채운다. 전역 폭 하나로 보폭을 잡으면
 * 큰 부관은 이웃을 파고들고 작은 부관은 구멍을 남긴다.
 *
 * 좁은 창에서는 간격을 음수까지 좁혀서라도 켜진 부관을 모두 화면 안에 남긴다 — 겹치더라도
 * 화면 밖으로 밀려나 잡을 수 없게 되는 편보다 낫다.
 */
export function parkedLayout(
  sizes: readonly BirdSize[],
  viewport: Viewport,
  gap: number,
  keepOut: readonly KeepOutRect[] = [],
): readonly { readonly left: number; readonly top: number }[] {
  if (sizes.length === 0) return [];
  const totalWidth = sizes.reduce((sum, size) => sum + size.width, 0);
  const available = Math.max(0, viewport.width - 16 - 8);
  const spacing = sizes.length > 1
    ? Math.min(gap, (available - totalWidth) / (sizes.length - 1))
    : 0;
  const runWidth = totalWidth + spacing * (sizes.length - 1);
  const tallest = Math.max(...sizes.map((size) => size.height));
  // 주차 줄은 오른쪽 아래가 기본이다. 그 자리를 덮는 표면(도킹된 Quick Launch·오른쪽 페인)이
  // 있으면 줄 전체를 그 위 또는 왼쪽으로 옮긴다 — 부관 하나만 옮기면 줄이 깨진다.
  let right = viewport.width - 16;
  let bottom = viewport.height - 16;
  for (let pass = 0; pass < 4; pass += 1) {
    const blocking = keepOut.find((rect) =>
      right - runWidth < rect.left + rect.width && right > rect.left
      && bottom - tallest < rect.top + rect.height && bottom > rect.top);
    if (!blocking) break;
    const liftTo = blocking.top - KEEP_OUT_PADDING;
    const shiftTo = blocking.left - KEEP_OUT_PADDING;
    // 위로 올리는 편이 짧으면 올리고, 아니면 왼쪽으로 민다. 둘 다 화면 밖이면 그대로 둔다.
    if (bottom - liftTo <= right - shiftTo && liftTo - tallest >= 8) bottom = liftTo;
    else if (shiftTo - runWidth >= 8) right = shiftTo;
    else break;
  }
  let cursor = Math.max(8, right - runWidth);
  return sizes.map((size) => {
    const left = cursor;
    cursor += size.width + spacing;
    // 바닥은 부관마다 자기 높이로 잰다 — 그래야 크기가 달라도 발끝이 한 줄로 선다.
    return { left, top: Math.max(8, bottom - size.height) };
  });
}

export function stepFlock(
  bodies: readonly BirdBody[],
  personas: readonly BirdPersona[],
  viewport: Viewport,
  dt: number,
  time: number,
  random: () => number,
  keepOut: readonly KeepOutRect[] = [],
): readonly BirdFrame[] {
  const frames: BirdFrame[] = [];

  for (let index = 0; index < bodies.length; index += 1) {
    const body = bodies[index]!;
    const persona = personas[index]!;

    // 표면이 부관 위에 열렸다 — 잡혀 있지 않은 부관은 가장 가까운 바깥으로 비켜선다. 정박·고정도
    // 예외가 아니다: 사용자가 세워 둔 자리라도 그 위에 설정 스위치가 열리면 스위치가 우선이다.
    // 비켜선 뒤 표면이 닫히면 정박 부관은 저장된 자리로 돌아간다(flock이 placeStayPut으로 되돌린다).
    if (!body.grab && keepOut.length > 0) {
      const outside = nearestOutside(body, viewport, keepOut);
      if (outside) {
        const dx = outside.x - body.x;
        const dy = outside.y - body.y;
        const dist = Math.hypot(dx, dy) || 1;
        const step = Math.min(dist, Math.max(persona.max, 160) * dt);
        body.x += (dx / dist) * step;
        body.y += (dy / dist) * step;
        body.vx = (dx / dist) * Math.min(dist * 2, 160);
        body.vy = (dy / dist) * Math.min(dist * 2, 160);
        if (body.mode !== "fly") {
          body.mode = "fly";
          body.modeUntil = 0;
        }
        if (!body.moored && !body.anchored) {
          body.tx = outside.x;
          body.ty = outside.y;
          body.pauseUntil = 0;
        }
        frames.push({
          left: body.x - body.size.halfWidth,
          top: body.y - body.size.halfHeight,
          tilt: clamp(body.vx * 0.08, -12, 12),
          flight: "cruise",
          mode: "fly",
        });
        continue;
      }
    }

    if (body.grab) {
      // 포인터 좌표를 직접 대입하면 손의 미세 움직임이 지나치게 딱딱해진다.
      body.x += (body.grab.px - body.x) * Math.min(1, dt * 18);
      body.y += (body.grab.py - body.y) * Math.min(1, dt * 18);
    } else if (body.moored) {
      stepMooredBehavior(body, time, random);
    } else if (body.anchored) {
      body.vx *= Math.max(0, 1 - dt * 3);
      body.vy *= Math.max(0, 1 - dt * 3);
      body.x += body.vx * dt;
      body.y += body.vy * dt;
    } else if (body.mode === "walk") {
      body.x += body.vx * dt;
      body.y += (deckY(body, viewport) - body.y) * Math.min(1, dt * 8);
      if (body.x < body.size.halfWidth + 12) {
        body.x = body.size.halfWidth + 12;
        body.vx = Math.abs(body.vx);
      }
      if (body.x > viewport.width - body.size.halfWidth - 12) {
        body.x = viewport.width - body.size.halfWidth - 12;
        body.vx = -Math.abs(body.vx);
      }
      if (time > body.modeUntil) {
        if (random() < 0.3) {
          body.mode = "sleep";
          body.modeUntil = time + rand(3.5, 6, random);
          body.vx = 0;
        } else {
          body.mode = "fly";
          pickWaypoint(body, viewport, random, keepOut);
        }
      }
    } else if (body.mode === "sleep" || body.mode === "preen") {
      if (time > body.modeUntil) {
        body.mode = "fly";
        pickWaypoint(body, viewport, random, keepOut);
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
        if (next < 0.26 && !insideKeepOut(body.x, deckY(body, viewport), body.size, keepOut)) {
          body.deckPlan = true;
          body.tx = rand(80, viewport.width - 80, random);
          body.ty = deckY(body, viewport);
        } else if (next < 0.42) {
          body.mode = "preen";
          body.modeUntil = time + rand(2.4, 4, random);
          preening = true;
        } else {
          pickWaypoint(body, viewport, random, keepOut);
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

    // 지상 행동과 고정 상태에는 비행 편대의 반발력을 섞지 않는다 — 묶어 둔 새가 떠밀리면 안 된다.
    if (!body.grab && body.mode === "fly" && !body.anchored && !body.moored) {
      for (const other of bodies) {
        if (other === body) continue;
        const dx = body.x - other.x;
        const dy = body.y - other.y;
        const distance = Math.hypot(dx, dy);
        // 임계는 두 몸체에서 나온다 — 어느 한쪽의 반경도 쌍(pair)의 답이 아니다. 자기 크기만
        // 쓰면 큰 부관은 작은 부관을 파고들고 작은 부관은 멀찍이서 밀려나 반응이 어긋난다.
        // 같은 크기 둘이면 halfWidth 합이 곧 종전의 84라 기존 거동이 그대로 보존된다.
        const threshold = body.size.halfWidth + other.size.halfWidth;
        if (distance > 1 && distance < threshold) {
          const force = (threshold - distance) * 96 * dt;
          body.vx += (dx / distance) * force;
          body.vy += (dy / distance) * force;
        }
      }
    }

    body.x = clamp(body.x, ...horizontalBounds(body, viewport));
    body.y = clamp(body.y, ...verticalBounds(body, viewport));

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
      left: body.x - body.size.halfWidth,
      top: body.y + bob - body.size.halfHeight,
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
