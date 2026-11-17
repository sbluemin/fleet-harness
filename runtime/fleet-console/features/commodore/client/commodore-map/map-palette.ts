/**
 * 토큰→RGB 다리 — theme 토큰을 `getComputedStyle`로 읽어 셰이더·Canvas에 RGB로 넘긴다.
 * CSS에는 raw 색을 두지 않는다(불변식). 이 다리는 작게 둔다 — onboarding의
 * `readGlancePalette`·`makeGlanceKit`이 foundation으로 승격되면 그 키트와 합칠 자리다.
 */

/** 렌더러가 읽는 지도 팔레트 — 신호 토큰은 상태(fresh·stale)에만 쓴다. */
export interface MapPalette {
  /** 핵 — 정체성 톤 전용이 아니라 역할 금색(`--role-commodore`). */
  readonly core: string;
  readonly description: string;
  readonly intel: string;
  readonly person: string;
  readonly theater: string;
  readonly lessons: string;
  readonly crew: string;
  readonly source: string;
  readonly objective: string;
  readonly ink: string;
  readonly inkDim: string;
  readonly hair: string;
  /** 최근 갱신 발광 — 상태라 `aurora`가 맞다. */
  readonly fresh: string;
  /** 30일 미검증 — 상태라 `warn`이 맞다. */
  readonly stale: string;
}

/**
 * 팔레트 키 → theme 토큰. `--map-*` 갈래 범주색은 아직 theme.css에 없으므로
 * 임무 5에서 둔다(design-contract 함께 갱신) — 그 전까지 아래 대체값이 선다.
 */
export const MAP_TOKENS: Record<keyof MapPalette, string> = {
  core: "--role-commodore",
  description: "--map-description",
  intel: "--map-intel",
  person: "--map-branch-person",
  theater: "--map-branch-theater",
  lessons: "--map-branch-lessons",
  crew: "--map-branch-crew",
  source: "--map-source",
  objective: "--map-objective",
  ink: "--text-primary",
  inkDim: "--text-secondary",
  hair: "--hairline-strong",
  fresh: "--aurora",
  stale: "--warn",
};

/** 토큰이 없을 때 쓰는 대체값(다크 기준 oklch) — 렌더러가 임무 5 전에도 선다. */
const MAP_FALLBACKS: Record<keyof MapPalette, string> = {
  core: "oklch(80% 0.085 78)",
  description: "oklch(70% 0.06 250)",
  intel: "oklch(72% 0.07 200)",
  person: "oklch(74% 0.07 150)",
  theater: "oklch(72% 0.07 250)",
  lessons: "oklch(74% 0.07 90)",
  crew: "oklch(72% 0.07 320)",
  source: "oklch(65% 0.05 250)",
  objective: "oklch(68% 0.06 180)",
  ink: "oklch(94% 0.008 90)",
  inkDim: "oklch(70% 0.012 245)",
  hair: "oklch(37% 0.02 245)",
  fresh: "oklch(77% 0.085 200)",
  stale: "oklch(75% 0.08 88)",
};

export function readMapPalette(root: Element | null = typeof document === "undefined" ? null : document.documentElement): MapPalette {
  const cs = root ? getComputedStyle(root) : null;
  const out = {} as Record<keyof MapPalette, string>;
  for (const key of Object.keys(MAP_TOKENS) as (keyof MapPalette)[]) {
    const token = MAP_TOKENS[key];
    const value = cs?.getPropertyValue(token).trim() ?? "";
    out[key] = value || MAP_FALLBACKS[key];
  }
  return out;
}

let probe: { readonly canvas: HTMLCanvasElement; readonly ctx: CanvasRenderingContext2D } | null = null;

/**
 * CSS 색 낱말 → 0–255 RGB. 1×1 캔버스가 oklch 등을 받아 적는다.
 * 읽히지 않으면 null — 렌더러가 팔레트 잉크로 대신한다.
 */
export function cssColorToRgb(css: string): readonly [number, number, number] | null {
  try {
    if (typeof document === "undefined") return null;
    probe ??= (() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no-2d");
      return { canvas, ctx };
    })();
    const { ctx } = probe;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    if (a === 0) return null;
    return [r ?? 0, g ?? 0, b ?? 0];
  } catch {
    return null;
  }
}

/** 셰이더 업로드용 — 못 읽은 키는 잉크 색으로 메운다. */
export function mapPaletteToRgb(palette: MapPalette): Record<keyof MapPalette, readonly [number, number, number]> {
  const ink = cssColorToRgb(palette.ink) ?? [240, 235, 220];
  const out = {} as Record<keyof MapPalette, readonly [number, number, number]>;
  for (const key of Object.keys(MAP_TOKENS) as (keyof MapPalette)[]) {
    out[key] = cssColorToRgb(palette[key]) ?? ink;
  }
  return out;
}
