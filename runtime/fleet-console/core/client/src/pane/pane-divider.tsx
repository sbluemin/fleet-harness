import { useCallback, useRef } from "react";

import { useT } from "../i18n/index.js";
import {
  clampPrimaryWidth,
  paneSeparatorState,
  resizePrimaryWithKeyboard,
  type PaneSplitLimits,
} from "./pane-geometry.js";

/**
 * 표면의 분할선.
 *
 * 페인이 아니라 표면이 그린다 — 이 선은 두 열 사이의 경계이지 어느 한쪽의 부속이 아니기
 * 때문이다. 지금까지 플러그인마다 따로 구현하던 것(fexp-divider·repository-divider)을
 * 이 하나가 대신한다.
 */

export interface PaneDividerProps {
  /** 조절 대상 — 분할선 오른쪽에 선 primary 열. */
  readonly primaryPaneId: string;
  readonly primaryTitle: string;
  readonly width: number;
  readonly limits: PaneSplitLimits;
  readonly onWidthChange: (width: number) => void;
  readonly onDragStateChange?: (dragging: boolean) => void;
}

export function PaneDivider({
  primaryPaneId,
  primaryTitle,
  width,
  limits,
  onWidthChange,
  onDragStateChange,
}: PaneDividerProps) {
  const t = useT();
  const state = paneSeparatorState(width, limits);
  // 드래그 중에는 포인터 이동마다 최신 한계를 봐야 한다 — 창 크기가 바뀌면 최대치가 달라지고,
  // 시작 시점의 한계로 계속 자르면 분할선이 창 밖으로 나간다.
  const limitsRef = useRef(limits);
  limitsRef.current = limits;

  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    if (!state.canResize) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = state.currentWidth;
    onDragStateChange?.(true);

    const onMove = (moveEvent: PointerEvent) => {
      // 분할선은 primary 왼쪽 경계다 — 오른쪽으로 끌면 primary가 좁아진다.
      onWidthChange(clampPrimaryWidth(startWidth - (moveEvent.clientX - startX), limitsRef.current));
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      onDragStateChange?.(false);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [onDragStateChange, onWidthChange, state.canResize, state.currentWidth]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (!state.canResize) return;
    const next = resizePrimaryWithKeyboard(state.currentWidth, event.key, limitsRef.current, event.shiftKey);
    if (next === state.currentWidth && event.key !== "Home" && event.key !== "End") return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    onWidthChange(next);
  }, [onWidthChange, state.canResize, state.currentWidth]);

  return (
    <div
      className="rail-pane-divider"
      role="separator"
      aria-orientation="vertical"
      aria-controls={`rail-pane-${primaryPaneId}`}
      aria-label={t("pane.divider.resize", { title: primaryTitle })}
      aria-valuenow={state.currentWidth}
      aria-valuemin={state.minWidth}
      aria-valuemax={state.maxWidth}
      aria-disabled={state.ariaDisabled}
      tabIndex={state.tabIndex}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    />
  );
}
