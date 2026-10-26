import { useEffect, useMemo, useReducer, useRef, type KeyboardEvent, type PointerEvent } from "react";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { requestObjectiveKeyboardFocus, revealObjectiveStage, setActiveObjective } from "../../../../core/client/src/integration/store.js";
import { freshConversationSurface, openFreshConversation } from "../../../objectives/client/fresh-conversation.js";
import { openCommodoreConversation } from "../../../commodore/client/commodore-conversation.js";
import { commodoreSectionLabel, useCommodoreList } from "../../../commodore/client/commodore-list.js";
import { presentRailPanel } from "../../../../core/client/src/chrome/rail/rail-store.js";
import { KeyedAvatar } from "../avatars.js";
import { useConversationStandInComposer } from "./conversation-slots.js";
import type { ConversationSurfaceContext } from "../../shared/conversation-surfaces.js";
import { closeConversationSurface } from "./conversation-surface-store.js";
import { COMMANDER_SPLIT_MAX_RATIO, COMMANDER_SPLIT_MIN_RATIO, setCommanderSplitRatio, openCommanderSplit, setExpandedCommanderSplit, useCommanderSplit } from "./commander-split-store.js";

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
export function expandCommanderSplit(commodoreId: string, objectiveId: string, hasRecord = true): void {
  setExpandedCommanderSplit({ commodoreId, objectiveId });
  if (!hasRecord) { openFreshConversation(objectiveId); return; }
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

export interface CommanderSplitControlsProps {
  readonly onClose: () => void;
  readonly onExpand?: () => void;
  readonly onBack?: () => void;
}

export function CommanderSplitControls({ onClose, onExpand, onBack }: CommanderSplitControlsProps) {
  const t = useT();
  return <span className="conversation-split-controls">
    {onBack ? <button type="button" className="conversation-split-back" onClick={onBack}>{t("conversation.commanderSplit.back")}</button> : null}
    {onExpand ? <button type="button" className="conversation-split-control" onClick={onExpand} aria-label={t("conversation.commanderSplit.expand")} title={t("conversation.commanderSplit.expand")}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button> : null}
    <button type="button" className="conversation-split-control" onClick={onClose} aria-label={t("conversation.commanderSplit.close")} title={t("conversation.commanderSplit.close")}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
    </button>
  </span>;
}

/** 시작 전·보관된 목표도 같은 시작 화면과 그룹 입력창을 쓰되 전역 대화나 오른쪽 탭은 바꾸지 않는다. */
export function CommanderSplitFreshColumn({ commodoreId, objectiveId, theaterId, language, theme, controls }: {
  readonly commodoreId: string; readonly objectiveId: string; readonly theaterId: string;
  readonly language: "en" | "ko"; readonly theme: ConversationSurfaceContext["theme"]; readonly controls: CommanderSplitControlsProps;
}) {
  const composer = useConversationStandInComposer();
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  useEffect(() => freshConversationSurface.subscribe?.(redraw), []);
  const context = useMemo<ConversationSurfaceContext>(() => ({
    params: { objectiveId, commodoreId, theaterId }, language, theme, close: controls.onClose,
    onObjectiveReady: (id) => openCommanderSplit(commodoreId, id),
    ...(composer ? { composer: () => composer(objectiveId, language) } : {}),
  }), [commodoreId, objectiveId, theaterId, language, theme, controls.onClose, composer]);
  const avatar = freshConversationSurface.avatar?.(context);
  return <div className="conversation-column">
    <div className="conversation-pill-row">
      <div className="conversation-pill"><button type="button" className="conversation-pill-details" onClick={controls.onExpand}>
        {avatar ? <KeyedAvatar avatarKey={avatar.key} role={avatar.role} state={avatar.state ?? "fresh"} size={20} label={avatar.label} decorative /> : null}
        <span className="conversation-pill-title">{freshConversationSurface.title(context)}</span>
        <span className="conversation-pill-sub">· {freshConversationSurface.subtitle?.(context)}</span>
      </button></div>
      <CommanderSplitControls {...controls} />
    </div>
    <div className="conversation-body is-surface">{freshConversationSurface.render(context)}</div>
  </div>;
}

/** 크게 보기로 넘어온 바로 그 대화에서만 같은 자리의 돌아가기를 제공한다. */
export function CommanderSplitReturn({ objectiveId }: { readonly objectiveId: string }) {
  const t = useT();
  const { expanded } = useCommanderSplit();
  const commodores = useCommodoreList();
  if (!expanded || expanded.objectiveId !== objectiveId) return null;
  const owner = commodores.find((commodore) => commodore.commodoreId === expanded.commodoreId);
  const name = owner ? commodoreSectionLabel(owner, t("sidebar.commodore.fallback")) : t("sidebar.commodore.fallback");
  return <button type="button" className="conversation-split-return" title={t("conversation.commanderSplit.returnTip", { commodore: name })} onClick={() => {
    if (!openCommodoreConversation(expanded.commodoreId)) return;
    openCommanderSplit(expanded.commodoreId, objectiveId);
    presentRailPanel("commodore-commanders");
  }}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 3v10" stroke="currentColor" strokeWidth="1.3" /></svg>
    {t("conversation.commanderSplit.return")}
  </button>;
}
