import { useEffect, type RefObject } from "react";

const MENU_ITEM_SELECTOR = 'button[role^="menuitem"]:not(:disabled)';

interface ContextMenuKeyboardOptions {
  readonly open: boolean;
  readonly menuSelector: string;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  readonly onEscape: () => void;
}

export function useContextMenuKeyboard({
  open,
  menuSelector,
  returnFocusRef,
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
        setCurrent(0, false);
        if (returnFocusRef.current !== null) {
          focusFrame = window.requestAnimationFrame(() => {
            if (!cancelled && menu.isConnected) setCurrent(0, true);
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
  }, [menuSelector, onEscape, open, returnFocusRef]);
}
