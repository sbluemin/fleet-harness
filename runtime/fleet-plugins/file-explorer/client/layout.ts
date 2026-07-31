export const EXTRA_WIDTH = 360;
export const TREE_PANE_DEFAULT_WIDTH = 248;
export const MIN_VIEWER_PX = 200;
export const MIN_TREE_PX = 160;
export const DIVIDER_WIDTH_PX = 4;
export const DIVIDER_KEYBOARD_STEP_PX = 16;

export function canResizeTreePane(containerWidth: number): boolean {
  return containerWidth - MIN_VIEWER_PX - DIVIDER_WIDTH_PX >= MIN_TREE_PX;
}

export function getTreePaneMaxWidth(containerWidth: number): number {
  return Math.max(MIN_TREE_PX, containerWidth - MIN_VIEWER_PX - DIVIDER_WIDTH_PX);
}

export function getTreePaneWidthForContainer(treePaneWidth: number, containerWidth: number): number {
  return Math.max(MIN_TREE_PX, Math.min(Math.floor(getTreePaneMaxWidth(containerWidth)), Math.round(treePaneWidth)));
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
