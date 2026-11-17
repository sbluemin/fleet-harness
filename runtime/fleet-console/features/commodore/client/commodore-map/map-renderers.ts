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
   * 용기에 그리기 시작. WebGL 컨텍스트는 1개만 만들고, 터미널 WebGL 코드는 건드리지 않는다.
   * 실패하면 throw하고 용기를 빈 채로 둔다 — 상위가 Canvas로 넘어간다.
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
  /**
   * 맞춤 보기 여백(CSS px, 위·오른쪽·아래·왼쪽) — 상세 패널·칩이 덮는 폭을 넘긴다.
   * 계약 밖 선택 사항이라 없어도 된다. 변마다 20%가 상한이다.
   */
  setFitInsets?(insets: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }): void;
  /** 닫을 때 — rAF·리스너를 걷고 WebGL 컨텍스트를 `loseContext`로 반납한다. */
  dispose(): void;
}

export type MapRendererKind = "webgl" | "canvas" | "orbit";

export interface MapRendererEnv {
  readonly webgl2: boolean;
  /** Console 설정의 동작 줄이기와 `prefers-reduced-motion`을 합친 값. */
  readonly reducedMotion: boolean;
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

/**
 * WebGL2 판정 — 컨텍스트를 만들지 않는다. 탐색용 생성이 터미널 컨텍스트를
 * 밀어낼 수 있으므로 생성자 존재만 본다. 실제 실패(블록리스트 등)는
 * WebGL 렌더러의 `mount`가 throw하고, 상위에서 Canvas로 넘어간다.
 */
export function probeWebgl2(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.WebGL2RenderingContext !== "undefined";
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

/** 지연 청크 자리 — 임무 3·4가 파일을 두면 위 switch가 살아난다. 빌드는 `@vite-ignore`로 넘긴다. */
const MAP_RENDERER_MODULE: Record<MapRendererKind, string> = {
  webgl: "./webgl/map-webgl-renderer.js",
  canvas: "./canvas/map-canvas-renderer.js",
  orbit: "./orbit/map-orbit-renderer.js",
};

/**
 * 고른 렌더러를 지연 청크로 받아 만든다.
 * TODO(임무 6 통합): 임무 3·4 파일이 들어오면 아래 switch의 주석을 떼고 사용한다.
 * 리터럴 경로라 각 렌더러가 자기 청크에 실린다.
 */
export async function loadMapRenderer(kind: MapRendererKind): Promise<MapRenderer> {
  switch (kind) {
    // case "webgl": return (await import("./webgl/map-webgl-renderer.js") as MapRendererModule).createMapRenderer();
    // case "canvas": return (await import("./canvas/map-canvas-renderer.js") as MapRendererModule).createMapRenderer();
    // case "orbit": return (await import("./orbit/map-orbit-renderer.js") as MapRendererModule).createMapRenderer();
    default: break;
  }
  const module = (await import(/* @vite-ignore */ MAP_RENDERER_MODULE[kind])) as MapRendererModule;
  return module.createMapRenderer();
}

/**
 * 생성+mount를 묶은 진입점 — 로드·mount 실패는 Canvas로 넘어간다.
 * Canvas마저 실패하면 throw한다(그때 화면은 안내만 둔다).
 */
export async function mountMapRenderer(
  kind: MapRendererKind,
  container: HTMLElement,
  model: PositionedMapModel,
  palette: MapPalette,
): Promise<{ readonly renderer: MapRenderer; readonly kind: MapRendererKind }> {
  if (kind === "canvas") {
    const only = await loadMapRenderer("canvas");
    only.mount(container, model, palette);
    return { renderer: only, kind };
  }
  try {
    const first = await loadMapRenderer(kind);
    try {
      first.mount(container, model, palette);
    } catch (mountError) {
      try { first.dispose(); } catch { /* 실패한 mount의 뒷정리도 실패하면 버린다 */ }
      throw mountError;
    }
    return { renderer: first, kind };
  } catch {
    const fallback = await loadMapRenderer("canvas");
    fallback.mount(container, model, palette);
    return { renderer: fallback, kind: "canvas" };
  }
}
