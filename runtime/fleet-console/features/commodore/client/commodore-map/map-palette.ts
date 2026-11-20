import type { IdentityTone } from "../../../workspace/shared/identity-tones.js";

/**
 * 토큰→RGB 다리 — theme 토큰을 `getComputedStyle`로 읽어 셰이더·Canvas에 RGB로 넘긴다.
 * CSS에는 raw 색을 두지 않는다(불변식). 이 다리는 작게 둔다 — onboarding의
 * `readGlancePalette`·`makeGlanceKit`이 foundation으로 승격되면 그 키트와 합칠 자리다.
 */

/** 렌더러가 읽는 지도 팔레트 — 신호 토큰은 상태(fresh·stale)에만 쓴다. */
export interface MapPalette {
  /** 핵 — 사령관 아바타 정체성 톤(없으면 `--map-core`). */
  readonly core: string;
  readonly description: string;
  readonly intel: string;
  readonly source: string;
  readonly objective: string;
  /** 명시 링크 선 — text-2(aurora 금지). */
  readonly link: string;
  readonly person: string;
  readonly theater: string;
  readonly lessons: string;
  readonly crew: string;
  readonly ink: string;
  readonly inkDim: string;
  readonly hair: string;
  /** 무대 중심·외곽 바탕색 — 셰이더·중공 링 채움·라벨 보호가 읽는다. */
  readonly stageCore: string;
  readonly stageEdge: string;
  /** 최근 갱신 발광 — 상태라 `aurora`가 맞다. */
  readonly fresh: string;
  /** 30일 미검증 — 상태라 `warn`이 맞다. */
  readonly stale: string;
}

/** 팔레트 키 → theme 토큰. `getComputedStyle`이 var() 별칭까지 풀어 준다. */
export const MAP_TOKENS: Record<keyof MapPalette, string> = {
  core: "--map-core",
  description: "--map-description",
  intel: "--map-intel",
  source: "--map-source",
  objective: "--map-objective",
  link: "--map-link",
  person: "--map-branch-person",
  theater: "--map-branch-theater",
  lessons: "--map-branch-lessons",
  crew: "--map-branch-crew",
  ink: "--text-primary",
  inkDim: "--text-secondary",
  hair: "--hairline-strong",
  stageCore: "--map-stage-core",
  stageEdge: "--map-stage-edge",
  fresh: "--aurora",
  stale: "--warn",
};

/** 토큰이 없을 때 쓰는 대체값(다크 기본값). */
const MAP_FALLBACKS: Record<keyof MapPalette, string> = {
  core: "oklch(82% 0.07 190)",
  description: "oklch(82% 0.07 190)",
  intel: "oklch(72% 0.035 230)",
  source: "oklch(69% 0.032 230)",
  objective: "oklch(68% 0.018 245)",
  link: "oklch(78% 0.02 240)",
  person: "oklch(81% 0.125 74)",
  theater: "oklch(75% 0.125 248)",
  lessons: "oklch(76% 0.135 316)",
  crew: "oklch(82% 0.115 118)",
  ink: "oklch(94% 0.008 90)",
  inkDim: "oklch(70% 0.012 245)",
  hair: "oklch(37% 0.02 245)",
  stageCore: "oklch(19.5% 0.014 245)",
  stageEdge: "oklch(11.5% 0.01 245)",
  fresh: "oklch(77% 0.085 200)",
  stale: "oklch(75% 0.08 88)",
};

function isLightRoot(root: Element | null, inkCss: string): boolean {
  if (root instanceof HTMLElement) {
    if (root.dataset.viewMode === "mobile") return root.dataset.mobileScheme === "light";
    if (root.dataset.theme === "light") return true;
    if (root.dataset.theme === "dark") return false;
  }
  const rgb = cssColorToRgb(inkCss);
  if (!rgb) return false;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.45;
}

export function readMapPalette(
  root: Element | null = typeof document === "undefined" ? null : document.documentElement,
  coreTone: IdentityTone | null = null,
): MapPalette {
  const cs = root ? getComputedStyle(root) : null;
  const out = {} as Record<keyof MapPalette, string>;
  for (const key of Object.keys(MAP_TOKENS) as (keyof MapPalette)[]) {
    const token = MAP_TOKENS[key];
    const value = cs?.getPropertyValue(token).trim() ?? "";
    out[key] = value || MAP_FALLBACKS[key];
  }
  // 사령관 정체성 톤 연동 — 다크는 발광 파스텔(--mongle-*), 라이트는 밝은 바탕 대비(--id-*)를 읽는다.
  if (coreTone && cs) {
    const light = isLightRoot(root, out.ink);
    const toneToken = light ? `--id-${coreTone}` : `--mongle-${coreTone}`;
    const resolved = cs.getPropertyValue(toneToken).trim();
    if (resolved) {
      out.core = resolved;
      out.description = resolved;
    }
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
