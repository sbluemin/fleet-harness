import { useEffect, type RefObject } from "react";

import type { SideBarObjectiveMenuAction } from "./interaction.js";

const MENU_ITEM_SELECTOR = 'button[role^="menuitem"]:not(:disabled)';
// accent 섹션 판별은 data 마커로만 한다 — 접근 이름 문구는 다듬을 수 있는 표현이라 근거로 삼으면 조용히 깨진다.
const ACCENT_OPTION_ATTRIBUTE = "data-accent-option";

interface ContextMenuKeyboardOptions {
  readonly open: boolean;
  readonly menuSelector: string;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  readonly requestedAction?: SideBarObjectiveMenuAction;
  readonly focusFirst?: boolean;
  readonly onEscape: () => void;
}

export function useContextMenuKeyboard({
  open,
  menuSelector,
  returnFocusRef,
  requestedAction,
  focusFirst = false,
  onEscape,
}: ContextMenuKeyboardOptions): void {
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let focusFrame: number | null = null;
    let cleanupMenu: (() => void) | null = null;
    const attach = () => {
      const menu = document.querySelector<HTMLElement>(menuSelector);
      if (!menu) return false;
      const items = () => Array.from(menu.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR));
      const setCurrent = (nextIndex: number, focus: boolean) => {
        const currentItems = items();
        for (const [index, item] of currentItems.entries()) item.tabIndex = index === nextIndex ? 0 : -1;
        if (focus) currentItems[nextIndex]?.focus();
      };
      const initialItems = items();
      if (!menu.contains(document.activeElement)) {
        const requestedIndex = requestedAction === "set-accent"
          ? initialItems.findIndex((item) => item.hasAttribute(ACCENT_OPTION_ATTRIBUTE))
          : 0;
        // 포인터로 열면 카드가 키 입력을 받되 행은 고르지 않는다. ↓는 첫 항목부터 시작한다.
        const initialIndex = focusFirst ? Math.max(0, requestedIndex) : -1;
        setCurrent(initialIndex, false);
        menu.tabIndex = -1;
        if (!focusFirst) menu.dataset.menuPointerIdle = "";
        focusFrame = window.requestAnimationFrame(() => {
          if (cancelled || !menu.isConnected || menu.contains(document.activeElement)) return;
          if (initialIndex >= 0) setCurrent(initialIndex, true);
          else menu.focus({ preventScroll: true });
        });
      }
      const handlePointerMove = () => { delete menu.dataset.menuPointerIdle; };

      const handleKeyDown = (event: KeyboardEvent) => {
        const currentItems = items();
        if (currentItems.length === 0) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          const returnFocus = returnFocusRef.current;
          onEscape();
          returnFocus?.focus();
          return;
        }
        if (event.key === "Enter" && document.activeElement instanceof HTMLButtonElement && menu.contains(document.activeElement)) {
          event.preventDefault();
          event.stopPropagation();
          document.activeElement.click();
          return;
        }
        // 스와치는 한 줄로 서므로 좌우 화살표는 그 줄 안에서만 돈다 — 줄 밖(새 그룹·그룹 해제)으로
        // 새지 않는다. 위아래는 메뉴 전체를 계속 훑는다.
        const onSwatch = document.activeElement instanceof HTMLElement && document.activeElement.hasAttribute(ACCENT_OPTION_ATTRIBUTE);
        const horizontal = onSwatch && (event.key === "ArrowRight" || event.key === "ArrowLeft");
        const vertical = event.key === "ArrowDown" || event.key === "ArrowUp";
        const edge = event.key === "Home" || event.key === "End";
        if (!horizontal && !vertical && !edge) return;
        event.preventDefault();
        event.stopPropagation();
        const ring = horizontal ? currentItems.filter((item) => item.hasAttribute(ACCENT_OPTION_ATTRIBUTE)) : currentItems;
        const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
        const ringIndex = ring.findIndex((item) => item === document.activeElement);
        const nextInRing = event.key === "Home" ? 0 : event.key === "End" ? ring.length - 1 : forward
          ? (ringIndex + 1) % ring.length
          : ringIndex <= 0 ? ring.length - 1 : ringIndex - 1;
        setCurrent(currentItems.indexOf(ring[nextInRing]!), true);
      };
      const handleFocusIn = (event: FocusEvent) => {
        if (!(event.target instanceof HTMLInputElement)) return;
        for (const item of items()) item.tabIndex = -1;
      };
      const contentObserver = new MutationObserver(() => {
        const currentItems = items();
        if (document.activeElement instanceof HTMLInputElement && menu.contains(document.activeElement)) {
          for (const item of currentItems) item.tabIndex = -1;
          return;
        }
        const currentIndex = currentItems.findIndex((item) => item.tabIndex === 0);
        if (currentItems.length > 0) setCurrent(currentIndex, false);
      });

      menu.addEventListener("keydown", handleKeyDown);
      menu.addEventListener("focusin", handleFocusIn);
      menu.addEventListener("pointermove", handlePointerMove);
      contentObserver.observe(menu, { childList: true, subtree: true });
      cleanupMenu = () => {
        menu.removeEventListener("keydown", handleKeyDown);
        menu.removeEventListener("focusin", handleFocusIn);
        menu.removeEventListener("pointermove", handlePointerMove);
        delete menu.dataset.menuPointerIdle;
        contentObserver.disconnect();
      };
      return true;
    };
    let observer: MutationObserver | null = null;
    if (!attach()) {
      observer = new MutationObserver(() => {
        if (!attach()) return;
        observer?.disconnect();
      });
    }
    observer?.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelled = true;
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
      observer?.disconnect();
      cleanupMenu?.();
    };
  }, [focusFirst, menuSelector, onEscape, open, requestedAction, returnFocusRef]);
}
