import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type Dispatch, type SetStateAction } from "react";

import { ENABLED_MENU_ITEM_SELECTOR } from "./use-menu-button-keyboard.js";

/** 서브메뉴 판이 항목 오른쪽 끝에서 띄우는 틈. 판은 부모 메뉴의 안쪽 여백 위에 살짝 걸친다. */
const SUBMENU_GAP = 2;
/** 판의 테두리와 안쪽 여백 — 첫 줄이 항목과 같은 높이에서 시작하도록 그만큼 올린다. */
const SUBMENU_INSET = 7;
/** 창 가장자리에서 판이 지키는 여백. */
const SUBMENU_EDGE = 12;
/** 겨눈 채 잠시 머물러야 열린다 — 지나가는 포인터마다 판이 번쩍이지 않게. */
const SUBMENU_OPEN_DELAY_MS = 90;
/** 항목·판을 떠난 포인터가 돌아오거나 판에 닿기를 기다리는 시간. */
const SUBMENU_CLOSE_DELAY_MS = 300;

export interface SubmenuPlacement {
  readonly left: number;
  readonly top: number;
  readonly maxHeight: number;
  readonly side: "right" | "left";
}

/**
 * 항목 옆에 서는 서브메뉴의 자리. 오른쪽에 들어가면 오른쪽, 아니면 더 넓은 쪽에 세우고, 창 밖으로는
 * 내보내지 않는다. 세로로는 첫 줄을 항목에 맞추되, 아래가 모자라면 판째로 끌어올린다 — 독 메뉴는
 * 화면 아래 모서리에 서므로 대개 위로 올라간다.
 *
 * 도구모음 안의 서브메뉴와 집이 얹는 덮개가 같은 자리를 써야 둘이 한 물건으로 읽힌다.
 */
export function placeSubmenu(
  anchor: { readonly left: number; readonly top: number; readonly right: number },
  panelWidth: number,
  panelHeight: number,
  width: number,
  height: number,
): SubmenuPlacement {
  const roomRight = width - SUBMENU_EDGE - (anchor.right + SUBMENU_GAP);
  const roomLeft = anchor.left - SUBMENU_GAP - SUBMENU_EDGE;
  const side = panelWidth <= roomRight || roomRight >= roomLeft ? "right" : "left";
  const preferred = side === "right" ? anchor.right + SUBMENU_GAP : anchor.left - SUBMENU_GAP - panelWidth;
  const left = Math.max(SUBMENU_EDGE, Math.min(preferred, width - SUBMENU_EDGE - panelWidth));
  const maxHeight = Math.max(0, height - 2 * SUBMENU_EDGE);
  const shown = Math.min(panelHeight, maxHeight);
  const top = Math.max(SUBMENU_EDGE, Math.min(anchor.top - SUBMENU_INSET, height - SUBMENU_EDGE - shown));
  return { left, top, maxHeight, side };
}

/** 판의 내용 높이(테두리 포함). 높이 상한에 눌려 있어도 펼쳤을 때의 높이를 잰다. */
export function submenuContentHeight(panel: HTMLElement): number {
  return panel.scrollHeight + (panel.offsetHeight - panel.clientHeight);
}

/** 서브메뉴를 지켜 주는 삼각형 — 항목을 떠난 점과 판의 가까운 변 두 끝. 이 안을 지나는 포인터는 판으로 가는 중이다. */
function inSafeTriangle(point: { x: number; y: number }, exit: { x: number; y: number }, panel: DOMRect): boolean {
  const nearX = Math.abs(panel.left - exit.x) <= Math.abs(panel.right - exit.x) ? panel.left : panel.right;
  const a = exit;
  const b = { x: nearX, y: panel.top };
  const c = { x: nearX, y: panel.bottom };
  const cross = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(a, b, point);
  const d2 = cross(b, c, point);
  const d3 = cross(c, a, point);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

interface HoverTimers {
  openTimer: number | null;
  closeTimer: number | null;
  exit: { x: number; y: number } | null;
}

export interface SideSubmenuOptions {
  /** 거짓이면 훅은 아무 것도 하지 않는다 — 도구모음 칩은 아래로 열리는 판 그대로다. */
  readonly enabled: boolean;
  readonly open: boolean;
  readonly setOpen: Dispatch<SetStateAction<boolean>>;
  readonly rootRef: { readonly current: HTMLElement | null };
  readonly triggerRef: { readonly current: HTMLButtonElement | null };
  readonly panelRef: { readonly current: HTMLElement | null };
  /**
   * 겨눔으로 열어도 되는가. 거짓이면 타이머를 걸지 않고, 기다리는 사이에 거짓이 되면 그 타이머도 열지 않는다.
   * 생략하면 항상 허용한다.
   */
  readonly allowHoverOpen?: () => boolean;
  /** 키·포인터 감시를 잠시 멈춘다. 열린 판 위에 대화상자가 서 있을 때. */
  readonly suspended?: boolean;
  /**
   * → 와 클릭이 부를 열기. 호스트처럼 집의 덮개로 보내는 동선이 있으면 그걸 넘긴다.
   * 없으면 이 훅이 판을 연다.
   */
  readonly activate?: () => void;
  /** 판 안에서 방향키로 옮긴 직후. 호스트 목록이 늦게 도착한 현재 행으로 포커스를 되돌리지 않게 한다. */
  readonly onPanelArrow?: () => void;
  /**
   * 열릴 때 이 훅이 판 안으로 포커스를 옮기는가. 호출자가 늦은 목록까지 포함해 최초 포커스를 맡으면 false.
   * 기본은 true — 도움말처럼 항목이 바로 있는 메뉴.
   */
  readonly manageInitialFocus?: boolean;
}

/**
 * 메뉴 항목 옆에 펴는 서브메뉴. 겨눔 열기/접기, 안전 삼각형, →·Enter / ←·Esc, 가장자리를 피한 고정 배치를
 * 호스트와 도움말이 같이 쓴다. `enabled`가 아니면 트리거 핸들러는 통과시키고 감시도 붙이지 않는다.
 */
export function useSideSubmenu({ enabled, open, setOpen, rootRef, triggerRef, panelRef, allowHoverOpen, suspended = false, activate, onPanelArrow, manageInitialFocus = true }: SideSubmenuOptions) {
  /** 열릴 때 판 안으로 포커스를 옮기는가. 겨눠서 연 판은 부모 메뉴의 포커스를 빼앗지 않는다. */
  const focusOnOpenRef = useRef(true);
  const hoverRef = useRef<HoverTimers>({ openTimer: null, closeTimer: null, exit: null });
  const allowHoverOpenRef = useRef(allowHoverOpen);
  const activateRef = useRef(activate);
  const onPanelArrowRef = useRef(onPanelArrow);
  allowHoverOpenRef.current = allowHoverOpen;
  activateRef.current = activate;
  onPanelArrowRef.current = onPanelArrow;

  const clearHoverTimers = () => {
    const hover = hoverRef.current;
    if (hover.openTimer !== null) window.clearTimeout(hover.openTimer);
    if (hover.closeTimer !== null) window.clearTimeout(hover.closeTimer);
    hover.openTimer = null;
    hover.closeTimer = null;
  };

  const hoverClosable = () => !focusOnOpenRef.current && panelRef.current?.contains(document.activeElement) !== true;

  /** 포인터가 항목에도 판에도 없으면 잠시 뒤 접는다. 판에 포커스가 있었다면 항목으로 돌려준다. */
  const scheduleHoverClose = () => {
    const hover = hoverRef.current;
    if (hover.closeTimer !== null) window.clearTimeout(hover.closeTimer);
    hover.closeTimer = window.setTimeout(() => {
      hover.closeTimer = null;
      hover.exit = null;
      const hadFocus = panelRef.current?.contains(document.activeElement) === true;
      setOpen(false);
      if (hadFocus) triggerRef.current?.focus();
    }, SUBMENU_CLOSE_DELAY_MS);
  };

  const focusInto = () => {
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(ENABLED_MENU_ITEM_SELECTOR) ?? []);
    (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
  };

  /**
   * 누르거나 → 로 연다. 이미 열려 있으면 판 안으로 들어간다 — 겨눠서 열린 판을 누름이 도로 접지 않는다.
   * 서브메뉴가 아니면 false. 호출자가 자기 토글을 한다.
   */
  const openByHand = (): boolean => {
    if (!enabled) return false;
    clearHoverTimers();
    focusOnOpenRef.current = true;
    // 이미 열린 판으로 들어가는 포커스도 최초 포커스와 같은 주체가 옮긴다.
    if (open) { if (manageInitialFocus) focusInto(); }
    else setOpen(true);
    return true;
  };

  const behaviorRef = useRef({ clearHoverTimers, scheduleHoverClose, hoverClosable, focusInto, openByHand });
  behaviorRef.current = { clearHoverTimers, scheduleHoverClose, hoverClosable, focusInto, openByHand };

  useEffect(() => () => clearHoverTimers(), []);

  useEffect(() => {
    if (!manageInitialFocus || !enabled || !open || suspended) return;
    if (!focusOnOpenRef.current) return;
    const frame = window.requestAnimationFrame(() => behaviorRef.current.focusInto());
    return () => window.cancelAnimationFrame(frame);
  }, [manageInitialFocus, enabled, open, suspended]);

  useLayoutEffect(() => {
    if (!enabled || !open) return;
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (panel === null || trigger === null) return;
    panel.classList.add("is-side-submenu");
    const place = () => {
      const placement = placeSubmenu(trigger.getBoundingClientRect(), panel.offsetWidth, submenuContentHeight(panel), window.innerWidth, window.innerHeight);
      panel.style.position = "fixed";
      panel.style.zIndex = "91";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = `${placement.left}px`;
      panel.style.top = `${placement.top}px`;
      panel.style.maxHeight = `${placement.maxHeight}px`;
      panel.dataset.side = placement.side;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      panel.classList.remove("is-side-submenu");
    };
  }, [enabled, open, panelRef, triggerRef]);

  useEffect(() => {
    if (!enabled || !open || suspended) return;
    const onMove = (event: PointerEvent) => {
      const hover = hoverRef.current;
      const panel = panelRef.current;
      if (hover.closeTimer === null || hover.exit === null || panel === null) return;
      if (inSafeTriangle({ x: event.clientX, y: event.clientY }, hover.exit, panel.getBoundingClientRect())) behaviorRef.current.scheduleHoverClose();
    };
    /**
     * 포인터가 부모 메뉴의 다른 항목에 올라서면 그 항목으로 옮겨 간 것이다 — 손으로 연 판도 잠시 뒤 접는다.
     * 판으로 가는 대각선 위의 항목을 지나는 동안은 위의 삼각형이 시계를 다시 맞추고, 판에 닿으면 취소된다.
     */
    const onOver = (event: PointerEvent) => {
      if (event.pointerType === "touch" || hoverRef.current.closeTimer !== null) return;
      const target = event.target;
      const root = rootRef.current;
      const parent = triggerRef.current?.closest<HTMLElement>('[role="menu"]');
      if (!(target instanceof Element) || root === null || !parent || root.contains(target)) return;
      const item = target.closest(ENABLED_MENU_ITEM_SELECTOR);
      if (item !== null && parent.contains(item)) behaviorRef.current.scheduleHoverClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"]')) return;
      behaviorRef.current.clearHoverTimers();
      setOpen(false);
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // 포커스가 이 항목·판 밖으로 나가면 접는다. 부모 메뉴의 다른 항목으로 옮겨 간 것이다.
      if (!rootRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (panel === null) return;
      const inPanel = panel.contains(document.activeElement) || panel.contains(event.target as Node);
      if (event.key === "Escape" || event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopImmediatePropagation();
        behaviorRef.current.clearHoverTimers();
        setOpen(false);
        // 겨눠서 연 판은 포커스가 부모 메뉴에 있을 수 있다. 판 안에 있었을 때만 항목으로 돌려준다.
        if (inPanel) triggerRef.current?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
      if (!inPanel) {
        /**
         * 겨눠서 연 판 — 포커스는 아직 부모 메뉴에 있다. 부모의 방향키는 열린 자식이 있으면 물러서므로,
         * 판을 접고 부모 메뉴에서 한 칸을 대신 옮긴다. 같이 열린 다른 서브메뉴는 stopImmediatePropagation으로 같은 키를 다시 옮기지 않는다.
         */
        const parent = triggerRef.current?.closest<HTMLElement>('[role="menu"]');
        if (!parent) return;
        const siblings = Array.from(parent.querySelectorAll<HTMLElement>(ENABLED_MENU_ITEM_SELECTOR)).filter((item) => !panel.contains(item));
        if (siblings.length === 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const at = siblings.findIndex((item) => item === document.activeElement);
        const to = event.key === "Home" ? 0
          : event.key === "End" ? siblings.length - 1
            : event.key === "ArrowDown" ? (at + 1) % siblings.length
              : at <= 0 ? siblings.length - 1 : at - 1;
        behaviorRef.current.clearHoverTimers();
        setOpen(false);
        siblings[to]?.focus();
        return;
      }
      const items = Array.from(panel.querySelectorAll<HTMLElement>(ENABLED_MENU_ITEM_SELECTOR));
      if (items.length === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onPanelArrowRef.current?.();
      const current = items.findIndex((item) => item === document.activeElement);
      const next = event.key === "Home" ? 0
        : event.key === "End" ? items.length - 1
          : event.key === "ArrowDown" ? (current + 1) % items.length
            : current <= 0 ? items.length - 1 : current - 1;
      items[next]?.focus();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onKey);
    };
  }, [enabled, open, suspended, panelRef, rootRef, setOpen, triggerRef]);

  const onTriggerPointerEnter = (event: ReactPointerEvent) => {
    if (!enabled || event.pointerType === "touch") return;
    if (allowHoverOpenRef.current && !allowHoverOpenRef.current()) return;
    const hover = hoverRef.current;
    if (hover.closeTimer !== null) window.clearTimeout(hover.closeTimer);
    hover.closeTimer = null;
    hover.exit = null;
    if (open || hover.openTimer !== null) return;
    hover.openTimer = window.setTimeout(() => {
      hover.openTimer = null;
      if (allowHoverOpenRef.current && !allowHoverOpenRef.current()) return;
      focusOnOpenRef.current = false;
      setOpen(true);
    }, SUBMENU_OPEN_DELAY_MS);
  };

  const onTriggerPointerLeave = (event: ReactPointerEvent) => {
    if (!enabled || event.pointerType === "touch") return;
    const hover = hoverRef.current;
    if (hover.openTimer !== null) window.clearTimeout(hover.openTimer);
    hover.openTimer = null;
    if (!open) return;
    hover.exit = { x: event.clientX, y: event.clientY };
    if (behaviorRef.current.hoverClosable()) behaviorRef.current.scheduleHoverClose();
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent) => {
    if (!enabled || event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    if (activateRef.current) activateRef.current();
    else behaviorRef.current.openByHand();
  };

  const onPanelPointerEnter = (event: ReactPointerEvent) => {
    if (!enabled || event.pointerType === "touch") return;
    const hover = hoverRef.current;
    if (hover.closeTimer !== null) window.clearTimeout(hover.closeTimer);
    hover.closeTimer = null;
    hover.exit = null;
  };

  const onPanelPointerLeave = (event: ReactPointerEvent) => {
    if (!enabled || event.pointerType === "touch") return;
    hoverRef.current.exit = null;
    if (behaviorRef.current.hoverClosable()) behaviorRef.current.scheduleHoverClose();
  };

  return {
    focusOnOpenRef,
    clearHoverTimers,
    openByHand,
    onTriggerPointerEnter,
    onTriggerPointerLeave,
    onTriggerKeyDown,
    onPanelPointerEnter,
    onPanelPointerLeave,
  };
}
