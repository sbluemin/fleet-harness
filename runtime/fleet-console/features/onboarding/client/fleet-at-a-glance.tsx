import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ConsoleLocale } from "@fleet-console/i18n";

import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { useConsoleState } from "../../../core/client/src/hooks/use-store.js";
import {
  closeFleetAtAGlance,
  COMMISSIONING_SEEN_KEY,
  openFleetAtAGlance,
  readStoredCommissioningSeen,
} from "../../../core/client/src/integration/store.js";
import { useViewMode } from "../../../core/client/src/integration/view-mode-store.js";
import { useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
import { readCommodoreList } from "../../commodore/client/commodore-list.js";
import { FLEET_AT_A_GLANCE_SEEN_KEY, rememberSeen } from "./seen-store.js";
import {
  fleetGlanceChrome,
  fleetGlanceScenes,
  fleetGlanceSummary,
  type FleetGlanceSceneCopy,
} from "./fleet-at-a-glance-copy.js";
import "./fleet-at-a-glance.css";

// 도움말 › 플릿 한눈에 보기 — 승인 시안의 모션 팝업을 Console로 옮긴 것이다.
// 색은 Console 테마 토큰(flow→--aurora, result→--positive,
// loop→--apex, 사람→--glance-person)에서 읽고, 테마가 바뀌면 다음 프레임에 다시 읽는다.

const GLANCE_WIDTH = 640;
const GLANCE_HEIGHT = 300;
const GLANCE_TAU = Math.PI * 2;
const GLANCE_AUTO_ADVANCE_MS = 9_000;
const GLANCE_MODAL_ATTRIBUTE = "data-fleet-glance-open";

const GLANCE_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

// 태스크포스 소개 카드가 같은 무대 문법을 쓴다 — 복제하지 않고 이 키트·팔레트를 공유한다.
export interface GlancePalette {
  readonly ink: string;
  readonly ink2: string;
  readonly ink3: string;
  readonly hair: string;
  readonly face: string;
  readonly flow: string;
  readonly result: string;
  readonly loop: string;
  readonly warm: string;
  readonly font: string;
}

interface GlanceTextStyle {
  readonly color?: string;
  readonly size?: number;
  readonly weight?: number;
  readonly align?: CanvasTextAlign;
  readonly a?: number;
}

interface GlanceTagStyle {
  readonly color?: string;
  readonly size?: number;
  readonly weight?: number;
  readonly a?: number;
  readonly line?: string;
}

export interface GlanceKit {
  readonly ctx: CanvasRenderingContext2D;
  glow(x: number, y: number, r: number, color: string, a?: number): void;
  dot(x: number, y: number, r: number, color: string, a?: number): void;
  orb(x: number, y: number, r: number, color: string, a?: number): void;
  ring(x: number, y: number, rx: number, ry: number, color: string, a?: number, w?: number, dash?: readonly number[], off?: number): void;
  line(pts: readonly (readonly [number, number])[], color: string, a?: number, w?: number, dash?: readonly number[]): void;
  text(s: string, x: number, y: number, style?: GlanceTextStyle): void;
  tag(s: string, x: number, y: number, style?: GlanceTagStyle): void;
  stars(seed: number, n: number, t: number, a?: number): void;
}

type GlanceLabels = Readonly<Record<string, string>>;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (x: number): number => 1 - Math.pow(1 - clamp01(x), 3);
const atTime = (t: number, start: number, dur = 0.6): number => easeOut((t - start) / dur);
const rng32 = (seed: number): (() => number) => {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
};
const ellPoint = (cx: number, cy: number, rx: number, ry: number, ang: number): [number, number] => [
  cx + rx * Math.cos(ang),
  cy + ry * Math.sin(ang),
];

export function readGlancePalette(): GlancePalette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string): string => cs.getPropertyValue(name).trim();
  return {
    ink: v("--text-primary"),
    ink2: v("--text-secondary"),
    ink3: v("--text-tertiary"),
    hair: v("--hairline-strong"),
    face: v("--dialog-face"),
    flow: v("--aurora"),
    result: v("--positive"),
    loop: v("--apex"),
    warm: v("--glance-person"),
    font: v("--font-ui"),
  };
}

export function makeGlanceKit(ctx: CanvasRenderingContext2D, c: GlancePalette): GlanceKit {
  const W = GLANCE_WIDTH;
  const H = GLANCE_HEIGHT;
  return {
    ctx,
    glow(x, y, r, color, a = 1) {
      if (a <= 0) return;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, color);
      g.addColorStop(1, "transparent");
      ctx.save();
      ctx.globalAlpha = Math.min(1, a) * 0.3;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, GLANCE_TAU);
      ctx.fill();
      ctx.restore();
    },
    dot(x, y, r, color, a = 1) {
      if (a <= 0 || r <= 0) return;
      ctx.save();
      ctx.globalAlpha = Math.min(1, a);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, GLANCE_TAU);
      ctx.fill();
      ctx.restore();
    },
    orb(x, y, r, color, a = 1) {
      if (a <= 0) return;
      this.glow(x, y, r * 3.2, color, a);
      this.dot(x, y, r, color, a);
    },
    ring(x, y, rx, ry, color, a = 1, w = 1, dash?: readonly number[], off = 0) {
      if (a <= 0) return;
      ctx.save();
      ctx.globalAlpha = Math.min(1, a);
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      if (dash) {
        ctx.setLineDash([...dash]);
        ctx.lineDashOffset = off;
      }
      ctx.beginPath();
      ctx.ellipse(x, y, Math.max(rx, 0.1), Math.max(ry, 0.1), 0, 0, GLANCE_TAU);
      ctx.stroke();
      ctx.restore();
    },
    line(pts, color, a = 1, w = 1, dash?: readonly number[]) {
      if (a <= 0) return;
      ctx.save();
      ctx.globalAlpha = Math.min(1, a);
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.lineCap = "round";
      if (dash) ctx.setLineDash([...dash]);
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.restore();
    },
    text(s, x, y, style = {}) {
      const { color = c.ink, size = 12, weight = 600, align = "center", a = 1 } = style;
      if (a <= 0) return;
      ctx.save();
      ctx.globalAlpha = Math.min(1, a);
      ctx.fillStyle = color;
      ctx.font = `${weight} ${size}px ${c.font}`;
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      ctx.fillText(s, x, y);
      ctx.restore();
    },
    tag(s, x, y, style = {}) {
      const { color = c.ink, size = 11.5, weight = 600, a = 1, line = c.hair } = style;
      if (a <= 0) return;
      ctx.save();
      ctx.font = `${weight} ${size}px ${c.font}`;
      const w = ctx.measureText(s).width + 16;
      const h = size + 10;
      ctx.globalAlpha = Math.min(1, a);
      ctx.fillStyle = c.face;
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(s, x, y + 0.5);
      ctx.restore();
    },
    stars(seed, n, t, a = 1) {
      const r = rng32(seed);
      for (let i = 0; i < n; i += 1) {
        const x = r() * W;
        const y = r() * H;
        const p = r() * GLANCE_TAU;
        const s = 0.6 + r() * 0.9;
        this.dot(x, y, s, c.ink3, a * (0.18 + 0.14 * Math.sin(t * 1.3 + p)));
      }
    },
  };
}

// ── 장별 모션 — 승인 시안의 draw를 TypeScript로 옮긴 것이다 ────────────────

function drawStructureOrbit(k: GlanceKit, c: GlancePalette, t: number, reduced: boolean, L: GlanceLabels): void {
  k.stars(11, 40, t);
  const cx = 190;
  const cy = 150;
  const a0 = atTime(t, 0, 0.8);
  k.ring(cx, cy, 168, 118, c.hair, a0 * 0.9, 1, [3, 5], -t * 6);
  k.text(L.brand ?? "", cx, 22, { color: c.ink3, size: 11, weight: 500, a: a0 });
  k.orb(cx, cy, 13 * a0, c.warm, a0);
  k.text(L.you ?? "", cx, cy + 28, { a: a0 });
  const aC = atTime(t, 0.5, 0.8);
  k.ring(cx, cy, 118, 72, c.hair, aC);
  // 움직이는 물체를 따라다니는 라벨 대신 왼쪽 아래 고정 범례 — 궤도·위성·연결선·확대 원과
  // 어느 프레임에서도 겹치지 않는다.
  const la = atTime(t, 1.0, 0.8);
  k.ctx.save();
  k.ctx.font = `600 11.5px ${c.font}`;
  const legend0Width = k.ctx.measureText(L.legend0 ?? "").width;
  k.ctx.restore();
  k.dot(26, 284, 4, c.ink, la);
  k.text(L.legend0 ?? "", 38, 284, { align: "left", size: 11.5, a: la });
  k.dot(38 + legend0Width + 14, 284, 4, c.loop, la);
  k.text(L.legend1 ?? "", 38 + legend0Width + 26, 284, { align: "left", size: 11.5, a: la });
  let focus: [number, number] | null = null;
  for (let i = 0; i < 3; i += 1) {
    const ai = atTime(t, 0.6 + i * 0.25, 0.6);
    const ang = -1.9 + (i * GLANCE_TAU) / 3 + t * 0.16;
    const [px, py] = ellPoint(cx, cy, 118, 72, ang);
    k.orb(px, py, 8 * ai, c.ink, ai * 0.95);
    const am = atTime(t, 1.3 + i * 0.2, 0.6);
    k.ring(px, py, 22, 13, c.hair, am * 0.8);
    for (let m = 0; m < 2; m += 1) {
      const ma = t * 1.1 + m * Math.PI + i;
      const [mx, my] = ellPoint(px, py, 22, 13, ma);
      k.orb(mx, my, 3.6 * am, c.loop, am);
      if (i === 0 && m === 0) focus = [mx, my];
    }
  }
  // 목표 하나를 확대해 보는 창
  const z = atTime(t, 2.3, 0.9);
  if (z > 0 && focus) {
    const [fx, fy] = focus;
    const ix = 500;
    const iy = 150;
    const ir = 112 * z;
    const ctx = k.ctx;
    ctx.save();
    ctx.globalAlpha = 0.55 * z;
    ctx.strokeStyle = c.loop;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(ix - ir * 0.2, iy - ir * 0.98);
    ctx.moveTo(fx, fy);
    ctx.lineTo(ix - ir * 0.2, iy + ir * 0.98);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = z;
    ctx.fillStyle = c.face;
    ctx.strokeStyle = c.loop;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(ix, iy, ir, 0, GLANCE_TAU);
    ctx.fill();
    ctx.stroke();
    ctx.clip();
    k.text(L.inside ?? "", ix, iy - 84, { color: c.loop, size: 11, a: atTime(t, 2.9) });
    const ai = atTime(t, 2.8, 0.6);
    k.orb(ix, iy, 10 * ai, c.flow, ai);
    k.text(L.commander ?? "", ix, iy + 22, { a: ai });
    const am = atTime(t, 3.2, 0.6);
    k.ring(ix, iy, 66, 42, c.hair, am);
    for (let m = 0; m < 4; m += 1) {
      const ang = t * 0.55 + (m * GLANCE_TAU) / 4;
      const [mx, my] = ellPoint(ix, iy, 66, 42, ang);
      // 지휘관이 구성원에게 미션을 보낸다
      const ph = ((t - 3.4) * 0.5 + m * 0.25) % 1;
      if (t > 3.4 && !reduced) k.dot(ix + (mx - ix) * ph, iy + (my - iy) * ph, 2, c.flow, am * (1 - ph));
      k.orb(mx, my, 5 * am, c.result, am);
    }
    // 영어처럼 한 줄이 원에 걸리면 두 줄로 나눈다 — 원의 현 안에 들어가게 윗줄·아랫줄로.
    if (L.membersSub) {
      k.text(L.members ?? "", ix, iy + 60, { color: c.ink2, size: 11, a: am });
      k.text(L.membersSub, ix, iy + 76, { color: c.ink2, size: 11, a: am });
    } else {
      k.text(L.members ?? "", ix, iy + 72, { color: c.ink2, size: 11, a: am });
    }
    ctx.restore();
  }
}

function drawStructureFlow(k: GlanceKit, c: GlancePalette, t: number, reduced: boolean, L: GlanceLabels): void {
  k.stars(23, 30, t);
  const cx = 320;
  const cy = 146;
  // 방향: 바깥으로 번지는 물결
  for (let w = 0; w < 3; w += 1) {
    if (t < 0.8 && !reduced) continue;
    const ph = reduced ? 0.3 + w * 0.25 : ((t - 0.8) / 2.6 + w / 3) % 1;
    k.ring(cx, cy, 14 + ph * 225, 7 + ph * 108, c.flow, (1 - ph) * 0.9 * atTime(t, 0.8), 2);
  }
  // 결과: 안으로 감겨 드는 입자
  const ar = atTime(t, 1.8, 0.8);
  const r = rng32(5);
  for (let i = 0; i < 14; i += 1) {
    const a0i = r() * GLANCE_TAU;
    const ph0 = r();
    if (t < 1.8 && !reduced) continue;
    const s = reduced ? ph0 * 0.9 : ((t - 1.8) / 4.2 + ph0) % 1;
    for (let j = 0; j < 6; j += 1) {
      const ss = s - j * 0.012;
      if (ss < 0) continue;
      const rr = 1 - ss;
      const ang = a0i + ss * 2.6;
      const [x, y] = ellPoint(cx, cy, 222 * rr, 106 * rr, ang);
      k.dot(x, y, 2.6 - j * 0.35, c.result, ar * (1 - j / 6) * (ss < 0.92 ? 1 : (1 - ss) / 0.08));
    }
  }
  const rings: (readonly [number, number, string, string])[] = [
    [78, 38, L.inner ?? "", L.innerResult ?? ""],
    [150, 72, L.middle ?? "", L.middleResult ?? ""],
    [222, 106, L.outer ?? "", L.outerResult ?? ""],
  ];
  rings.forEach(([rx, ry, name, res], i) => {
    const a = atTime(t, 0.3 + i * 0.25);
    k.ring(cx, cy, rx * (0.7 + 0.3 * a), ry * (0.7 + 0.3 * a), c.hair, a, 1.2);
    k.tag(name, cx, cy - ry, { a, size: 11 });
    k.tag(res, cx, cy + ry, { a: atTime(t, 1.8 + (2 - i) * 0.3), size: 11, color: c.result, line: c.result });
  });
  const a0 = atTime(t, 0);
  k.orb(cx, cy, 13 * a0, c.warm, a0);
  k.text(L.you ?? "", cx, cy + 0.5, { size: 9.5, weight: 700, color: c.face, a: a0 });
  k.text(L.outward ?? "", 40, 40, { color: c.flow, size: 13, weight: 700, a: atTime(t, 0.9), align: "left" });
  k.text(L.outwardSub ?? "", 40, 58, { color: c.ink2, size: 11, weight: 500, a: atTime(t, 0.9), align: "left" });
  k.text(L.inward ?? "", 600, 246, { color: c.result, size: 13, weight: 700, a: ar, align: "right" });
  k.text(L.inwardSub ?? "", 600, 264, { color: c.ink2, size: 11, weight: 500, a: ar, align: "right" });
}

function drawTaskforce(k: GlanceKit, c: GlancePalette, t: number, reduced: boolean, L: GlanceLabels): void {
  k.stars(37, 36, t);
  const cx = 320;
  const cy = 146;
  const home: (readonly [number, number])[] = [
    [90, 70],
    [550, 70],
    [90, 230],
    [550, 230],
  ];
  const names = [L.a ?? "", L.b ?? "", L.c ?? "", L.d ?? ""];
  const g = atTime(t, 1.2, 1.8);
  const at0 = atTime(t, 1.6, 0.7);
  k.ring(cx, cy, 150, 82, c.hair, g * 0.9, 1, [2, 5], -t * 5);
  k.orb(cx, cy, 16 * at0, c.flow, at0);
  k.text(L.topic ?? "", cx, cy + 32, { a: at0 });
  const pos = home.map(([hx, hy], i) => {
    const self = t * 0.9 + i;
    const sx = hx + 16 * Math.cos(self);
    const sy = hy + 10 * Math.sin(self);
    const ang = -2.4 + (i * GLANCE_TAU) / 4 + t * 0.12;
    const [rx, ry] = ellPoint(cx, cy, 150, 82, ang);
    return [sx + (rx - sx) * g, sy + (ry - sy) * g] as [number, number];
  });
  // 발언 불꽃: 한 사령관에서 다른 사령관으로
  if (t > 3 || reduced) {
    const order: (readonly [number, number])[] = [
      [0, 1],
      [1, 3],
      [3, 2],
      [2, 0],
      [0, 3],
      [1, 2],
    ];
    order.forEach(([a, b], n) => {
      const ph = reduced ? (n === 0 ? 0.55 : -1) : ((t - 3) / 1.1) % order.length - n;
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
  pos.forEach(([x, y], i) => {
    const a = atTime(t, i * 0.15);
    k.orb(x, y, 9 * a, c.ink, a);
    k.text(names[i] ?? "", x, y + 20, { size: 11, color: c.ink2, a });
  });
  k.text(L.note ?? "", cx, 284, { color: c.ink2, size: 11, weight: 500, a: atTime(t, 3) });
  k.tag(L.lab ?? "", 590, 22, { size: 10.5, color: c.ink2, a: atTime(t, 0.4) });
}

function drawContextLens(k: GlanceKit, c: GlancePalette, t: number, _reduced: boolean, L: GlanceLabels): void {
  const lx = 300;
  const wx = 500;
  const wy = 150;
  const wr = 118;
  const ctx = k.ctx;
  const r = rng32(9);
  // 흘러드는 기록 — 대부분은 렌즈에서 흩어진다
  for (let i = 0; i < 46; i += 1) {
    const y0 = 30 + r() * 240;
    const sp = 0.14 + r() * 0.1;
    const ph0 = r();
    const s = (t * sp + ph0) % 1;
    let x = 10 + s * (lx - 10);
    let y = y0;
    let a = 0.55;
    if (s > 0.92) {
      const d = (s - 0.92) / 0.08;
      y = y0 + (y0 < 150 ? -1 : 1) * d * 18;
      a *= 1 - d;
    }
    k.dot(x, y, 1.8, c.ink3, a * atTime(t, 0, 0.5));
  }
  k.text(L.pile ?? "", 20, 18, { color: c.ink3, size: 11, weight: 500, align: "left", a: atTime(t, 0.1) });
  // 렌즈
  const al = atTime(t, 0.2);
  ctx.save();
  const lg = ctx.createLinearGradient(lx - 14, 0, lx + 14, 0);
  lg.addColorStop(0, "transparent");
  lg.addColorStop(0.5, c.flow);
  lg.addColorStop(1, "transparent");
  ctx.globalAlpha = al * 0.35;
  ctx.fillStyle = lg;
  ctx.beginPath();
  ctx.ellipse(lx, 150, 14, 122, 0, 0, GLANCE_TAU);
  ctx.fill();
  ctx.globalAlpha = al;
  ctx.strokeStyle = c.flow;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.ellipse(lx, 150, 14, 122, 0, 0, GLANCE_TAU);
  ctx.stroke();
  ctx.restore();
  k.text(L.pick ?? "", lx, 288, { color: c.flow, size: 11, a: al });
  // 에이전트가 읽는 창
  const aw = atTime(t, 0.3);
  ctx.save();
  ctx.globalAlpha = aw;
  ctx.fillStyle = c.face;
  ctx.strokeStyle = c.hair;
  ctx.beginPath();
  ctx.arc(wx, wy, wr, 0, GLANCE_TAU);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  k.text(L.reading ?? "", wx, 18, { color: c.ink3, size: 11, weight: 500, a: aw });
  const items = [L.item0, L.item1, L.item2, L.item3, L.item4, L.item5, L.item6];
  items.forEach((s, i) => {
    if (s === undefined) return;
    const start = 0.6 + i * 0.45;
    const y0 = 50 + ((i * 53) % 200);
    const sy = 70 + i * 27;
    const ym = y0 + (150 - y0) * 0.3;
    const p1 = atTime(t, start, 0.7);
    const p2 = atTime(t, start + 0.7, 0.5);
    let x: number;
    let y: number;
    if (p2 <= 0) {
      x = 20 + (lx - 20) * p1;
      y = y0 + (ym - y0) * p1;
    } else {
      x = lx + (wx - lx) * p2;
      y = ym + (sy - ym) * p2;
    }
    if (p1 > 0 && p2 < 1) k.orb(x, y, 4, c.flow, 1);
    const at2 = atTime(t, start + 1.1, 0.4);
    if (i === 0) k.glow(wx, sy, 70, c.flow, at2 * 0.8);
    k.text(s, wx, sy, { size: i === 0 ? 13 : 12, weight: i === 0 ? 700 : 500, color: i === 0 ? c.flow : c.ink, a: at2 });
  });
}

function drawHarnessShells(k: GlanceKit, c: GlancePalette, t: number, _reduced: boolean, L: GlanceLabels): void {
  k.stars(51, 26, t);
  const cx = 200;
  const cy = 150;
  const shells: (readonly [number, string, string, string, number])[] = [
    [58, c.loop, L.shell0 ?? "", L.shell0Sub ?? "", -40],
    [90, c.flow, L.shell1 ?? "", L.shell1Sub ?? "", -5],
    [122, c.result, L.shell2 ?? "", L.shell2Sub ?? "", 28],
  ];
  // 심: 모델과 그 안에서 튀는 생각들 — 첫 껍질 밖으로 나가지 않는다
  const ac = atTime(t, 0);
  const r = rng32(3);
  for (let i = 0; i < 16; i += 1) {
    const ang = r() * GLANCE_TAU;
    const sp = 0.6 + r() * 0.9;
    const ph = r() * GLANCE_TAU;
    const d = 28 + 22 * (0.5 + 0.5 * Math.sin(t * sp * 2 + ph));
    const aa = ang + t * 0.4 * (i % 2 ? -1 : 1);
    k.dot(cx + d * Math.cos(aa), cy + d * Math.sin(aa), 1.6, c.loop, 0.7 * ac);
  }
  k.orb(cx, cy, 20 * ac, c.loop, ac);
  k.text(L.model ?? "", cx, cy + 0.5, { color: c.face, size: 12, weight: 700, a: ac });
  shells.forEach(([rad, col, title, sub, deg], i) => {
    const a = atTime(t, 0.5 + i * 0.45);
    const rr = rad * (0.85 + 0.15 * a);
    k.ring(cx, cy, rr, rr, col, a * 0.9, 2.2, [rad * 0.5, rad * 0.18], t * (i % 2 ? -14 : 12));
    const ar = (deg * Math.PI) / 180;
    const px = cx + rad * Math.cos(ar);
    const py = cy + rad * Math.sin(ar);
    const ly = 70 + i * 80;
    const al = atTime(t, 0.9 + i * 0.45);
    k.line(
      [
        [px, py],
        [372, ly],
      ],
      col,
      al * 0.7,
      1,
    );
    k.dot(px, py, 3, col, al);
    k.text(title, 384, ly - 9, { align: "left", size: 13, weight: 700, color: col, a: al });
    k.text(sub, 384, ly + 10, { align: "left", size: 12, weight: 500, color: c.ink, a: al });
  });
}

function drawLoopComet(k: GlanceKit, c: GlancePalette, t: number, reduced: boolean, L: GlanceLabels): void {
  k.stars(61, 26, t);
  const cx = 196;
  const cy = 150;
  const R = 104;
  const ctx = k.ctx;
  const a0 = atTime(t, 0);
  k.ring(cx, cy, R, R, c.hair, a0, 6);
  k.text(L.lead ?? "", cx, cy - 6, { size: 14, weight: 700, a: a0 });
  k.text(L.leadSub ?? "", cx, cy + 14, { size: 11, weight: 500, color: c.ink2, a: a0 });
  const head = -Math.PI / 2 + Math.max(0, t - 0.8) * 1.15;
  if (t > 0.8 || reduced) {
    for (let j = 0; j < 40; j += 1) {
      const ang = head - j * 0.03;
      k.dot(cx + R * Math.cos(ang), cy + R * Math.sin(ang), 5.5 - j * 0.12, c.loop, (1 - j / 40) * 0.9);
    }
    k.glow(cx + R * Math.cos(head), cy + R * Math.sin(head), 26, c.loop, 2);
  }
  const nodes = [L.node0 ?? "", L.node1 ?? "", L.node2 ?? "", L.node3 ?? "", L.node4 ?? ""];
  nodes.forEach((s, i) => {
    const ang = -Math.PI / 2 + (i * GLANCE_TAU) / 5;
    const x = cx + R * Math.cos(ang);
    const y = cy + R * Math.sin(ang);
    const d = ((head - ang) % GLANCE_TAU + GLANCE_TAU) % GLANCE_TAU;
    const lit = t > 0.8 ? Math.max(0, 1 - d / 1.4) : 0;
    const a = atTime(t, 0.3 + i * 0.15);
    const col = i === 4 ? c.result : c.loop;
    k.glow(x, y, 30, col, a * (0.4 + lit * 1.6));
    k.dot(x, y, 5 + lit * 2, col, a);
    k.text(s, cx + (R + 30) * Math.cos(ang), cy + (R + 22) * Math.sin(ang), { size: 12, a, color: lit > 0.3 ? col : c.ink });
  });
  // 오른쪽: 루프를 깨우고 멈추는 장치들
  const sides = [L.side0 ?? "", L.side1 ?? "", L.side2 ?? "", L.side3 ?? ""];
  sides.forEach((s, i) => {
    const a = atTime(t, 1.4 + i * 0.25);
    const x = 404;
    const y = 66 + i * 56;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = c.loop;
    ctx.fillStyle = c.loop;
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.translate(x, y);
    if (i === 0) {
      ctx.rotate(reduced ? 0 : Math.sin(t * 6) * 0.25);
      ctx.beginPath();
      ctx.arc(0, -1, 7, Math.PI, 0);
      ctx.lineTo(8, 6);
      ctx.lineTo(-8, 6);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 9, 2, 0, GLANCE_TAU);
      ctx.fill();
    }
    if (i === 1) {
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, GLANCE_TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -6);
      ctx.stroke();
      const h = t * 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(6 * Math.cos(h), 6 * Math.sin(h));
      ctx.stroke();
    }
    if (i === 2) {
      ctx.globalAlpha = a * (reduced || Math.sin(t * 3) > 0 ? 1 : 0.3);
      ctx.fillRect(-6, -7, 4, 14);
      ctx.fillRect(2, -7, 4, 14);
    }
    if (i === 3) {
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(8, -5);
      ctx.lineTo(8, 2);
      ctx.quadraticCurveTo(8, 8, 0, 10);
      ctx.quadraticCurveTo(-8, 8, -8, 2);
      ctx.lineTo(-8, -5);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-3.5, 0);
      ctx.lineTo(-0.5, 3);
      ctx.lineTo(4, -2.5);
      ctx.stroke();
    }
    ctx.restore();
    k.text(s, 424, y, { align: "left", size: 12, weight: 500, a });
  });
}

function drawDoubleLoop(k: GlanceKit, c: GlancePalette, t: number, reduced: boolean, L: GlanceLabels): void {
  k.stars(71, 24, t);
  const cx = 210;
  const cy = 156;
  const RX = 150;
  const RY = 92;
  const r = 30;
  const ctx = k.ctx;
  const a0 = atTime(t, 0);
  k.ring(cx, cy, RX, RY, c.flow, a0 * 0.55, 1.4);
  const tEnd = reduced ? 7 : Math.max(0, t - 0.6);
  const trail = Math.min(tEnd, 9);
  const w1 = 0.42;
  const w2 = 3.1;
  // 작은 바퀴의 한 점이 그리는 자취
  ctx.save();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = c.loop;
  ctx.lineCap = "round";
  const steps = 240;
  let prev: [number, number] | null = null;
  for (let i = 0; i <= steps; i += 1) {
    const s = tEnd - trail + (trail * i) / steps;
    const [ox, oy] = ellPoint(cx, cy, RX, RY, -Math.PI / 2 + s * w1);
    const p: [number, number] = [ox + r * Math.cos(s * w2), oy + r * 0.7 * Math.sin(s * w2)];
    if (prev) {
      ctx.globalAlpha = (i / steps) * 0.85 * a0;
      ctx.beginPath();
      ctx.moveTo(prev[0], prev[1]);
      ctx.lineTo(p[0], p[1]);
      ctx.stroke();
    }
    prev = p;
  }
  ctx.restore();
  const [ox, oy] = ellPoint(cx, cy, RX, RY, -Math.PI / 2 + tEnd * w1);
  k.ring(ox, oy, r, r * 0.7, c.loop, 0.5 * a0);
  k.orb(ox, oy, 4, c.flow, a0);
  if (prev) k.orb(prev[0], prev[1], 4, c.loop, a0);
  const stops: (readonly [number, string])[] = [
    [-Math.PI / 2, L.stop0 ?? ""],
    [0, L.stop1 ?? ""],
    [Math.PI / 2, L.stop2 ?? ""],
  ];
  stops.forEach(([ang, s], i) => {
    const [x, y] = ellPoint(cx, cy, RX, RY, ang);
    k.tag(s, x, y, { size: 11, color: c.flow, line: c.flow, a: atTime(t, 0.4 + i * 0.2) });
  });
  k.text(L.outer ?? "", 20, 20, { align: "left", size: 12, weight: 700, color: c.flow, a: atTime(t, 0.3) });
  k.text(L.inner ?? "", 20, 38, { align: "left", size: 12, weight: 700, color: c.loop, a: atTime(t, 0.6) });
  // 배우는 길: 결과 판단 → 회고 → learning-harvest → 규칙·skill → 다시 설명·정보로
  const ph = reduced ? 0.5 : ((t - 2) / 4.4) % 1;
  const learns = [L.learn0 ?? "", L.learn1 ?? "", L.learn2 ?? ""];
  learns.forEach((s, i) => {
    const y = 236 - i * 80;
    const a = atTime(t, 1.6 + i * 0.3);
    const on = t > 2 && ph > 0.25 * (i === 0 ? 0 : 1) + i * 0.2 - 0.05 && ph < 0.3 + i * 0.22;
    k.glow(520, y, 50, c.result, a * (on ? 2 : 0.5));
    k.tag(s, 520, y, { size: 12, color: c.result, line: c.result, a });
    if (i < 2) k.line([[520, y - 15], [520, y - 65]], c.result, a * 0.6, 1.2, [2, 4]);
  });
  k.text(L.memory ?? "", 520, 284, { size: 11, weight: 500, color: c.ink2, a: atTime(t, 2.4) });
  if (t > 2 || reduced) {
    const path = (u: number): [number, number] => {
      if (u < 0.25) {
        const v = u / 0.25;
        return [cx + (470 - cx) * v, cy + RY + (236 - cy - RY) * v];
      }
      if (u < 0.7) {
        const v = (u - 0.25) / 0.45;
        return [470 + 50 * Math.min(1, v * 4), 236 - 160 * v];
      }
      const v = (u - 0.7) / 0.3;
      const bx = 520;
      const by = 76;
      const ex = cx + 40;
      const ey = cy - RY - 4;
      const mx = 400;
      const my = 18;
      return [
        (1 - v) * (1 - v) * bx + 2 * (1 - v) * v * mx + v * v * ex,
        (1 - v) * (1 - v) * by + 2 * (1 - v) * v * my + v * v * ey,
      ];
    };
    for (let j = 0; j < 10; j += 1) {
      const u = ph - j * 0.012;
      if (u < 0) continue;
      const [x, y] = path(u);
      k.dot(x, y, 3.4 - j * 0.27, c.result, 1 - j / 10);
    }
  }
}

function drawGraphStars(k: GlanceKit, c: GlancePalette, t: number, _reduced: boolean, L: GlanceLabels): void {
  k.stars(81, 70, t, 1.3);
  const S: Record<string, readonly [number, number, string, number]> = {
    a: [64, 168, L.a ?? "", 0.5],
    b: [170, 120, L.b ?? "", 1.2],
    c: [282, 64, L.c ?? "", 2.0],
    d: [292, 196, L.d ?? "", 2.0],
    e: [408, 132, L.e ?? "", 2.8],
    f: [500, 92, L.f ?? "", 3.5],
  };
  const E: (readonly [keyof typeof S, keyof typeof S])[] = [
    ["a", "b"],
    ["b", "c"],
    ["b", "d"],
    ["c", "e"],
    ["d", "e"],
    ["e", "f"],
  ];
  E.forEach(([p, q]) => {
    const [x1, y1, , s1] = S[p]!;
    const [x2, y2, , s2] = S[q]!;
    const v = clamp01((t - s1) / (s2 - s1));
    if (v <= 0) return;
    k.line(
      [
        [x1, y1],
        [x1 + (x2 - x1) * v, y1 + (y2 - y1) * v],
      ],
      c.flow,
      0.75,
      1.3,
    );
    if (v < 1) k.orb(x1 + (x2 - x1) * v, y1 + (y2 - y1) * v, 2.6, c.flow, 1);
  });
  Object.values(S).forEach(([x, y, s, on]) => {
    const lit = atTime(t, on, 0.4);
    k.glow(x, y, 34, c.flow, lit * 1.4);
    k.dot(x, y, 3 + lit * 2.5, lit > 0 ? c.flow : c.ink3, 0.5 + 0.5 * lit);
    k.text(s, x, y + 20, { size: 12, a: 0.35 + 0.65 * lit });
  });
  k.text(L.together ?? "", 287, 132, { color: c.flow, size: 11, a: atTime(t, 2.2) });
  // 후속 목표: 별똥별이 다음 별자리로
  const sp = atTime(t, 4.0, 1.0);
  if (sp > 0 && sp < 1) {
    const [x1, y1, x2, y2] = [500, 92, 588, 222];
    const x = x1 + (x2 - x1) * sp;
    const y = y1 + (y2 - y1) * sp;
    const b = Math.max(0, sp - 0.35);
    k.line(
      [
        [x1 + (x2 - x1) * b, y1 + (y2 - y1) * b],
        [x, y],
      ],
      c.result,
      0.8,
      1.6,
    );
    k.orb(x, y, 3, c.result, 1);
  }
  const fa = atTime(t, 4.9, 0.6);
  const follow: (readonly [number, number])[] = [
    [572, 214],
    [598, 232],
    [588, 252],
    [610, 210],
  ];
  follow.forEach(([x, y], i) => {
    if (i) k.line([[572, 214], [x, y]], c.result, fa * 0.5, 1);
    k.orb(x, y, 2.4, c.result, fa);
  });
  // 후속 목표 표기는 별자리 오른편에 — 영어 길이에서도 무대 안에 들어가게 중심을 왼편에 둔다.
  k.text(L.followup ?? "", 566, 276, { size: 12, color: c.result, a: fa });
}

function drawAgentPrism(k: GlanceKit, c: GlancePalette, t: number, reduced: boolean, L: GlanceLabels): void {
  k.stars(91, 24, t);
  const px = 300;
  const py = 116;
  const ctx = k.ctx;
  const outs: (readonly [number, number, string, string])[] = [
    [540, 44, c.result, L.light ?? ""],
    [540, 116, c.flow, L.balanced ?? ""],
    [540, 188, c.loop, L.strong ?? ""],
  ];
  const ab = atTime(t, 0.2);
  ctx.save();
  ctx.globalAlpha = ab * 0.5;
  const gi = ctx.createLinearGradient(30, 0, px, 0);
  gi.addColorStop(0, "transparent");
  gi.addColorStop(1, c.ink3);
  ctx.strokeStyle = gi;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(30, py);
  ctx.lineTo(px - 20, py);
  ctx.stroke();
  ctx.restore();
  k.text(L.stream ?? "", 40, py - 22, { align: "left", size: 11, weight: 500, color: c.ink2, a: ab });
  outs.forEach(([x, y, col, s], i) => {
    const a = atTime(t, 0.9 + i * 0.2);
    ctx.save();
    ctx.globalAlpha = a * 0.55;
    const gg = ctx.createLinearGradient(px + 20, py, x, y);
    gg.addColorStop(0, col);
    gg.addColorStop(1, "transparent");
    ctx.strokeStyle = gg;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(px + 18, py);
    ctx.lineTo(x - 16, y);
    ctx.stroke();
    ctx.restore();
    k.orb(x, y, 10 * a, col, a);
    k.text(s, x, y + 22, { size: 11.5, a });
  });
  const ap = atTime(t, 0.5);
  k.glow(px, py, 54, c.flow, ap);
  ctx.save();
  ctx.globalAlpha = ap;
  ctx.fillStyle = c.face;
  ctx.strokeStyle = c.ink2;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(px, py - 34);
  ctx.lineTo(px + 30, py + 22);
  ctx.lineTo(px - 30, py + 22);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  k.text(L.gateway ?? "", px, py + 40, { size: 12, weight: 700, a: ap });
  // 미션 알갱이: 크기에 따라 갈 곳이 다르다
  if (t > 1.4 || reduced) {
    const r = rng32(4);
    for (let i = 0; i < 9; i += 1) {
      const kind = i % 3;
      const sz = [2, 3.2, 4.6][kind]!;
      const ph0 = r();
      const s = reduced ? (i < 3 ? 0.3 + i * 0.25 : -1) : ((t - 1.4) / 3.2 + ph0) % 1;
      if (s < 0) continue;
      const [tx, ty, , ] = outs[kind]!;
      const col = outs[kind]![2];
      let x: number;
      let y: number;
      let cl = c.ink2;
      if (s < 0.5) {
        x = 30 + ((px - 30) * (s / 0.5));
        y = py;
      } else {
        const v = (s - 0.5) / 0.5;
        x = px + (tx - 16 - px) * v;
        y = py + (ty - py) * v;
        cl = col;
      }
      k.dot(x, y, sz, cl, s > 0.92 ? (1 - s) / 0.08 : 1);
    }
  }
  const roles: (readonly [string, string, string])[] = [
    [L.role0 ?? "", L.role0Sub ?? "", c.warm],
    [L.role1 ?? "", L.role1Sub ?? "", c.flow],
    [L.role2 ?? "", L.role2Sub ?? "", c.result],
    [L.role3 ?? "", L.role3Sub ?? "", c.ink2],
  ];
  roles.forEach(([n, s, col], i) => {
    const a = atTime(t, 2 + i * 0.15);
    const x = 40 + i * 106;
    k.orb(x, 264, 5, col, a);
    k.text(n, x + 12, 257, { align: "left", size: 12, weight: 700, a });
    k.text(s, x + 12, 274, { align: "left", size: 11, weight: 500, color: c.ink2, a });
  });
  k.text(L.tools ?? "", 540, 264, { size: 11, weight: 500, color: c.ink2, a: atTime(t, 2.6) });
}

const SCENE_DRAWS: readonly (
  | ((k: GlanceKit, c: GlancePalette, t: number, reduced: boolean, L: GlanceLabels) => void)
  | null
)[] = [
  drawStructureOrbit,
  drawStructureFlow,
  drawTaskforce,
  drawContextLens,
  drawHarnessShells,
  drawLoopComet,
  drawDoubleLoop,
  drawGraphStars,
  drawAgentPrism,
  null,
];

// ── 다이얼로그 ────────────────────────────────────────────────────────────

function useOsReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function GlanceSummaryTiles({ locale }: { readonly locale: ConsoleLocale }): React.JSX.Element {
  const rows = fleetGlanceSummary(locale);
  return (
    <div className="glance-summary" aria-hidden={false}>
      {rows.map((row) => (
        <div className="glance-tile" key={row.icon}>
          <svg viewBox="0 0 36 36" aria-hidden="true" focusable="false">
            {row.icon === "lens" ? (
              <>
                <ellipse cx="18" cy="18" rx="4" ry="14" stroke="var(--aurora)" fill="none" />
                <circle cx="5" cy="11" r="1.6" fill="var(--text-tertiary)" />
                <circle cx="8" cy="25" r="1.6" fill="var(--text-tertiary)" />
                <circle cx="30" cy="18" r="3.2" fill="var(--aurora)" />
              </>
            ) : null}
            {row.icon === "shells" ? (
              <>
                <circle cx="18" cy="18" r="5" fill="var(--apex)" />
                <circle cx="18" cy="18" r="10" stroke="var(--aurora)" fill="none" strokeDasharray="5 3" />
                <circle cx="18" cy="18" r="15" stroke="var(--positive)" fill="none" strokeDasharray="7 3" />
              </>
            ) : null}
            {row.icon === "comet" ? (
              <>
                <circle cx="18" cy="18" r="13" stroke="var(--hairline-strong)" fill="none" strokeWidth="3" />
                <path d="M5 18 A13 13 0 0 1 18 5" stroke="var(--apex)" strokeWidth="3" fill="none" strokeLinecap="round" />
                <circle cx="18" cy="5" r="3" fill="var(--apex)" />
              </>
            ) : null}
            {row.icon === "spiro" ? (
              <>
                <ellipse cx="16" cy="19" rx="13" ry="9" stroke="var(--aurora)" fill="none" />
                <circle cx="28" cy="13" r="6" stroke="var(--apex)" fill="none" />
                <circle cx="33" cy="10" r="2" fill="var(--apex)" />
              </>
            ) : null}
            {row.icon === "stars" ? (
              <>
                <path d="M5 26 L13 18 L22 9 M13 18 L23 26 L31 14" stroke="var(--aurora)" fill="none" />
                <circle cx="5" cy="26" r="2" fill="var(--aurora)" />
                <circle cx="13" cy="18" r="2" fill="var(--aurora)" />
                <circle cx="22" cy="9" r="2" fill="var(--aurora)" />
                <circle cx="23" cy="26" r="2" fill="var(--aurora)" />
                <circle cx="31" cy="14" r="2" fill="var(--aurora)" />
              </>
            ) : null}
            {row.icon === "prism" ? (
              <>
                <path d="M13 8 L21 24 L5 24 Z" stroke="var(--text-secondary)" fill="none" strokeLinejoin="round" />
                <path d="M19 17 L33 8" stroke="var(--positive)" strokeWidth="2" strokeLinecap="round" />
                <path d="M19 17 L33 17" stroke="var(--aurora)" strokeWidth="2" strokeLinecap="round" />
                <path d="M19 17 L33 26" stroke="var(--apex)" strokeWidth="2" strokeLinecap="round" />
              </>
            ) : null}
          </svg>
          <b>{row.title}</b>
          <span>{row.body}</span>
          <i>{row.detail}</i>
        </div>
      ))}
    </div>
  );
}

function FleetAtAGlanceDialog({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  const locale: ConsoleLocale = useConsoleLocale();
  const scenes = fleetGlanceScenes(locale);
  const chrome = fleetGlanceChrome(locale);
  const [index, setIndex] = useState(0);
  const [auto, setAuto] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const osReduced = useOsReducedMotion();
  // Console 설정의 모션 감소 — OS 감속 모션과는 별개라 둘을 따로 잰다.
  const globalSettings = useGlobalSettingsStore();
  const settingReduced = globalSettings.state?.reduceMotion === true;
  const [replayToken, setReplayToken] = useState(0);
  const scene: FleetGlanceSceneCopy = scenes[index] ?? scenes[0]!;
  const draw = SCENE_DRAWS[index] ?? null;

  const go = (next: number): void => {
    setIndex(Math.max(0, Math.min(scenes.length - 1, next)));
  };
  const close = (): void => {
    setAuto(false);
    onClose();
  };

  // 모달 규율 — 단축키 대화상자와 같은 길이다: 셸을 inert로 잠그고, 열리는 순간의
  // 포커스를 돌려놓고, Esc·←→·Tab을 창 안에서 끝낸다.
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".console-shell");
    const previous = document.body.getAttribute(GLANCE_MODAL_ATTRIBUTE);
    document.body.setAttribute(GLANCE_MODAL_ATTRIBUTE, "true");
    if (shell) shell.inert = true;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      if (previous === null) document.body.removeAttribute(GLANCE_MODAL_ATTRIBUTE);
      else document.body.setAttribute(GLANCE_MODAL_ATTRIBUTE, previous);
      if (shell) shell.inert = false;
      returnFocusRef.current?.focus?.();
      returnFocusRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        if (index === scenes.length - 1) close();
        else go(index + 1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        go(index - 1);
      } else if (event.key === "Tab") {
        const container = dialogRef.current;
        if (!container) return;
        const focusable = [...container.querySelectorAll<HTMLElement>(GLANCE_FOCUSABLE_SELECTOR)];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      } else {
        return;
      }
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, scenes.length]);

  // 자동 넘기기 — 마지막 장에 닿으면 멈춘다.
  useEffect(() => {
    if (!auto) return;
    if (index >= scenes.length - 1) {
      setAuto(false);
      return;
    }
    const timer = setTimeout(() => setIndex(index + 1), GLANCE_AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [auto, index, scenes.length]);

  // 장면 그리기 — OS 감속 모션에서는 완성 장면 한 프레임으로 멈추고, Console 설정
  // 감소에서는 100ms 단계로 같은 장면을 다시 그린다.
  useEffect(() => {
    if (!draw) return;
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const labels = scene.canvas;
    const frame = (t: number): void => {
      const palette = readGlancePalette();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = stage.clientWidth;
      const ch = stage.clientHeight;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
      }
      const sc = Math.min(cw / GLANCE_WIDTH, ch / GLANCE_HEIGHT);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.setTransform(dpr * sc, 0, 0, dpr * sc, (dpr * (cw - GLANCE_WIDTH * sc)) / 2, (dpr * (ch - GLANCE_HEIGHT * sc)) / 2);
      draw(makeGlanceKit(ctx, palette), palette, t, osReduced || settingReduced, labels);
    };
    if (osReduced) {
      frame(scene.rest || 6);
      return;
    }
    if (settingReduced) {
      let t = 0;
      frame(t);
      const stepper = setInterval(() => {
        t += 0.1;
        frame(t);
      }, 100);
      return () => clearInterval(stepper);
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number): void => {
      frame((now - t0) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [draw, index, scene, osReduced, settingReduced, replayToken]);

  const segLabel = (n: number): string =>
    locale === "ko" ? `${n + 1}장: ${scenes[n]?.title ?? ""}` : `Scene ${n + 1}: ${scenes[n]?.title ?? ""}`;

  return createPortal(
    <div className="glance-scrim">
      <div
        ref={dialogRef}
        className="glance-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={chrome.title}
        tabIndex={-1}
        data-fleet-glance=""
      >
        <div className="glance-head">
          <h2>{chrome.title}</h2>
          <span className="glance-count">{chrome.count.replace("{current}", String(index + 1)).replace("{total}", String(scenes.length))}</span>
          <span className="glance-spacer" />
          <button
            type="button"
            className="glance-icon-btn"
            aria-pressed={auto}
            title={auto ? chrome.autoStop : chrome.autoStart}
            aria-label={auto ? chrome.autoStop : chrome.autoStart}
            onClick={() => setAuto(!auto)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d={auto ? "M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" : "M5 3.5v9l7-4.5z"} fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="glance-icon-btn"
            title={chrome.replay}
            aria-label={chrome.replay}
            disabled={draw === null}
            onClick={() => setReplayToken((token) => token + 1)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3 8a5 5 0 1 0 1.5-3.6M3 2.8v2.6h2.6"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button type="button" className="glance-icon-btn" title={chrome.close} aria-label={chrome.close} onClick={close}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div ref={stageRef} className="glance-stage">
          {draw ? <canvas ref={canvasRef} aria-hidden="true" /> : <GlanceSummaryTiles locale={locale} />}
        </div>
        {/* 캡션은 10장을 같은 칸에 겹쳐 둔다 — 칸이 저절로 그 언어에서 가장 긴 캡션 높이가 돼
            장이 바뀌어도 대화 상자 높이가 그대로다. 보이는 장만 읽히고 나머지는 가려진다. */}
        <div className="glance-caption-stack">
          {scenes.map((s, n) => (
            <div
              className="glance-caption"
              key={n}
              aria-hidden={n === index ? undefined : true}
              aria-live={n === index ? "polite" : undefined}
            >
              <div className="glance-eyebrow">
                <b>{s.chapter}</b>
                {s.tech ? <span>· {s.tech}</span> : null}
              </div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
              {s.tags.length > 0 ? (
                <div className="glance-tags">
                  {s.tags.map((tag) => (
                    <span className="glance-tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <div className="glance-foot">
          <div className="glance-seg-wrap">
            <div className="glance-seg-labels" aria-hidden="true">
              <span>{chrome.sectionStructure}</span>
              <span />
              <span>{chrome.sectionTechniques}</span>
              <span />
              <span>{chrome.sectionRecap}</span>
            </div>
            <div className="glance-segments">
              {scenes.flatMap((s, n) => {
                const gap =
                  n === 3 || n === 9 ? [<span className="glance-seg-gap" key={`gap-${n}`} aria-hidden="true" />] : [];
                return [
                  ...gap,
                  <button
                    type="button"
                    className={`glance-seg${n === index ? " is-on" : ""}${n < index ? " is-done" : ""}`}
                    key={n}
                    aria-label={segLabel(n)}
                    aria-current={n === index ? "step" : "false"}
                    onClick={() => go(n)}
                  />,
                ];
              })}
            </div>
          </div>
          <div className="glance-nav">
            <button type="button" className="glance-btn" disabled={index === 0} onClick={() => go(index - 1)}>
              {chrome.prev}
            </button>
            <button
              type="button"
              className="glance-btn is-primary"
              onClick={() => {
                if (index === scenes.length - 1) close();
                else go(index + 1);
              }}
            >
              {index === scenes.length - 1 ? chrome.close : chrome.next}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── 호스트: 첫 실행에 한 번 자동으로 열고, 메뉴에서 언제든 다시 연다 ───────

export function FleetAtAGlanceHost(): React.JSX.Element | null {
  const state = useConsoleState();
  const settings = useGlobalSettingsStore();
  // 모바일 레이아웃에는 도움말 메뉴가 없어 닫으면 다시 열 길이 없다 — 최초 설정 가이드·투어와
  // 같은 규칙으로 자동 열림을 데스크톱에만 둔다. 이미 열린 팝업은 레이아웃이 바뀌어도 그대로 둔다.
  const mobileLayout = useViewMode().effective === "mobile";
  // 새 사용자·기존 사용자 판정은 세션에서 설정을 처음 ready로 읽은 그 틱에 한 번만 한다.
  const classifiedRef = useRef<"fresh" | "returning" | null>(null);

  useEffect(() => {
    if (mobileLayout) return;
    if (!state.bootstrapped) return;
    if (settings.loadStatus !== "ready" || !settings.state) return;
    if (classifiedRef.current === null) {
      // 전역 설정을 처음 읽은 시점에 최초 설정 가이드를 이미 본 기록(서버 seenFeatureTours의
      // 승격 전 legacy localStorage 포함)이 있거나 사령관이 이미 있으면 기존 사용자다.
      // 사령관 목록은 bootstrapped가 서기 전에(이 효과가 도는 조건) 읽혀 있으므로, 분류 시점에
      // 이미 차 있다 — resolveOnboardingOnBootstrap이 목록을 기다렸다가 bootstrapped를 세운다.
      // main.tsx가 렌더 전에 이관을 기다리지만, 저장이 막힌 환경에서는 legacy 표식이 남을 수 있어
      // seen과 legacy를 둘 다 본다.
      const returning = settings.state.seenFeatureTours.includes(COMMISSIONING_SEEN_KEY)
        || readStoredCommissioningSeen()
        || readCommodoreList().length > 0;
      classifiedRef.current = returning ? "returning" : "fresh";
      if (returning) {
        // 기존 사용자에게는 자동으로 띄우지 않고 본 기록만 조용히 남긴다 — 메뉴로는 언제든 열린다.
        if (!settings.state.seenFeatureTours.includes(FLEET_AT_A_GLANCE_SEEN_KEY)) {
          rememberSeen([FLEET_AT_A_GLANCE_SEEN_KEY]);
        }
        return;
      }
    }
    if (classifiedRef.current === "returning") return;
    if (settings.state.seenFeatureTours.includes(FLEET_AT_A_GLANCE_SEEN_KEY)) return;
    // 최초 설정 가이드·새 소식이 떠 있는 동안은 기다린다 — 겹쳐 뜨지 않고 그것이 닫힌 뒤에 열린다.
    if (state.onboardingOpen || state.whatsNewOpen) return;
    if (state.fleetAtAGlanceOpen) return;
    openFleetAtAGlance();
    // 닫으면 다시 뜨지 않는다 — 본 기록은 같은 seenFeatureTours 필드에 쌓인다.
    rememberSeen([FLEET_AT_A_GLANCE_SEEN_KEY]);
  }, [
    mobileLayout,
    state.bootstrapped,
    state.onboardingOpen,
    state.whatsNewOpen,
    state.fleetAtAGlanceOpen,
    settings.loadStatus,
    settings.state,
  ]);

  if (!state.fleetAtAGlanceOpen) return null;
  // 다른 우선 오버레이가 떠 있으면 양보한다 — 새 소식과 같은 규율이다. 억제가 풀리면
  // fleetAtAGlanceOpen이 유지된 채 아래 다이얼로그가 다시 살아나 그때 표시된다.
  const suppressed =
    !state.bootstrapped ||
    state.onboardingOpen ||
    state.objectiveRecordSearchOpen ||
    (state.controlHolder !== null && !state.controlCurtainDismissed) ||
    state.mobileNewSessionOpen ||
    state.keyboardShortcutsOpen;
  if (suppressed) return null;
  return <FleetAtAGlanceDialog onClose={closeFleetAtAGlance} />;
}

export function isFleetAtAGlanceModalOpen(): boolean {
  return document.body.getAttribute(GLANCE_MODAL_ATTRIBUTE) === "true";
}
