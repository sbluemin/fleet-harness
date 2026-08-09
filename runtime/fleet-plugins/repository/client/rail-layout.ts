// ─── 타입 ────────────────────────────────────────────────────────────────────

interface ListPaneWidthInput {
  readonly startWidth: number;
  readonly dx: number;
  readonly containerWidth: number;
  readonly listPaneMinWidth: number;
  readonly hunkPaneMinWidth: number;
  readonly dividerWidth: number;
}

interface PointerDragEventTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

interface PointerDragLifecycleInput {
  readonly documentTarget: PointerDragEventTarget;
  readonly windowTarget: PointerDragEventTarget;
  readonly onMove: (event: Event) => void;
  readonly onFinish: () => void;
}

// ─── 상수 ────────────────────────────────────────────────────────────────────

export const HUNK_PANE_MIN_WIDTH = 140;
export const HISTORY_LOG_PANE_MIN_HEIGHT = 120;
export const HISTORY_DETAIL_PANE_MIN_HEIGHT = 160;
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
  return Math.max(listPaneMinWidth, Math.min(maxWidth, startWidth + dx));
}

export function buildDiffGridTemplate(listPaneWidth: number): string {
  const preservedRightWidth = HUNK_PANE_MIN_WIDTH + DIFF_DIVIDER_WIDTH;
  return `minmax(0, min(${listPaneWidth}px, calc(100% - ${preservedRightWidth}px))) ${DIFF_DIVIDER_WIDTH}px minmax(0, 1fr)`;
}

export function buildHistoryStackTemplate(logPaneHeight: number): string {
  const preservedDetailHeight = HISTORY_DETAIL_PANE_MIN_HEIGHT + DIFF_DIVIDER_WIDTH;
  return `minmax(0, min(${logPaneHeight}px, calc(100% - ${preservedDetailHeight}px))) ${DIFF_DIVIDER_WIDTH}px minmax(0, 1fr)`;
}

export function clampSplitPaneSize(startSize: number, delta: number, containerSize: number, firstPaneMinSize: number, secondPaneMinSize: number, dividerWidth = DIFF_DIVIDER_WIDTH): number | null {
  const maxSize = containerSize - secondPaneMinSize - dividerWidth;
  if (maxSize < firstPaneMinSize) return NO_OP_SENTINEL;
  return Math.max(firstPaneMinSize, Math.min(maxSize, startSize + delta));
}

export function buildInspectorDetailsGridTemplate(headerHeight: number): string {
  return `minmax(120px, min(${headerHeight}px, calc(100% - 124px))) ${DIFF_DIVIDER_WIDTH}px minmax(120px, 1fr)`;
}

export function buildInspectorChangesGridTemplate(fileListWidth: number): string {
  return `minmax(120px, min(${fileListWidth}px, calc(100% - 144px))) ${DIFF_DIVIDER_WIDTH}px minmax(140px, 1fr)`;
}

export function installPointerDragLifecycle({ documentTarget, windowTarget, onMove, onFinish }: PointerDragLifecycleInput): () => void {
  let active = true;
  const removeListeners = () => {
    documentTarget.removeEventListener("pointermove", onMove);
    documentTarget.removeEventListener("pointerup", finish);
    documentTarget.removeEventListener("pointercancel", finish);
    windowTarget.removeEventListener("blur", finish);
  };
  const finish = () => {
    if (!active) return;
    active = false;
    removeListeners();
    onFinish();
  };
  const dispose = () => {
    if (!active) return;
    active = false;
    removeListeners();
  };

  documentTarget.addEventListener("pointermove", onMove);
  documentTarget.addEventListener("pointerup", finish);
  documentTarget.addEventListener("pointercancel", finish);
  windowTarget.addEventListener("blur", finish);
  return dispose;
}
