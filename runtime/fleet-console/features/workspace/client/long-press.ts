import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

/**
 * 터치·펜의 길게 누르기 — 우클릭이 없는 손가락이 컨텍스트 메뉴를 여는 길이다. 마우스는 우클릭이 있으니 받지 않는다.
 * 한도를 넘게 움직이면 끌기·스크롤로 보고 취소한다(사이드바 끌기 문턱과 같은 값). 브라우저가 스크롤을 가져가면 pointercancel 이 취소한다.
 */
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 6;
/** 길게 누르기 뒤 이 안에 오는 click·contextmenu 는 같은 누름의 꼬리다. */
const AFTERMATH_MS = 800;

export interface LongPressHandlers<E extends Element> {
  readonly onPointerDown: (event: ReactPointerEvent<E>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<E>) => void;
  readonly onPointerUp: () => void;
  readonly onPointerCancel: () => void;
  /**
   * contextmenu 가 이 누름의 것이면 막고 true 를 돌려준다. Android 는 길게 누르면 contextmenu 도 보낸다 — 타이머보다 먼저 오면
   * 그 자리에서 길게 누르기를 터뜨리고, 뒤에 오면 버린다. 메뉴가 두 번 열리거나 커서 자리로 옮겨 가지 않는다.
   */
  readonly claimContextMenu: (event: ReactMouseEvent<E>) => boolean;
  /** 길게 누르기 바로 뒤의 click 이면 true — 부른 쪽은 그 click 을 버린다(펜처럼 touchend 로 막지 못하는 입력의 몫). */
  readonly consumeClick: () => boolean;
}

interface Press<E extends Element> {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly element: E;
  readonly timer: number;
}

export function useLongPress<E extends Element>(onLongPress: (element: E) => void): LongPressHandlers<E> {
  const onLongPressRef = useRef(onLongPress);
  useLayoutEffect(() => { onLongPressRef.current = onLongPress; });
  const pressRef = useRef<Press<E> | null>(null);
  const firedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const releaseTouchEndRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer);
    pressRef.current = null;
    releaseTouchEndRef.current?.();
  }, []);

  const [handlers] = useState<LongPressHandlers<E>>(() => {
    const cancel = () => {
      const press = pressRef.current;
      if (!press) return;
      window.clearTimeout(press.timer);
      pressRef.current = null;
    };
    // 손가락을 떼는 touchend 를 막아야 그 누름이 click 으로 이어지지 않는다 — 열린 메뉴나 시트가 같은 자리의 click 을 받지 않게.
    const swallowTouchEnd = () => {
      releaseTouchEndRef.current?.();
      const onTouchEnd = (event: TouchEvent) => {
        if (event.cancelable) event.preventDefault();
        release();
      };
      const release = () => {
        window.removeEventListener("touchend", onTouchEnd, true);
        window.removeEventListener("touchcancel", release, true);
        window.clearTimeout(fallback);
        if (releaseTouchEndRef.current === release) releaseTouchEndRef.current = null;
      };
      const fallback = window.setTimeout(release, 4_000);
      window.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
      window.addEventListener("touchcancel", release, true);
      releaseTouchEndRef.current = release;
    };
    const fire = () => {
      const press = pressRef.current;
      if (!press) return;
      window.clearTimeout(press.timer);
      pressRef.current = null;
      firedAtRef.current = performance.now();
      swallowTouchEnd();
      onLongPressRef.current(press.element);
    };
    return {
      onPointerDown: (event) => {
        cancel();
        if (event.pointerType === "mouse" || event.button !== 0 || !event.isPrimary) return;
        firedAtRef.current = Number.NEGATIVE_INFINITY;
        pressRef.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          element: event.currentTarget,
          timer: window.setTimeout(fire, LONG_PRESS_MS),
        };
      },
      onPointerMove: (event) => {
        const press = pressRef.current;
        if (!press || press.pointerId !== event.pointerId) return;
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP_PX) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      claimContextMenu: (event) => {
        if (pressRef.current) {
          event.preventDefault();
          fire();
          return true;
        }
        if (performance.now() - firedAtRef.current < AFTERMATH_MS) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      consumeClick: () => {
        if (performance.now() - firedAtRef.current >= AFTERMATH_MS) return false;
        firedAtRef.current = Number.NEGATIVE_INFINITY;
        return true;
      },
    };
  });
  return handlers;
}
