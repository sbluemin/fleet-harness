import type { MapGraph } from "./map-graph.js";
import type { MapLayout } from "./map-layout.js";
import type { MapPalette } from "./map-palette.js";

/**
 * 렌더러 계약 — three.js(안 D)·Canvas 2D(안 B)·궤도(안 C)가 함께 지킨다.
 * 임무 3·4가 이 파일만 보고 각 렌더러를 붙인다.
 */

export interface PositionedMapModel {
  readonly graph: MapGraph;
  readonly layout: MapLayout;
}

export interface MapRenderer {
  /**
   * 용기에 그리기 시작. WebGL 렌더러는 컨텍스트를 1개만 만들고,
   * `terminal-webgl-budget.ts`는 손대지 않는다(다른 목표가 제거 중).
   */
  mount(container: HTMLElement, model: PositionedMapModel, palette: MapPalette): void;
  /** 모델·팔레트(테마 전환) 갈아끼우기 — 다시 mount하지 않는다. */
  update(model: PositionedMapModel, palette: MapPalette): void;
  setSelection(id: string | null): void;
  setHover(id: string | null): void;
  /** 보이는 노드 id 집합 — 갈래·검색이 가린 점은 그리지 않고 고르지도 않는다. */
  setFilter(visible: ReadonlySet<string>): void;
  /**
   * 고르기 — 용기 기준 CSS px. 반경은 보이는 크기(노드 size×배율)다.
   * 맞은 점이 없으면 null.
   */
  pick(x: number, y: number): string | null;
  /** DOM 버튼 층 자리 — 용기 기준 CSS px, 뒤·밖이면 visible false. */
  project(id: string): { readonly x: number; readonly y: number; readonly visible: boolean } | null;
  /** 맞춤 보기 — 라벨·패널 여백을 포함한 bounds가 들어오게 맞춘다. */
  fit(): void;
  /** 닫을 때 — rAF·리스너를 걷고 WebGL 컨텍스트를 `loseContext`로 반납한다. */
  dispose(): void;
}

export type MapRendererKind = "webgl" | "canvas" | "orbit";

export interface MapRendererEnv {
  readonly webgl2: boolean;
  readonly reducedMotion: boolean;
  /** Console 설정의 동작 줄이기와 `prefers-reduced-motion`을 합친 값. */
  readonly mobile: boolean;
}

/**
 * 렌더러 고르기 — WebGL2 없음·동작 줄이기→B(Canvas), 휴대폰→C(궤도), 그 외 D(WebGL).
 * 렌더러를 import하지 않는 순수 함수라 임무 3·4와 무관하게 검사된다.
 */
export function chooseMapRendererKind(env: MapRendererEnv): MapRendererKind {
  if (env.mobile) return "orbit";
  if (!env.webgl2 || env.reducedMotion) return "canvas";
  return "webgl";
}

/** WebGL2 탐색 — 만들면 곧바로 `loseContext`로 내놓는다(예산 16개 중 1개를 묵히지 않게). */
export function probeWebgl2(): boolean {
  try {
    if (typeof document === "undefined") return false;
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/**
 * 지금 환경 읽기 — `reducedMotion`은 Console 전역 설정값을 `overrides`로 합친다.
 * 휴대폰은 루트 `data-view-mode="mobile"`로만 본다(폭·포인터로 추측하지 않음).
 */
export function detectMapRendererEnv(overrides: { readonly reducedMotion?: boolean } = {}): MapRendererEnv {
  const media = typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mobile = typeof document !== "undefined"
    && document.documentElement.getAttribute("data-view-mode") === "mobile";
  return {
    webgl2: probeWebgl2(),
    reducedMotion: media || overrides.reducedMotion === true,
    mobile,
  };
}

export interface MapRendererModule {
  readonly createMapRenderer: () => MapRenderer;
}

/** 지연 청크 자리 — 임무 3·4가 파일을 두면 이 표만 살아난다. 빌드는 `@vite-ignore`로 넘긴다. */
const MAP_RENDERER_MODULE: Record<MapRendererKind, string> = {
  webgl: "./webgl/map-webgl-renderer.js",
  canvas: "./canvas/map-canvas-renderer.js",
  orbit: "./orbit/map-orbit-renderer.js",
};

/** 고른 렌더러를 지연 청크로 받아 만든다. 파일이 아직 없어 임무 3·4 전에는 실패한다. */
export async function loadMapRenderer(kind: MapRendererKind): Promise<MapRenderer> {
  const module = (await import(/* @vite-ignore */ MAP_RENDERER_MODULE[kind])) as MapRendererModule;
  return module.createMapRenderer();
}
