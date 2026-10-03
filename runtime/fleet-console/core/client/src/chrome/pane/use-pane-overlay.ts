import { useLayoutEffect, useRef, type RefObject } from "react";

export function usePaneOverlay(active: boolean, rootRef: RefObject<HTMLElement | null>, dismiss: () => void, returnFocus?: () => HTMLElement | null): void {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!active || !root) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousTabIndex = root.getAttribute("tabindex");
    root.setAttribute("data-rail-overlay", "true");
    root.tabIndex = -1;
    root.focus({ preventScroll: true });
    const topmost = () => [...document.querySelectorAll('[data-rail-overlay="true"]')].at(-1) === root;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || !topmost()) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[aria-modal="true"], [role="menu"], [role="listbox"]') && !root.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      dismissRef.current();
    };
    const pointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || root.contains(target) || !topmost()) return;
      if (target.closest("#rail-settings-toggle, .right-rail-tabs .right-rail-ico")) return;
      // 가림 인셋이 사라지면 부유 조작이 pointerdown과 click 사이에 이동한다.
      // 조작 요소는 첫 클릭을 받게 두고, 빈 본문·터미널을 누를 때만 덮개를 거둔다.
      if (target.closest(".expanded-surface-pane") && target.closest('button, a[href], [role="button"], [role="link"]')) return;
      if (target.closest('[aria-modal="true"], [role="menu"], [role="listbox"]')) return;
      dismissRef.current();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", pointer, true);
    return () => {
      root.removeAttribute("data-rail-overlay");
      if (previousTabIndex === null) root.removeAttribute("tabindex"); else root.setAttribute("tabindex", previousTabIndex);
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", pointer, true);
      queueMicrotask(() => {
        const target = returnFocusRef.current?.() ?? previousFocus;
        if (target?.isConnected && (document.activeElement === document.body || root.contains(document.activeElement))) {
          target.focus({ preventScroll: true });
        }
      });
    };
  }, [active, rootRef]);
}
