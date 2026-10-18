import type { WorkbenchLayout, WorkbenchStack, WorkbenchTile } from "../../../shared/conversation-workbench.js";

import type { WorkbenchDropTarget } from "./workbench-store.js";

/**
 * 작업대 기하 — 왼쪽·오른쪽 사이드바 사이, 맨 위 줄 아래(작업 영역) 안에서 대화·분할 영역·아래 줄·칸의 자리를 정한다. 순수 함수다.
 *
 * 좌표는 작업 영역의 왼쪽 위가 원점이다. 칸은 모두 한 층에 절대 배치되므로(작업대 레이어), 자리를 옮기거나 펼쳐도 칸의 DOM 은
 * 그대로다 — Shell·브라우저가 다시 서지 않는다.
 *
 * 좁을 때 물러나는 순서(시안 규칙 h, 사람이 고른 답: 도구 분할이 먼저 물러남)
 *   1. 나란히 둔 열을 한 열로 쌓는다(배치는 기억한다 — 넓히면 돌아온다).
 *   2. 그래도 모자라면 도구 분할이 대화 위에 뜨는 시트가 된다. 오른쪽 사이드바 열은 그대로다.
 */

/** 대화 열이 지키는 최소 폭(시안 규칙 d). */
export const WORKBENCH_CONVERSATION_MIN = 360;
/** 도구 한 열의 최소 폭(시안 규칙 h). */
export const WORKBENCH_COLUMN_MIN = 300;
/** 칸과 칸, 칸과 대화 사이의 틈. */
export const WORKBENCH_GAP = 8;
/** 작업 영역 가장자리의 여백. */
export const WORKBENCH_PAD = 8;
const ROW_MIN = 120;
const BELOW_MIN = 160;
const CONVERSATION_MIN_HEIGHT = 240;
const SHEET_EDGE = 24;
export const DEFAULT_SPLIT_RATIO = 0.42;
export const DEFAULT_BELOW_RATIO = 0.36;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type WorkbenchMode = "none" | "side" | "stacked" | "sheet";

export interface TileGeometry {
  readonly tile: WorkbenchTile;
  readonly rect: Rect;
  readonly area: "column" | "below";
  /** 화면에 선 열 번호(쌓인 모드에서는 0). */
  readonly column: number;
  readonly index: number;
  /** 배치(저장된 모양)에서의 자리 — 쌓인 동안에도 원래 열·칸 번호다. 놓을 자리는 이 값으로 말한다. */
  readonly place: { readonly column: number; readonly index: number };
}

/** 끌어 비율을 바꾸는 자리. */
export type GutterGeometry =
  | { readonly kind: "split"; readonly rect: Rect }
  | { readonly kind: "below"; readonly rect: Rect }
  | { readonly kind: "columns"; readonly rect: Rect; readonly index: number }
  | { readonly kind: "column"; readonly rect: Rect; readonly column: number; readonly index: number }
  | { readonly kind: "below-tiles"; readonly rect: Rect; readonly index: number };

export interface WorkbenchGeometry {
  readonly mode: WorkbenchMode;
  readonly width: number;
  readonly height: number;
  /** 대화 칸(.conversation-stage)이 작업 영역 오른쪽·아래에서 비켜 줄 폭·높이. */
  readonly conversationRight: number;
  readonly conversationBottom: number;
  /** 분할 영역(틈·여백 포함). 칸이 없으면 null. */
  readonly split: Rect | null;
  readonly splitWidth: number;
  readonly splitMin: number;
  readonly splitMax: number;
  readonly below: Rect | null;
  readonly tiles: readonly TileGeometry[];
  readonly gutters: readonly GutterGeometry[];
  /** 펼친 칸의 자리 — 대화와 분할 영역 전체. */
  readonly expanded: Rect | null;
  /** 열이 화면에서 쌓였는가(물러남 1단계 이상). 쌓인 동안 열 사이 끌기는 없다. */
  readonly collapsedColumns: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 가중치대로 나누되 각 몫이 min 아래로 내려가지 않게 한다(모자라면 고르게 나눈다). */
export function distribute(total: number, weights: readonly number[], min: number): number[] {
  const count = weights.length;
  if (count === 0) return [];
  if (total <= min * count) return weights.map(() => Math.max(0, total / count));
  const sizes = new Array<number>(count).fill(0);
  const fixed = new Set<number>();
  for (let round = 0; round < count; round += 1) {
    const free = weights.reduce((sum, weight, index) => (fixed.has(index) ? sum : sum + weight), 0);
    const remaining = total - [...fixed].reduce((sum) => sum + min, 0);
    let changed = false;
    weights.forEach((weight, index) => {
      if (fixed.has(index)) { sizes[index] = min; return; }
      sizes[index] = free > 0 ? remaining * (weight / free) : remaining / (count - fixed.size);
    });
    weights.forEach((_, index) => {
      if (!fixed.has(index) && sizes[index]! < min) { fixed.add(index); changed = true; }
    });
    if (!changed) break;
  }
  return sizes.map((size, index) => (fixed.has(index) ? min : size));
}

function minSplitWidth(columns: number): number {
  return columns * WORKBENCH_COLUMN_MIN + Math.max(0, columns - 1) * WORKBENCH_GAP + WORKBENCH_GAP + WORKBENCH_PAD;
}

function flatten(layout: WorkbenchLayout): WorkbenchStack {
  const tiles = layout.columns.flatMap((column) => column.tiles);
  const weights = layout.columns.flatMap((column) => column.weights);
  return { tiles, weights };
}

export function computeWorkbenchGeometry(layout: WorkbenchLayout, width: number, height: number): WorkbenchGeometry {
  const tiles: TileGeometry[] = [];
  const gutters: GutterGeometry[] = [];
  const columnCount = layout.columns.length;
  const hasBelow = layout.below.tiles.length > 0;
  let mode: WorkbenchMode = "none";
  let splitWidth = 0;
  let split: Rect | null = null;
  const splitMax = Math.max(0, width - WORKBENCH_CONVERSATION_MIN);
  let splitMin = minSplitWidth(1);
  const ratio = layout.splitRatio ?? DEFAULT_SPLIT_RATIO;
  if (columnCount > 0) {
    if (splitMax >= minSplitWidth(columnCount)) {
      mode = "side";
      splitMin = minSplitWidth(columnCount);
      splitWidth = clamp(Math.round(ratio * width), splitMin, splitMax);
    } else if (splitMax >= minSplitWidth(1)) {
      mode = "stacked";
      splitWidth = clamp(Math.round(ratio * width), minSplitWidth(1), splitMax);
    } else {
      mode = "sheet";
      splitWidth = Math.max(0, Math.min(width - SHEET_EDGE, Math.max(minSplitWidth(1), Math.round(ratio * width))));
    }
    split = { x: width - splitWidth, y: 0, w: splitWidth, h: height };
  }
  const conversationRight = mode === "side" || mode === "stacked" ? splitWidth : 0;
  const conversationWidth = width - conversationRight;

  // 아래 줄 — 대화 열 밑. 대화가 최소 높이를 지키는 만큼만 차지한다.
  let below: Rect | null = null;
  let conversationBottom = 0;
  if (hasBelow) {
    const belowRatio = layout.belowRatio ?? DEFAULT_BELOW_RATIO;
    const belowHeight = clamp(Math.round(belowRatio * height), BELOW_MIN, Math.max(BELOW_MIN, height - CONVERSATION_MIN_HEIGHT));
    conversationBottom = belowHeight;
    below = { x: 0, y: height - belowHeight, w: conversationWidth, h: belowHeight };
    const inner: Rect = {
      x: WORKBENCH_PAD,
      y: below.y + WORKBENCH_GAP,
      w: Math.max(0, conversationWidth - WORKBENCH_PAD - (conversationRight > 0 ? 0 : WORKBENCH_PAD)),
      h: Math.max(0, belowHeight - WORKBENCH_GAP - WORKBENCH_PAD),
    };
    const count = layout.below.tiles.length;
    const sizes = distribute(inner.w - (count - 1) * WORKBENCH_GAP, layout.below.weights, WORKBENCH_COLUMN_MIN / 2);
    let x = inner.x;
    layout.below.tiles.forEach((tile, index) => {
      const w = sizes[index]!;
      tiles.push({ tile, rect: { x, y: inner.y, w, h: inner.h }, area: "below", column: 0, index, place: { column: 0, index } });
      if (index < count - 1) gutters.push({ kind: "below-tiles", index, rect: { x: x + w, y: inner.y, w: WORKBENCH_GAP, h: inner.h } });
      x += w + WORKBENCH_GAP;
    });
    gutters.push({ kind: "below", rect: { x: inner.x, y: below.y, w: inner.w, h: WORKBENCH_GAP } });
  }

  // 분할 영역 — 왼쪽 틈(대화와의 경계)은 끌기 자리다.
  const collapsedColumns = mode === "stacked" || mode === "sheet";
  if (split !== null) {
    const sheet = mode === "sheet";
    const inner: Rect = {
      x: split.x + (sheet ? WORKBENCH_PAD : WORKBENCH_GAP),
      y: split.y + WORKBENCH_PAD,
      w: Math.max(0, split.w - (sheet ? WORKBENCH_PAD * 2 : WORKBENCH_GAP + WORKBENCH_PAD)),
      h: Math.max(0, split.h - WORKBENCH_PAD * 2),
    };
    gutters.push({ kind: "split", rect: { x: split.x, y: 0, w: sheet ? WORKBENCH_PAD : WORKBENCH_GAP, h: height } });
    const columns: readonly WorkbenchStack[] = collapsedColumns ? [flatten(layout)] : layout.columns;
    const origins = layout.columns.flatMap((column, columnIndex) => column.tiles.map((_, index) => ({ column: columnIndex, index })));
    const columnWeights = collapsedColumns ? [1] : layout.columnWeights;
    const widths = distribute(inner.w - (columns.length - 1) * WORKBENCH_GAP, columnWeights, WORKBENCH_COLUMN_MIN);
    let x = inner.x;
    columns.forEach((column, columnIndex) => {
      const w = widths[columnIndex]!;
      const heights = distribute(inner.h - (column.tiles.length - 1) * WORKBENCH_GAP, column.weights, ROW_MIN);
      let y = inner.y;
      column.tiles.forEach((tile, index) => {
        const h = heights[index]!;
        const place = collapsedColumns ? origins[index]! : { column: columnIndex, index };
        tiles.push({ tile, rect: { x, y, w, h }, area: "column", column: columnIndex, index, place });
        if (index < column.tiles.length - 1 && !collapsedColumns) gutters.push({ kind: "column", column: columnIndex, index, rect: { x, y: y + h, w, h: WORKBENCH_GAP } });
        y += h + WORKBENCH_GAP;
      });
      if (columnIndex < columns.length - 1) gutters.push({ kind: "columns", index: columnIndex, rect: { x: x + w, y: inner.y, w: WORKBENCH_GAP, h: inner.h } });
      x += w + WORKBENCH_GAP;
    });
  }

  const expanded = layout.expandedTileId !== null && tiles.some((entry) => entry.tile.id === layout.expandedTileId)
    ? { x: WORKBENCH_PAD, y: WORKBENCH_PAD, w: Math.max(0, width - WORKBENCH_PAD * 2), h: Math.max(0, height - WORKBENCH_PAD * 2) }
    : null;

  return {
    mode,
    width,
    height,
    conversationRight,
    conversationBottom,
    split,
    splitWidth,
    splitMin,
    splitMax,
    below,
    tiles,
    gutters,
    expanded,
    collapsedColumns,
  };
}

/** 끄는 칸을 놓을 자리와 그 미리보기. 놓을 수 없는 자리면 null. */
export interface DropPreview {
  readonly target: WorkbenchDropTarget;
  readonly rect: Rect;
}

const EDGE_SHARE = 0.32;

/**
 * 포인터 아래의 놓을 자리 — 칸 위면 가장 가까운 가장자리 쪽(위·아래는 같은 열, 왼쪽·오른쪽은 새 열), 대화 위면 아래쪽은 「대화 아래」,
 * 오른쪽 가장자리는 첫 열 앞의 새 열이다. 열이 쌓인 동안(물러남)에는 열 단위 자리를 내지 않는다.
 */
export function resolveDropPreview(geometry: WorkbenchGeometry, draggedId: string, x: number, y: number): DropPreview | null {
  for (const entry of geometry.tiles) {
    const { rect } = entry;
    if (x < rect.x || x > rect.x + rect.w || y < rect.y || y > rect.y + rect.h) continue;
    if (entry.tile.id === draggedId) return null;
    const rx = (x - rect.x) / Math.max(1, rect.w);
    const ry = (y - rect.y) / Math.max(1, rect.h);
    if (entry.area === "below") {
      const before = rx < 0.5;
      return {
        target: { area: "below", index: entry.index + (before ? 0 : 1) },
        rect: before ? { ...rect, w: rect.w / 2 } : { ...rect, x: rect.x + rect.w / 2, w: rect.w / 2 },
      };
    }
    const edges = [
      { side: "top", distance: ry },
      { side: "bottom", distance: 1 - ry },
      ...(geometry.collapsedColumns ? [] : [{ side: "left", distance: rx }, { side: "right", distance: 1 - rx }]),
    ].sort((a, b) => a.distance - b.distance);
    const side = edges[0]!.side;
    const { place } = entry;
    if (side === "top") return { target: { area: "column", column: place.column, index: place.index }, rect: { ...rect, h: rect.h * EDGE_SHARE * 1.5 } };
    if (side === "bottom") return { target: { area: "column", column: place.column, index: place.index + 1 }, rect: { ...rect, y: rect.y + rect.h * (1 - EDGE_SHARE * 1.5), h: rect.h * EDGE_SHARE * 1.5 } };
    if (side === "left") return { target: { area: "new-column", at: place.column }, rect: { ...rect, w: rect.w * EDGE_SHARE * 1.5 } };
    return { target: { area: "new-column", at: place.column + 1 }, rect: { ...rect, x: rect.x + rect.w * (1 - EDGE_SHARE * 1.5), w: rect.w * EDGE_SHARE * 1.5 } };
  }
  const conversationWidth = geometry.width - geometry.conversationRight;
  const conversationHeight = geometry.height - geometry.conversationBottom;
  if (x < 0 || x > conversationWidth || y < 0 || y > geometry.height) return null;
  if (y > conversationHeight * 0.62) {
    const top = Math.max(conversationHeight * 0.62, conversationHeight - geometry.height * DEFAULT_BELOW_RATIO);
    return { target: { area: "below", index: Number.MAX_SAFE_INTEGER }, rect: { x: WORKBENCH_PAD, y: top, w: conversationWidth - WORKBENCH_PAD * 2, h: geometry.height - top - WORKBENCH_PAD } };
  }
  if (!geometry.collapsedColumns && x > conversationWidth - 120) {
    return { target: { area: "new-column", at: 0 }, rect: { x: conversationWidth - 160, y: WORKBENCH_PAD, w: 152, h: geometry.height - WORKBENCH_PAD * 2 } };
  }
  return null;
}
