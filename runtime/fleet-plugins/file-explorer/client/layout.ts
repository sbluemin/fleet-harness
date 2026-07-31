export const EXTRA_WIDTH = 360;
export const TREE_PANE_DEFAULT_WIDTH = 248;
export const MIN_VIEWER_PX = 200;
export const MIN_TREE_PX = 160;
export const DIVIDER_WIDTH_PX = 4;
export const DIVIDER_KEYBOARD_STEP_PX = 16;

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

export function resolveExtraWidth(isViewerActive: boolean): number | null {
  return isViewerActive ? EXTRA_WIDTH : null;
}
