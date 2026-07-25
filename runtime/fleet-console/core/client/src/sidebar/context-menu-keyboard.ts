import { useEffect, type RefObject } from "react";

import type { SideBarOperationMenuAction } from "./operation-action-request.js";

const MENU_ITEM_SELECTOR = 'button[role^="menuitem"]:not(:disabled)';
// accent 섹션 판별은 data 마커로만 한다 — 접근 이름 문구는 다듬을 수 있는 표현이라 근거로 삼으면 조용히 깨진다.
const ACCENT_OPTION_ATTRIBUTE = "data-accent-option";

interface ContextMenuKeyboardOptions {
  readonly open: boolean;
  readonly menuSelector: string;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  readonly requestedAction?: SideBarOperationMenuAction;
  readonly onEscape: () => void;
}

export function useContextMenuKeyboard({
  open,
  menuSelector,
  returnFocusRef,
  requestedAction,
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
      if (initialItems.length > 0) {
        const requestedIndex = requestedAction === "set-accent"
          ? initialItems.findIndex((item) => item.hasAttribute(ACCENT_OPTION_ATTRIBUTE))
          : 0;
        // 마커를 못 찾으면 첫 항목으로 안전하게 떨어진다.
        const initialIndex = Math.max(0, requestedIndex);
        setCurrent(initialIndex, false);
        if (returnFocusRef.current !== null) {
          focusFrame = window.requestAnimationFrame(() => {
            if (!cancelled && menu.isConnected) setCurrent(initialIndex, true);
          });
        }
      }

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
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        event.stopPropagation();
        const currentIndex = currentItems.findIndex((item) => item === document.activeElement);
        const nextIndex = event.key === "ArrowDown"
          ? (currentIndex + 1) % currentItems.length
          : currentIndex <= 0 ? currentItems.length - 1 : currentIndex - 1;
        setCurrent(nextIndex, true);
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
        if (currentItems.length > 0) setCurrent(Math.max(0, currentIndex), false);
      });

      menu.addEventListener("keydown", handleKeyDown);
      menu.addEventListener("focusin", handleFocusIn);
      contentObserver.observe(menu, { childList: true, subtree: true });
      cleanupMenu = () => {
        menu.removeEventListener("keydown", handleKeyDown);
        menu.removeEventListener("focusin", handleFocusIn);
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
  }, [menuSelector, onEscape, open, requestedAction, returnFocusRef]);
}
