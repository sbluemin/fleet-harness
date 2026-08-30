import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";

/**
 * 콘솔 팝업 메뉴의 항목 선택자 — 방향키 순회와 최초 포커스가 같은 목록을 본다.
 * 값 조절 행(슬라이더 등)은 menuitem 역할을 갖지 않으므로 순회에서 자연히 빠진다.
 */
export const ENABLED_MENU_ITEM_SELECTOR =
  '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled])';

/**
 * menu-button 패턴의 키보드·바깥 클릭 계약. 커맨드 밴드 시스템 메뉴와 Activity Rail 설정
 * 메뉴가 이 한 벌을 공유한다 — 콘솔 메뉴는 단일 방언이어야 하므로 사본을 만들지 않는다.
 *
 * `rootRef`는 트리거와 메뉴를 함께 담는 경계다. 메뉴가 포털로 문서 다른 곳에 그려지는
 * 경우처럼 하나의 경계로 담기지 않을 때는 `extraRootRefs`로 메뉴 쪽 경계를 함께 넘긴다.
 */
export function useMenuButtonKeyboard(
  rootRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLButtonElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>,
): void {
  useEffect(() => {
    if (!open) return;
    // menu-button 패턴: 열리면 첫 menuitem으로 포커스 이동.
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>(ENABLED_MENU_ITEM_SELECTOR)?.focus();
    });
    const handlePointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (rootRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      // 메뉴 안의 항목이 아닌 컨트롤(불투명도 슬라이더 등)은 이 키들을 스스로 쓴다 — 항목 순회가
      // 가로채면 값 조절이 죽고 포커스까지 빼앗겨 키보드로는 손댈 수 없는 컨트롤이 된다.
      const target = event.target;
      if (
        target instanceof Element
        && menuRef.current?.contains(target) === true
        && target.closest(ENABLED_MENU_ITEM_SELECTOR) === null
      ) return;
      const items = [...(menuRef.current?.querySelectorAll<HTMLElement>(ENABLED_MENU_ITEM_SELECTOR) ?? [])];
      if (items.length === 0) return;
      event.preventDefault();
      const currentIndex = items.findIndex((item) => item === document.activeElement);
      const nextIndex = event.key === "Home" || (event.key === "ArrowDown" && currentIndex === items.length - 1)
        ? 0
        : event.key === "End" || (event.key === "ArrowUp" && currentIndex <= 0)
          ? items.length - 1
          : event.key === "ArrowDown" ? currentIndex + 1 : currentIndex - 1;
      items[nextIndex]?.focus();
    };
    window.addEventListener("pointerdown", handlePointer, true);
    window.addEventListener("keydown", handleKey, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", handlePointer, true);
      window.removeEventListener("keydown", handleKey, true);
    };
  }, [menuRef, open, rootRef, setOpen, triggerRef]);
}
