export const TREE_PANE_DEFAULT_WIDTH = 248;
export const MIN_VIEWER_PX = 200;
export const MIN_TREE_PX = 160;
export const DIVIDER_WIDTH_PX = 4;
export const DIVIDER_KEYBOARD_STEP_PX = 16;
export const CHIP_STRIP_GAP_PX = 4;
/**
 * Host extra-width clamp: `Math.min(requested, innerWidth - 548)`.
 * Extra is taken from that remaining viewport, not a fixed 360px.
 */
export const HOST_EXTRA_WIDTH_CLAMP_PX = 548;
/**
 * 문서를 여는 순간 요청하는 추가 폭의 비율과 상·하한.
 * 창을 무시한 고정 360px이 넓은 창에서 캔버스를 놀리던 것이 원래 문제였지만(실측 1280창에서 561px 유휴),
 * 남은 뷰포트를 전부 달라고 하면 반대쪽으로 같은 실수를 한다 — 캔버스가 190px만 남는다.
 * 그래서 창의 일정 비율만 요청하고, 좁은 창에서는 하한이, 넓은 창에서는 상한이 판을 잡는다.
 */
const EXTRA_WIDTH_VIEWPORT_RATIO = 0.3;
const EXTRA_WIDTH_MIN_PX = 320;
export const EXTRA_WIDTH_MAX_PX = 720;

export interface TreePaneSeparatorState {
  readonly currentWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly canResize: boolean;
  readonly tabIndex: 0 | -1;
  readonly ariaDisabled: true | undefined;
}

export function canResizeTreePane(containerWidth: number): boolean {
  return getTreePaneMaxWidth(containerWidth) > MIN_TREE_PX;
}

export function getTreePaneMaxWidth(containerWidth: number): number {
  return Math.max(0, Math.floor(containerWidth - MIN_VIEWER_PX - DIVIDER_WIDTH_PX));
}

export function getTreePaneWidthForContainer(treePaneWidth: number, containerWidth: number): number {
  const maxWidth = getTreePaneMaxWidth(containerWidth);
  if (maxWidth <= MIN_TREE_PX) return maxWidth;
  return Math.max(MIN_TREE_PX, Math.min(maxWidth, Math.round(treePaneWidth)));
}

export function getTreePaneSeparatorState(
  treePaneWidth: number,
  containerWidth: number,
): TreePaneSeparatorState {
  const maxWidth = getTreePaneMaxWidth(containerWidth);
  const canResize = canResizeTreePane(containerWidth);
  const currentWidth = getTreePaneWidthForContainer(treePaneWidth, containerWidth);
  return {
    currentWidth,
    minWidth: canResize ? MIN_TREE_PX : currentWidth,
    maxWidth,
    canResize,
    tabIndex: canResize ? 0 : -1,
    ariaDisabled: canResize ? undefined : true,
  };
}

export function clampTreePaneWidth(startWidth: number, dx: number, containerWidth: number): number {
  if (!canResizeTreePane(containerWidth)) return startWidth;
  const max = getTreePaneMaxWidth(containerWidth);
  return Math.max(MIN_TREE_PX, Math.min(max, startWidth - dx));
}

export function resizeTreePaneWithKeyboard(startWidth: number, key: string, containerWidth: number): number {
  if (key !== "ArrowLeft" && key !== "ArrowRight") return startWidth;
  if (!canResizeTreePane(containerWidth)) return startWidth;
  const currentWidth = getTreePaneWidthForContainer(startWidth, containerWidth);
  const pointerEquivalentDx = key === "ArrowLeft" ? -DIVIDER_KEYBOARD_STEP_PX : DIVIDER_KEYBOARD_STEP_PX;
  return getTreePaneWidthForContainer(
    clampTreePaneWidth(currentWidth, pointerEquivalentDx, containerWidth),
    containerWidth,
  );
}

export function buildSplitGridTemplate(treePaneWidth: number): string {
  const preservedViewerWidth = MIN_VIEWER_PX + DIVIDER_WIDTH_PX;
  return `minmax(0, 1fr) ${DIVIDER_WIDTH_PX}px minmax(0, min(${treePaneWidth}px, calc(100% - ${preservedViewerWidth}px)))`;
}

export function resolveExtraWidth(isViewerActive: boolean, viewportWidth: number): number | null {
  if (!isViewerActive) return null;
  if (!Number.isFinite(viewportWidth)) return 0;
  // 호스트도 innerWidth-548로 다시 자르므로, 여기서는 "얼마면 충분한가"만 말한다.
  const remaining = Math.max(0, Math.round(viewportWidth - HOST_EXTRA_WIDTH_CLAMP_PX));
  const proportional = Math.round(viewportWidth * EXTRA_WIDTH_VIEWPORT_RATIO);
  const desired = Math.min(EXTRA_WIDTH_MAX_PX, Math.max(EXTRA_WIDTH_MIN_PX, proportional));
  return Math.min(remaining, desired);
}

/** Chips whose box is not fully inside the visible strip. */
export function countOverflowingChips(
  containerWidth: number,
  scrollLeft: number,
  itemWidths: readonly number[],
  gap: number = CHIP_STRIP_GAP_PX,
): number {
  if (containerWidth <= 0 || itemWidths.length === 0) return 0;
  const viewLeft = scrollLeft;
  const viewRight = scrollLeft + containerWidth;
  let x = 0;
  let hidden = 0;
  for (const width of itemWidths) {
    const left = x;
    const right = x + width;
    if (left + 0.5 < viewLeft || right - 0.5 > viewRight) hidden += 1;
    x += width + gap;
  }
  return hidden;
}
