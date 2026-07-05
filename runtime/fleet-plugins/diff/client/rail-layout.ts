// ─── 타입 ────────────────────────────────────────────────────────────────────

interface ListPaneWidthInput {
  readonly startWidth: number;
  readonly dx: number;
  readonly containerWidth: number;
  readonly listPaneMinWidth: number;
  readonly hunkPaneMinWidth: number;
  readonly dividerWidth: number;
}

// ─── 상수 ────────────────────────────────────────────────────────────────────

export const HUNK_PANE_MIN_WIDTH = 140;
export const DIFF_DIVIDER_WIDTH = 4;

const NO_OP_SENTINEL = null;

// ─── 함수 ────────────────────────────────────────────────────────────────────

export function clampListPaneWidth({
  startWidth,
  dx,
  containerWidth,
  listPaneMinWidth,
  hunkPaneMinWidth,
  dividerWidth,
}: ListPaneWidthInput): number | null {
  const maxWidth = containerWidth - hunkPaneMinWidth - dividerWidth;
  if (maxWidth < listPaneMinWidth) return NO_OP_SENTINEL;
  return Math.max(listPaneMinWidth, Math.min(maxWidth, startWidth - dx));
}

export function buildDiffGridTemplate(listPaneWidth: number): string {
  const preservedLeftWidth = HUNK_PANE_MIN_WIDTH + DIFF_DIVIDER_WIDTH;
  return `minmax(0, 1fr) ${DIFF_DIVIDER_WIDTH}px minmax(0, min(${listPaneWidth}px, calc(100% - ${preservedLeftWidth}px)))`;
}
