import { useEffect, useLayoutEffect, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

// 강도 라벨은 LOW·MED·HIGH·XHIGH·MAX뿐이라 실측 자연 폭이 70px 남짓이다.
const MENU_WIDTH = 104;
const MENU_GAP = 6;
const VIEWPORT_MARGIN = 12;

interface QuickLaunchEffortMenuProps {
  readonly anchor: HTMLElement | null;
  readonly menuRef: RefObject<HTMLDivElement | null>;
  readonly open: boolean;
  readonly children: ReactNode;
  readonly onCancelClose: () => void;
  readonly onScheduleClose: () => void;
  readonly onClose: () => void;
  readonly onReturnFocus: () => void;
}

export function QuickLaunchEffortMenu({
  anchor,
  menuRef,
  open,
  children,
  onCancelClose,
  onScheduleClose,
  onClose,
  onReturnFocus,
}: QuickLaunchEffortMenuProps) {
  const [position, setPosition] = useState<{ readonly left: number; readonly top: number; readonly opensLeft: boolean } | null>(null);

  useEffect(() => {
    if (!open) setPosition(null);
  }, [open]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !anchor || !menu) return;
    const anchorRect = anchor.getBoundingClientRect();
    // 가로 기준은 행이 아니라 팝오버 상자다 — 행은 상자 안쪽 패딩만큼 좁아, 행에 붙이면
    // 서브메뉴가 그만큼 팝오버 위로 파고들어 짚고 있던 행의 오른쪽 끝을 덮는다.
    const popoverRect = anchor.closest(".quick-launch-pop")?.getBoundingClientRect() ?? anchorRect;
    const menuRect = menu.getBoundingClientRect();
    const menuWidth = menuRect.width || MENU_WIDTH;
    const menuHeight = menuRect.height;
    const rightCandidate = popoverRect.right + MENU_GAP;
    const leftCandidate = popoverRect.left - MENU_GAP - menuWidth;
    const rightFits = rightCandidate + menuWidth <= window.innerWidth - VIEWPORT_MARGIN;
    const leftFits = leftCandidate >= VIEWPORT_MARGIN;
    const opensLeft = !rightFits && leftFits;
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - menuWidth - VIEWPORT_MARGIN);
    const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - menuHeight - VIEWPORT_MARGIN);
    setPosition({
      left: Math.max(VIEWPORT_MARGIN, Math.min(opensLeft ? leftCandidate : rightCandidate, maxLeft)),
      top: Math.max(VIEWPORT_MARGIN, Math.min(anchorRect.top, maxTop)),
      opensLeft,
    });
  }, [anchor, menuRef, open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={menuRef}
      className={`quick-launch-effort-menu theater-menu${position?.opensLeft ? " is-left" : ""}`}
      role="menu"
      style={position ? {
        left: position.left,
        top: position.top,
        visibility: "visible",
      } satisfies CSSProperties : undefined}
      onPointerEnter={onCancelClose}
      onPointerLeave={onScheduleClose}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "ArrowLeft" && event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        // 포커스 복귀가 먼저다 — 짚은 행의 onFocus가 서브메뉴를 다시 여는데, 닫기를 먼저 하면
        // 그 재열림이 나중이라 이겨서 메뉴가 닫히지 않는다.
        onReturnFocus();
        onClose();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export const QUICK_LAUNCH_EFFORT_MENU_WIDTH = MENU_WIDTH;
