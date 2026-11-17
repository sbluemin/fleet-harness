import { makeGlanceKit, type GlanceKit } from "@fleet-console/ui/glance-kit";

import type { MapNode } from "../map-graph.js";
import { mapPaletteToRgb, type MapPalette } from "../map-palette.js";

/**
 * 대체 렌더러(안 B Canvas 2D·안 C 궤도)가 함께 쓰는 작은 도구 상자.
 * 색은 `mapPaletteToRgb`가 토큰에서 읽은 값으로만 만들고, 여기서 raw 색을 새로 두지 않는다.
 */

export type MapRgb = readonly [number, number, number];
export type MapRgbPalette = Record<keyof MapPalette, MapRgb>;

export function mapRgbPalette(palette: MapPalette): MapRgbPalette {
  return mapPaletteToRgb(palette);
}

export function rgbCss([r, g, b]: MapRgb, alpha = 1): string {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 글꼴은 theme 토큰 하나만 읽는다 — 색은 팔레트가 이미 나른다. */
export function readMapFont(): string {
  if (typeof document === "undefined") return "system-ui, sans-serif";
  const value = getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim();
  return value || "system-ui, sans-serif";
}

/** 승격한 glance 키트에 지도 팔레트를 물린다 — 발광·점·글자 모두 이 키트로 긋는다. */
export function mapGlanceKit(ctx: CanvasRenderingContext2D, palette: MapPalette, font: string): GlanceKit {
  return makeGlanceKit(ctx, {
    ink: palette.ink,
    ink2: palette.inkDim,
    ink3: palette.inkDim,
    hair: palette.hair,
    // tag()는 지도에서 쓰지 않는다 — 기본값 자리만 채운다.
    face: palette.hair,
    flow: palette.description,
    result: palette.fresh,
    loop: palette.core,
    warm: palette.description,
    font,
  });
}

/** 노드 종류·갈래 → 팔레트 RGB. 신호(fresh·stale)는 상태로만 덧칠한다. */
export function mapNodeRgb(palette: MapRgbPalette, node: MapNode): MapRgb {
  switch (node.kind) {
    case "core":
      return palette.core;
    case "description":
      return palette.description;
    case "intel":
    case "intel-hub":
    case "intel-overflow":
      return palette.intel;
    case "source":
      return palette.source;
    case "objective":
      return palette.objective;
    case "branch":
    case "topic":
    case "memory":
      return node.branch === null ? palette.inkDim : palette[node.branch];
  }
}

export const MAP_LABEL_SIZE = 11.5;
export const MAP_LABEL_GAP = 7;

export function setMapLabelFont(ctx: CanvasRenderingContext2D, font: string): void {
  ctx.font = `600 ${MAP_LABEL_SIZE}px ${font}`;
}

/** 라벨 한 줄 높이(CSS px) — 맞춤 보기가 아래 여백으로 예약한다. */
export function mapLabelReserve(): number {
  return MAP_LABEL_GAP + MAP_LABEL_SIZE * 1.35;
}

/** 긴 제목은 잘라 그린다 — 맞춤 보기가 예약하는 폭도 이 값 기준이다. */
export function truncateLabel(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = [...text];
  let cut = chars.length;
  while (cut > 1 && ctx.measureText(`${chars.slice(0, cut).join("")}…`).width > maxWidth) cut -= 1;
  return `${chars.slice(0, cut).join("")}…`;
}

export interface MapCanvasSurface {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** CSS px — 그리기·고르기·project가 같은 단위를 쓴다. */
  readonly width: number;
  readonly height: number;
  /** 컨테이너 크기·DPR이 바뀌었으면 true(backing store 재설정 + transform 갱신). */
  resize(): boolean;
  dispose(): void;
}

/**
 * 용기에 Canvas를 붙이고 DPR을 맞춘다. 크기 변화는 ResizeObserver가 알리며,
 * 부르는 쪽이 다시 그린다(상시 rAF 루프 없음).
 */
export function attachMapCanvas(container: HTMLElement, onResize: () => void): MapCanvasSurface | null {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
  if (getComputedStyle(container).position === "static") container.style.position = "relative";
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return null;
  }

  let width = 0;
  let height = 0;
  let dpr = 1;
  const resize = (): boolean => {
    const rect = container.getBoundingClientRect();
    const nextWidth = Math.max(0, Math.round(rect.width));
    const nextHeight = Math.max(0, Math.round(rect.height));
    const nextDpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? Math.min(2, devicePixelRatio) : 1;
    if (nextWidth === width && nextHeight === height && nextDpr === dpr) return false;
    width = nextWidth;
    height = nextHeight;
    dpr = nextDpr;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  };
  resize();

  const observer = typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver(() => {
      if (resize()) onResize();
    });
  observer?.observe(container);

  return {
    canvas,
    ctx,
    get width() { return width; },
    get height() { return height; },
    resize,
    dispose() {
      observer?.disconnect();
      canvas.remove();
    },
  };
}
