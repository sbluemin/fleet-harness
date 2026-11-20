import { makeGlanceKit, type GlanceKit } from "@fleet-console/ui/glance-kit";

import type { MapEdge, MapGraph, MapNode } from "../map-graph.js";
import { cssColorToRgb, mapPaletteToRgb, type MapPalette } from "../map-palette.js";

/**
 * 궤도 지도(휴대폰) 렌더러가 쓰는 작은 도구 상자.
 * 색은 `mapPaletteToRgb`가 토큰에서 읽은 값으로만 만들고, 여기서 raw 색을 새로 두지 않는다.
 * 크기·선·라벨 규칙은 시안 `commodore-mindmap.local.html`의 radius()·colorOf·render()·placeLabels(),
 * CSS `.gl-labels`를 그대로 옮긴 것이다(evidence `m9-mockup-gap.md` G3·G4·G5·G8).
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

/**
 * 라벨 그림자 바탕 — 시안 `.gl-labels span`의 `text-shadow: 0 0 6px var(--bg)`.
 * 팔레트에 배경 키가 없어 무대 바탕 토큰(`--canvas-abyss`)만 여기서 읽는다(색조가 아닌 깊이).
 */
export function readMapBackdrop(): MapRgb {
  if (typeof document === "undefined") return [13, 15, 19];
  const cs = getComputedStyle(document.documentElement);
  const value = cs.getPropertyValue("--map-stage-edge").trim() || cs.getPropertyValue("--canvas-abyss").trim();
  return (value ? cssColorToRgb(value) : null) ?? [13, 15, 19];
}

/** 승격한 glance 키트에 지도 팔레트를 물린다 — 발광·점·링 모두 이 키트로 긋는다. */
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

/**
 * 시안 radius() — 핵 22, 허브·설명 10, 주제·정보·출처 4.5, 목표·기억은 이웃 수에 따라 자란다.
 * `+N` 묶음은 시안에 없지만 수정 8-1의 고리와 함께 정보 점보다 큰 7로 둔다.
 */
export function mapNodeRadiusPx(node: MapNode, degree: number): number {
  switch (node.kind) {
    case "core":
      return 22;
    case "description":
    case "intel-hub":
    case "branch":
      return 10;
    case "topic":
    case "intel":
    case "source":
      return 4.5;
    case "intel-overflow":
      return 7;
    case "objective":
      return 5 + Math.min(5, Math.max(0, degree) * 0.6);
    case "memory":
      return 3.6 + Math.min(5, Math.max(0, degree - 1) * 0.9);
  }
}

/** 노드의 이웃 수 — 시안 `deg`. */
export function mapNodeDegree(graph: MapGraph, id: string): number {
  return graph.adjacent.get(id)?.length ?? 0;
}

export type MapEdgeRole = "trunk" | "branch" | "twig" | "intel" | "link" | "objective" | "source";

/**
 * 시안의 선 종류로 옮긴다 — 핵에서 나가는 구조선 trunk, 허브→주제 branch,
 * 주제→기억 twig, 정보 허브→정보 intel, 명시 링크 link, 같은 목표 objective,
 * 정보→출처 source(시안 objective 연결과 같은 자리의 보조선).
 */
export function mapEdgeRole(graph: MapGraph, edge: MapEdge): MapEdgeRole {
  if (edge.kind === "link") return "link";
  if (edge.kind === "objective") return "objective";
  if (edge.kind === "source") return "source";
  if (edge.from === "core") return "trunk";
  const from = graph.byId.get(edge.from);
  const to = graph.byId.get(edge.to);
  if (to?.kind === "source") return "source";
  if (from?.kind === "intel-hub") return "intel";
  if (from?.kind === "topic") return "twig";
  return "branch";
}

/** 시안 선 알파 — trunk .55 / branch .4 / twig .26 / intel .26 / link .6 / 목표 .11. */
export function mapEdgeAlpha(role: MapEdgeRole): number {
  switch (role) {
    case "trunk":
      return 0.55;
    case "branch":
      return 0.4;
    case "twig":
    case "intel":
    case "source":
      return 0.26;
    case "link":
      return 0.6;
    case "objective":
      return 0.11;
  }
}

/** 선 색 — 명시 링크는 text-2(팔레트 link), 목표는 text3, 나머지는 자식 점 색. */
export function mapEdgeRgb(palette: MapRgbPalette, graph: MapGraph, edge: MapEdge): MapRgb {
  if (edge.kind === "link") return palette.link;
  if (edge.kind === "objective") return palette.inkDim;
  const to = graph.byId.get(edge.to);
  return to ? mapNodeRgb(palette, to) : palette.inkDim;
}

export const MAP_LABEL_SIZE = 11.5;
export const MAP_LABEL_STRONG_SIZE = 12.5;
/** 라벨은 점 오른쪽 `x + r + 4`, 위로 `y − 8`에서 시작한다(시안 placeLabels). */
export const MAP_LABEL_OFFSET_X = 4;
export const MAP_LABEL_OFFSET_Y = 8;

/**
 * 라벨 우선순위 — 낮을수록 먼저 자리를 잡는다. 낮은 쪽이 이미 놓인 라벨과 겹치면 생략한다.
 * `forced`(선택)는 언제나 그린다.
 */
export const MAP_LABEL_PRIORITY = {
  forced: -1,
  core: 0,
  hub: 1,
  secondary: 2,
  focus: 3,
  zoomTopic: 4,
} as const;

export interface MapLabelCandidate {
  readonly text: string;
  /** 점 중심 — 라벨은 이 점의 오른쪽 위에서 시작한다. */
  readonly x: number;
  readonly y: number;
  /** 그릴 때의 점 반경(호버·선택 확대 포함). */
  readonly radius: number;
  readonly priority: number;
  readonly color: string;
  /** 0.35 = 초점 밖, 1 = 초점 안/기본. */
  readonly alpha: number;
  /** 핵·허브·설명은 12.5px 밝게, 나머지는 11.5px/600 흐리게. */
  readonly strong: boolean;
}

/** 긴 제목은 잘라 그린다. */
export function truncateLabel(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = [...text];
  let cut = chars.length;
  while (cut > 1 && ctx.measureText(`${chars.slice(0, cut).join("")}…`).width > maxWidth) cut -= 1;
  return `${chars.slice(0, cut).join("")}…`;
}

/**
 * 라벨 배치 — 시안 `.gl-labels span`대로 pill 없이 글자에 바탕색 그림자(0 0 6px, 0 0 2px)를
 * 두르고 점 오른쪽 위에서 왼쪽 정렬로 그린다. 우선순위 순으로 놓고 겹치면 낮은 쪽을 버린다.
 */
export function drawMapLabels(
  ctx: CanvasRenderingContext2D,
  font: string,
  backdrop: MapRgb,
  candidates: readonly MapLabelCandidate[],
  width: number,
  height: number,
  maxTextWidth: number,
): void {
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const halo = rgbCss(backdrop, 0.9);
  const sorted = [...candidates].sort((a, b) => a.priority - b.priority);
  for (const candidate of sorted) {
    const size = candidate.strong ? MAP_LABEL_STRONG_SIZE : MAP_LABEL_SIZE;
    ctx.font = `600 ${size}px ${font}`;
    const text = truncateLabel(ctx, candidate.text, maxTextWidth);
    if (!text) continue;
    const textWidth = ctx.measureText(text).width;
    // 오른쪽 가장자리에서 잘리지 않게 점 왼쪽으로 자연스럽게 넘긴다.
    let x = candidate.x + candidate.radius + MAP_LABEL_OFFSET_X;
    if (x + textWidth + 6 > width) {
      x = Math.max(6, candidate.x - candidate.radius - MAP_LABEL_OFFSET_X - textWidth);
    }
    const y = Math.max(6, Math.min(height - size * 1.35, candidate.y - MAP_LABEL_OFFSET_Y));
    if (x < 2 || y < 0 || y > height || x > width - 2) continue;
    const rect = { x0: x - 1.5, y0: y - 1, x1: x + textWidth + 1.5, y1: y + size * 1.25 };
    const overlaps = placed.some((other) => rect.x0 < other.x1 && other.x0 < rect.x1 && rect.y0 < other.y1 && other.y0 < rect.y1);
    if (overlaps && candidate.priority >= 0) continue;
    placed.push(rect);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, candidate.alpha));
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.strokeStyle = halo;
    ctx.lineWidth = 3.2;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = candidate.color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }
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

export interface MapFitInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** `setFitInsets`를 주지 않는 쪽을 위한 기본 여백 — 칩·패널이 없는 무대. */
export const DEFAULT_MAP_INSETS: MapFitInsets = { top: 32, right: 32, bottom: 32, left: 32 };

/** 계약: 변마다 20%가 상한. 음수는 0으로 본다. */
export function clampMapInsets(insets: MapFitInsets, width: number, height: number): MapFitInsets {
  const capX = width * 0.2;
  const capY = height * 0.2;
  return {
    top: Math.max(0, Math.min(insets.top, capY)),
    bottom: Math.max(0, Math.min(insets.bottom, capY)),
    left: Math.max(0, Math.min(insets.left, capX)),
    right: Math.max(0, Math.min(insets.right, capX)),
  };
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
