export const EXTRA_WIDTH = 360;
export const TREE_PANE_DEFAULT_WIDTH = 248;
export const MIN_VIEWER_PX = 200;
export const MIN_TREE_PX = 160;
export const DIVIDER_WIDTH_PX = 4;

export function canResizeTreePane(containerWidth: number): boolean {
  return containerWidth - MIN_VIEWER_PX - DIVIDER_WIDTH_PX >= MIN_TREE_PX;
}

export function clampTreePaneWidth(startWidth: number, dx: number, containerWidth: number): number {
  const max = containerWidth - MIN_VIEWER_PX - DIVIDER_WIDTH_PX;
  if (max < MIN_TREE_PX) return startWidth;
  return Math.max(MIN_TREE_PX, Math.min(max, startWidth - dx));
}

export function buildSplitGridTemplate(treePaneWidth: number): string {
  const preservedViewerWidth = MIN_VIEWER_PX + DIVIDER_WIDTH_PX;
  return `minmax(0, 1fr) ${DIVIDER_WIDTH_PX}px minmax(0, min(${treePaneWidth}px, calc(100% - ${preservedViewerWidth}px)))`;
}

export function resolveExtraWidth(isViewerActive: boolean): number | null {
  return isViewerActive ? EXTRA_WIDTH : null;
}
