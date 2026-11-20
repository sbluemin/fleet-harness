import type { MapGraph } from "./map-graph.js";
import type { MapLayout } from "./map-layout.js";
import type { MapPalette } from "./map-palette.js";

/**
 * 렌더러 계약 — three.js(WebGL)·궤도(휴대폰)가 함께 지킨다.
 */

export interface PositionedMapModel {
  readonly graph: MapGraph;
  readonly layout: MapLayout;
}

export interface MapRenderer {
  /**
   * 용기에 그리기 시작. WebGL 컨텍스트는 1개만 만들고, 터미널 WebGL 코드는 건드리지 않는다.
   * 실패하면 throw하고 용기를 빈 채로 둔다.
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
   * 보기가 바뀌면 알린다(끌기·휠·맞춤 트윈·크기 변경). 화면 DOM 층이 project를 다시 읽는다.
   * 없어도 된다 — 그때 화면은 제스처 동안만 따라간다. 리스너는 project만 읽고 렌더러를 건드리지 않는다.
   */
  onViewChange?(listener: () => void): () => void;
  /**
   * 맞춤 보기 여백(CSS px, 위·오른쪽·아래·왼쪽) — 상세 패널·칩이 덮는 폭을 넘긴다.
   * 계약 밖 선택 사항이라 없어도 된다. 변마다 20%가 상한이다.
   */
  setFitInsets?(insets: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }): void;
  /** 동작 줄이기 전환 — 맥동과 맞춤 트윈을 멈춘다. */
  setReducedMotion?(reduced: boolean): void;
  /** 닫을 때 — rAF·리스너를 걷고 WebGL 컨텍스트를 `loseContext`로 반납한다. */
  dispose(): void;
}

export type MapRendererKind = "webgl" | "orbit";

export interface MapRendererEnv {
  readonly mobile: boolean;
}

/**
 * 렌더러 고르기 — 휴대폰→궤도, 그 외 WebGL.
 * 렌더러를 import하지 않는 순수 함수다.
 */
export function chooseMapRendererKind(env: MapRendererEnv): MapRendererKind {
  return env.mobile ? "orbit" : "webgl";
}

/**
 * 지금 환경 읽기 — 휴대폰은 루트 `data-view-mode="mobile"`로만 본다(폭·포인터로 추측하지 않음).
 */
export function detectMapRendererEnv(): MapRendererEnv {
  const mobile = typeof document !== "undefined"
    && document.documentElement.getAttribute("data-view-mode") === "mobile";
  return { mobile };
}

export interface MapRendererModule {
  readonly createMapRenderer: () => MapRenderer;
}

/**
 * 고른 렌더러를 지연 청크로 받아 만든다. 리터럴 경로라 각 렌더러가 자기 청크에 실린다.
 */
export async function loadMapRenderer(kind: MapRendererKind): Promise<MapRenderer> {
  switch (kind) {
    case "webgl": return (await import("./webgl/map-webgl-renderer.js") as MapRendererModule).createMapRenderer();
    case "orbit": return (await import("./orbit/map-orbit-renderer.js") as MapRendererModule).createMapRenderer();
  }
}

/**
 * 생성+mount를 묶은 진입점 — mount가 실패하면 뒷정리 후 throw한다(화면은 안내만 둔다).
 */
export async function mountMapRenderer(
  kind: MapRendererKind,
  container: HTMLElement,
  model: PositionedMapModel,
  palette: MapPalette,
): Promise<{ readonly renderer: MapRenderer; readonly kind: MapRendererKind }> {
  const renderer = await loadMapRenderer(kind);
  try {
    renderer.mount(container, model, palette);
  } catch (mountError) {
    try { renderer.dispose(); } catch { /* 실패한 mount의 뒷정리도 실패하면 버린다 */ }
    throw mountError;
  }
  return { renderer, kind };
}
