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
