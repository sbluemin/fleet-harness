import { useEffect, useLayoutEffect, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const MENU_WIDTH = 148;
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
    const menuRect = menu.getBoundingClientRect();
    const menuWidth = menuRect.width || MENU_WIDTH;
    const menuHeight = menuRect.height;
    const rightCandidate = anchorRect.right + MENU_GAP;
    const leftCandidate = anchorRect.left - MENU_GAP - menuWidth;
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
        onClose();
        onReturnFocus();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export const QUICK_LAUNCH_EFFORT_MENU_WIDTH = MENU_WIDTH;
