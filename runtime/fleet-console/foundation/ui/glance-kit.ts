/**
 * Canvas 발광 키트 — '플릿 한눈에 보기'의 모션 무대에서 쓰던 그리기 도구다.
 * 태스크포스 소개 카드와 사령관 지도(Canvas 2D·궤도 대체 렌더러)가 같은 키트·팔레트를 공유한다.
 *
 * foundation은 feature를 import하지 않는다 — 팔레트는 theme 토큰 이름만 읽고,
 * 부르는 쪽이 그 값을 canvas에 넘긴다.
 */

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

export interface GlanceTextStyle {
  readonly color?: string;
  readonly size?: number;
  readonly weight?: number;
  readonly align?: CanvasTextAlign;
  readonly a?: number;
}

export interface GlanceTagStyle {
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

const GLANCE_WIDTH = 640;
const GLANCE_HEIGHT = 300;
const GLANCE_TAU = Math.PI * 2;

const rng32 = (seed: number): (() => number) => {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
};

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
      // 반지름이 0 이하면 createRadialGradient가 던진다(m4b 음수 반지름 예외) — 그리기만 건너뛴다.
      if (a <= 0 || r <= 0) return;
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
