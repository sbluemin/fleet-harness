import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { resolveContextMenuKeyboardAction } from "./context-menu.js";

/**
 * 조용한 목록 팝오버 — 탭 넘침 목록과 경로 조각의 형제 목록이 같은 몸을 쓴다.
 *
 * 컨텍스트 메뉴의 팝업 판독성 계약(`.fexp-context-menu`)을 그대로 입고, 키보드는 그 메뉴와 같은
 * 문법(↑↓·Enter·Esc·Tab)이다. 머리 행이 있으면 목록의 첫 항목처럼 오르내린다.
 */

export interface QuietMenuItem {
  readonly key: string;
  readonly label: ReactNode;
  /** 라벨 오른쪽의 한 단 조용한 힌트 — 폴더 조각 같은 것. */
  readonly hint?: string;
  readonly icon?: ReactNode;
  /** 지금 열려 있는 항목 — brass로 표시한다. */
  readonly current?: boolean;
  readonly onSelect: () => void;
}

export interface QuietMenuHeader {
  readonly label: string;
  readonly title?: string;
  readonly onSelect: () => void;
}

interface QuietMenuProps {
  readonly className?: string;
  readonly ariaLabel: string;
  readonly items: readonly QuietMenuItem[];
  readonly header?: QuietMenuHeader;
  /** 항목이 하나도 없을 때의 한 줄. */
  readonly emptyLabel?: string;
  /** 항목 위에 서는 정직성 안내 — 실패나 목록 잘림을 빈 폴더와 갈라 말한다. */
  readonly noticeLabel?: string;
  readonly noticeTone?: "quiet" | "error";
  readonly loading?: boolean;
  /** 바깥 클릭 판정에서 제외할 트리거 — 빼면 pointerdown 닫힘 뒤 click 토글이 메뉴를 되열어 버린다. */
  readonly triggerRef?: RefObject<HTMLElement | null>;
  /** ref를 만들지 않고 이미 잡은 경로 조각처럼, 바깥 클릭 판정에서 제외할 실제 트리거. */
  readonly triggerElement?: HTMLElement;
  /** 경계 요소 기준 왼쪽 px — 경계 안에 들도록 클램프된다. 생략하면 CSS 자리에 선다. */
  readonly anchorLeft?: number;
  readonly boundaryRef?: RefObject<HTMLElement | null>;
  readonly onClose: (restoreFocus: boolean) => void;
}

const MENU_MARGIN_PX = 4;

export function clampMenuLeft(anchorLeft: number, menuWidth: number, boundaryWidth: number, margin: number = MENU_MARGIN_PX): number {
  const maxLeft = Math.max(margin, boundaryWidth - menuWidth - margin);
  return Math.max(margin, Math.min(anchorLeft, maxLeft));
}

export function QuietMenu({
  className,
  ariaLabel,
  items,
  header,
  emptyLabel,
  noticeLabel,
  noticeTone = "quiet",
  loading,
  triggerRef,
  triggerElement,
  anchorLeft,
  boundaryRef,
  onClose,
}: QuietMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [left, setLeft] = useState<number | null>(null);
  const focusableCount = (header ? 1 : 0) + items.length;

  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => itemRefs.current[0]?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, []);

  useLayoutEffect(() => {
    if (anchorLeft === undefined) return;
    const menu = menuRef.current;
    const boundary = boundaryRef?.current;
    if (!menu || !boundary) {
      setLeft(anchorLeft);
      return;
    }
    const place = () => setLeft(clampMenuLeft(anchorLeft, menu.offsetWidth, boundary.clientWidth));
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    observer.observe(boundary);
    return () => observer.disconnect();
  }, [anchorLeft, boundaryRef, items.length, loading]);

  useEffect(() => {
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef?.current?.contains(target) || triggerElement?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer, true);
  }, [onClose, triggerElement, triggerRef]);

  const focusItem = (index: number) => {
    setActiveIndex(index);
    itemRefs.current[index]?.focus();
  };
  const activate = (index: number) => {
    if (header && index === 0) {
      header.onSelect();
      return;
    }
    const item = items[header ? index - 1 : index];
    item?.onSelect();
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = resolveContextMenuKeyboardAction(activeIndex, event.key, focusableCount);
    if (action.kind === "close") {
      onClose(false);
      return;
    }
    if (action.kind === "none") return;
    event.preventDefault();
    event.stopPropagation();
    if (action.kind === "focus") focusItem(action.index);
    else if (action.kind === "activate") activate(action.index);
    else onClose(true);
  };

  const style: CSSProperties | undefined = anchorLeft === undefined
    ? undefined
    : left === null
      ? { left: anchorLeft, visibility: "hidden" }
      : { left };

  let focusIndex = -1;
  return (
    <div
      ref={menuRef}
      className={`fexp-context-menu fexp-quiet-menu${className ? ` ${className}` : ""}`}
      role="menu"
      aria-label={ariaLabel}
      style={style}
      onKeyDown={handleKeyDown}
    >
      {header && (() => {
        focusIndex += 1;
        const index = focusIndex;
        return (
          <button
            ref={(node) => { itemRefs.current[index] = node; }}
            type="button"
            role="menuitem"
            className="fexp-quiet-menu-head"
            tabIndex={activeIndex === index ? 0 : -1}
            title={header.title}
            onClick={() => activate(index)}
            onFocus={() => setActiveIndex(index)}
          >
            {header.label}
          </button>
        );
      })()}
      {loading && <div className="fexp-quiet-menu-note" role="status">…</div>}
      {!loading && noticeLabel && (
        <div className={`fexp-quiet-menu-note${noticeTone === "error" ? " is-error" : ""}`} role={noticeTone === "error" ? "alert" : "status"}>
          {noticeLabel}
        </div>
      )}
      {!loading && !noticeLabel && items.length === 0 && emptyLabel && (
        <div className="fexp-quiet-menu-note">{emptyLabel}</div>
      )}
      {items.map((item) => {
        focusIndex += 1;
        const index = focusIndex;
        return (
          <button
            key={item.key}
            ref={(node) => { itemRefs.current[index] = node; }}
            type="button"
            role="menuitem"
            className={`fexp-context-menu-item fexp-quiet-menu-item${item.current ? " is-current" : ""}`}
            aria-current={item.current ? "true" : undefined}
            tabIndex={activeIndex === index ? 0 : -1}
            onClick={() => activate(index)}
            onFocus={() => setActiveIndex(index)}
            onMouseEnter={() => focusItem(index)}
          >
            {item.icon && <span className="fexp-quiet-menu-icon" aria-hidden="true">{item.icon}</span>}
            <span className="fexp-quiet-menu-label">{item.label}</span>
            {item.hint && <span className="fexp-quiet-menu-hint" aria-hidden="true">{item.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
