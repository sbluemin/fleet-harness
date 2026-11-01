import type { GlanceKit, GlancePalette } from "./fleet-at-a-glance.js";
import type { TaskforceIntroCanvasCopy } from "./taskforce-intro-copy.js";

// 승인 시안 v2의 drawTaskforce를 Console로 옮긴 것이다 — 모이기·판단은 '플릿 한눈에 보기'의
// 태스크포스 장면에서 출발하고, 끝에 목표 수립·진행 단계가 더해졌다. 그리는 도구는 glance의
// 키트·팔레트를 공유하고, 여기서는 목표 진행 고리(부분 원호)만 캔버스에 직접 긋는다.
// '플릿 한눈에 보기'의 태스크포스 장면은 바꾸지 않는다.

const INTRO_TAU = Math.PI * 2;
const INTRO_JUDGE = 3;
const INTRO_GOAL = 8;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (x: number): number => 1 - Math.pow(1 - clamp01(x), 3);
const atTime = (t: number, start: number, dur = 0.6): number => easeOut((t - start) / dur);
const ellPoint = (cx: number, cy: number, rx: number, ry: number, ang: number): [number, number] => [
  cx + rx * Math.cos(ang),
  cy + ry * Math.sin(ang),
];

export function drawTaskforceIntro(
  k: GlanceKit,
  c: GlancePalette,
  t: number,
  reduced: boolean,
  L: TaskforceIntroCanvasCopy,
): void {
  k.stars(37, 36, t);
  const cx = 320;
  const cy = 150;
  const home: (readonly [number, number])[] = [
    [90, 74],
    [550, 74],
    [90, 234],
    [550, 234],
  ];
  const names = [L.a, L.b, L.c, L.d];
  const g = atTime(t, 1.2, 1.8);
  const at0 = atTime(t, 1.6, 0.7);
  const goal = reduced ? 1 : atTime(t, INTRO_GOAL, 0.9);
  k.ring(cx, cy, 150, 82, c.hair, g * 0.9, 1, [2, 5], -t * 5);

  // 가운데: 주제 → 목표
  k.orb(cx, cy, 16 * at0, c.flow, at0 * (1 - goal));
  k.orb(cx, cy, 16 * at0, c.result, at0 * goal);
  k.text(L.topic, cx, cy + 32, { a: at0 * (1 - goal) });
  // 목표 라벨은 진행 고리(반지름 26)의 아래쪽과 겹치므로 한참 아래에 둔다.
  k.text(L.goal, cx, cy + 44, { a: goal, color: c.result, weight: 700 });
  if (goal > 0) {
    // 진행 고리: 목표가 선 뒤 차오른다
    const p = reduced ? 0.66 : clamp01((t - INTRO_GOAL - 0.6) / 4.5);
    k.ring(cx, cy, 26, 26, c.hair, goal * 0.8, 1);
    if (p > 0) {
      const ctx = k.ctx;
      ctx.save();
      ctx.globalAlpha = Math.min(1, goal);
      ctx.strokeStyle = c.result;
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(cx, cy, 26, -Math.PI / 2, -Math.PI / 2 + p * INTRO_TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  const pos = home.map(([hx, hy], i) => {
    const self = t * 0.9 + i;
    const sx = hx + 16 * Math.cos(self);
    const sy = hy + 10 * Math.sin(self);
    const ang = -2.4 + (i * INTRO_TAU) / 4 + t * 0.12;
    const [rx, ry] = ellPoint(cx, cy, 150, 82, ang);
    return [sx + (rx - sx) * g, sy + (ry - sy) * g] as [number, number];
  });

  // 판단: 사령관 사이를 오가는 불꽃 — 목표가 서면 가운데로 모인다
  if ((t > INTRO_JUDGE && t < INTRO_GOAL + 0.4) || reduced) {
    const order: (readonly [number, number])[] = [
      [0, 1],
      [1, 3],
      [3, 2],
      [2, 0],
      [0, 3],
      [1, 2],
    ];
    order.forEach(([a, b], n) => {
      const ph = reduced ? (n === 0 ? 0.55 : -1) : ((t - INTRO_JUDGE) / 0.8) % order.length - n;
      if (ph < 0 || ph > 1) return;
      const [ax, ay] = pos[a]!;
      const [bx, by] = pos[b]!;
      const mx = (ax + bx) / 2 + (cx - (ax + bx) / 2) * 0.6;
      const my = (ay + by) / 2 + (cy - (ay + by) / 2) * 0.6;
      const q = (u: number): [number, number] => [
        (1 - u) * (1 - u) * ax + 2 * (1 - u) * u * mx + u * u * bx,
        (1 - u) * (1 - u) * ay + 2 * (1 - u) * u * my + u * u * by,
      ];
      for (let j = 0; j < 8; j += 1) {
        const u = ph - j * 0.025;
        if (u < 0) continue;
        const [x, y] = q(u);
        k.dot(x, y, 3 - j * 0.3, c.flow, 1 - j / 8);
      }
      if (ph > 0.85) k.glow(bx, by, 28, c.flow, ((ph - 0.85) / 0.15) * 2);
    });
  }
  if (!reduced && t > INTRO_GOAL - 0.6 && t < INTRO_GOAL + 0.8) {
    // 네 사령관의 판단이 가운데로 모여 목표가 된다
    const u = clamp01((t - (INTRO_GOAL - 0.6)) / 1.0);
    pos.forEach(([x, y]) => {
      for (let j = 0; j < 6; j += 1) {
        const v = clamp01(u - j * 0.04);
        if (v <= 0) continue;
        k.dot(x + (cx - x) * easeOut(v), y + (cy - y) * easeOut(v), 2.6 - j * 0.3, c.result, (1 - j / 6) * (1 - clamp01((u - 0.85) / 0.15)));
      }
    });
  }
  pos.forEach(([x, y], i) => {
    const a = atTime(t, i * 0.15);
    k.orb(x, y, 9 * a, c.ink, a);
    k.text(names[i] ?? "", x, y + 20, { size: 11, color: c.ink2, a });
  });

  // 단계 이름 — 왼쪽 위에 차례로
  const s1 = reduced ? 1 : atTime(t, 2.2);
  const s2 = reduced ? 1 : atTime(t, INTRO_JUDGE + 0.2);
  const s3 = goal;
  const cur = s3 > 0.5 ? 3 : s2 > 0.5 ? 2 : 1;
  const stepStyle = (n: number, a: number) => ({
    align: "left" as const,
    size: 11.5,
    weight: n === cur ? 700 : 500,
    color: n === cur ? (n === 3 ? c.result : c.ink) : c.ink3,
    a,
  });
  k.text(L.step1, 22, 24, stepStyle(1, s1));
  k.text(L.step2, 22, 44, stepStyle(2, s2));
  k.text(L.step3, 22, 64, stepStyle(3, s3));
  k.tag(L.lab, 590, 22, { size: 10.5, color: c.ink2, a: atTime(t, 0.4) });
}
