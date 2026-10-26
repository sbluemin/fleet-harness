import { useRef, type KeyboardEvent, type PointerEvent } from "react";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { requestObjectiveKeyboardFocus, revealObjectiveStage, setActiveObjective } from "../../../../core/client/src/integration/store.js";
import { closeConversationSurface } from "./conversation-surface-store.js";
import { COMMANDER_SPLIT_MAX_RATIO, COMMANDER_SPLIT_MIN_RATIO, setCommanderSplitRatio } from "./commander-split-store.js";

/** 칸마다 남길 최소 폭과 손잡이 폭. 둘을 다 담지 못하는 창에서는 한 칸만 선다. */
const COMMANDER_SPLIT_PANE_MIN_PX = 320;
const COMMANDER_SPLIT_DIVIDER_PX = 9;
export const COMMANDER_SPLIT_MIN_STAGE_PX = COMMANDER_SPLIT_PANE_MIN_PX * 2 + COMMANDER_SPLIT_DIVIDER_PX;
const KEY_STEP = 0.05;

export interface CommanderSplitBounds {
  readonly min: number;
  readonly max: number;
}

/** 지금 가운데 폭에서 사령관 칸 비율이 갈 수 있는 범위 — 저장 범위(0.3–0.7) 안에서 두 칸 모두 최소 폭을 지킨다. */
export function commanderSplitBounds(stageWidth: number): CommanderSplitBounds {
  if (stageWidth <= 0) return { min: COMMANDER_SPLIT_MIN_RATIO, max: COMMANDER_SPLIT_MAX_RATIO };
  const min = Math.max(COMMANDER_SPLIT_MIN_RATIO, COMMANDER_SPLIT_PANE_MIN_PX / stageWidth);
  const max = Math.min(COMMANDER_SPLIT_MAX_RATIO, 1 - (COMMANDER_SPLIT_PANE_MIN_PX + COMMANDER_SPLIT_DIVIDER_PX) / stageWidth);
  return min <= max ? { min, max } : { min: 0.5, max: 0.5 };
}

export function clampToCommanderSplitBounds(ratio: number, bounds: CommanderSplitBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, ratio));
}

/** 옆 칸의 지휘관을 가운데 칸 전체로 연다 — 사이드바에서 지휘관을 고르던 기존 길과 같다. 분할의 열림 기억은 그대로다. */
export function expandCommanderSplit(objectiveId: string): void {
  revealObjectiveStage();
  closeConversationSurface();
  setActiveObjective(objectiveId);
  requestObjectiveKeyboardFocus(objectiveId);
}

/**
 * 사령관 대화와 지휘관 대화 사이 손잡이 — 끌기·←/→·두 번 누르기(반반)로 비율을 바꾼다. 끄는 동안은 화면만 따라가고 놓을 때 한 번 저장한다.
 */
export function CommanderSplitDivider({ ratio, bounds }: { readonly ratio: number; readonly bounds: CommanderSplitBounds }) {
  const t = useT();
  const dragRef = useRef<{ readonly pointerId: number; readonly left: number; readonly width: number; last: number } | null>(null);
  const container = (element: HTMLElement) => element.parentElement;
  const clamp = (value: number) => clampToCommanderSplitBounds(value, bounds);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const parent = container(event.currentTarget);
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    if (rect.width <= 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, left: rect.left, width: rect.width, last: ratio };
    event.currentTarget.dataset.dragging = "true";
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.last = clamp((event.clientX - drag.left) / drag.width);
    container(event.currentTarget)?.style.setProperty("--commander-split-left", `${(drag.last * 100).toFixed(2)}%`);
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    delete event.currentTarget.dataset.dragging;
    setCommanderSplitRatio(drag.last);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setCommanderSplitRatio(clamp(ratio + (event.key === "ArrowLeft" ? -KEY_STEP : KEY_STEP)));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setCommanderSplitRatio(event.key === "Home" ? bounds.min : bounds.max);
    }
  };
  return (
    <div
      className="conversation-split-divider"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t("conversation.commanderSplit.divider")}
      aria-valuemin={Math.round(bounds.min * 100)}
      aria-valuemax={Math.round(bounds.max * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      title={t("conversation.commanderSplit.dividerTip")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={() => setCommanderSplitRatio(clamp(0.5))}
      onKeyDown={onKeyDown}
    />
  );
}

/** 분할은 열려 있는데 이 사령관에서 고른 지휘관이 없을 때(처음이거나 보관됐을 때) 옆 칸 자리. */
export function CommanderSplitPlaceholder({ onClose }: { readonly onClose: () => void }) {
  const t = useT();
  return (
    <div className="conversation-column conversation-split-empty">
      <div className="conversation-pill-row">
        <span className="conversation-split-controls">
          <button type="button" className="conversation-split-control" onClick={onClose} aria-label={t("conversation.commanderSplit.close")} title={t("conversation.commanderSplit.close")}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        </span>
      </div>
      <div className="conversation-empty">
        <span>{t("conversation.commanderSplit.empty")}</span>
      </div>
    </div>
  );
}
