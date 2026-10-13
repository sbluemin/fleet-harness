import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

/**
 * 터치·펜의 길게 누르기 — 우클릭이 없는 손가락이 컨텍스트 메뉴를 여는 길이다. 마우스는 우클릭이 있으니 받지 않는다.
 * 한도를 넘게 움직이면 끌기·스크롤로 보고 취소한다(사이드바 끌기 문턱과 같은 값). 브라우저가 스크롤을 가져가면 pointercancel 이 취소한다.
 */
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 6;
/** 길게 누르기 뒤 이 안에 오는 contextmenu 는 같은 누름의 꼬리다. */
const AFTERMATH_MS = 800;
/** 누른 손가락을 뗀 뒤 브라우저가 click 을 합성하기까지 기다리는 한도 — 그 사이의 click 만 같은 누름의 것으로 본다. */
const RELEASE_CLICK_MS = 600;
/** 떼는 소식(pointerup)을 끝내 듣지 못했을 때 차단을 거두는 한도. 새 누름이 오면 그 전에 거둔다. */
const GUARD_FALLBACK_MS = 30_000;

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
}

interface Press<E extends Element> {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly element: E;
  readonly timer: number;
}

const SWALLOWED_EVENTS = ["click", "mousedown", "mouseup"] as const;
let disarmReleaseGuard: (() => void) | null = null;

/**
 * 길게 누르기가 터진 뒤 그 손가락을 떼며 생기는 click 을 문서 어디에서든 삼킨다 — 열린 메뉴나 새로 쌓인 시트의 같은 자리 항목이
 * 그 click 을 받아 실행되지 않게. 누른 행이 메뉴를 열며 사라져도(폰 Theater 시트가 동작 시트로 바뀌는 경우) touchend 는 문서에서
 * 빠진 그 행으로 가서 window 에 오지 않으므로, touchend 가 아니라 click(과 호환 마우스 사건)을 window 캡처 단계에서 막는다.
 * 컴포넌트와 수명을 묶지 않는다: 누른 행이 언마운트돼도 차단은 그 click, 떼고 난 짧은 시간, 새 누름 중 먼저 오는 것까지 남는다.
 */
function armReleaseGuard(pointerId: number): void {
  disarmReleaseGuard?.();
  let releaseTimer: number | undefined;
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "click") disarm();
  };
  const onTouchEnd = (event: TouchEvent) => { if (event.cancelable) event.preventDefault(); };
  const onRelease = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    window.clearTimeout(releaseTimer);
    releaseTimer = window.setTimeout(disarm, RELEASE_CLICK_MS);
  };
  // 다른 포인터의 새 누름은 새 몸짓이다 — 그 click 은 사람이 고른 것이므로 차단을 거둔다.
  const onNewPress = (event: PointerEvent) => { if (event.pointerId !== pointerId) disarm(); };
  const fallback = window.setTimeout(() => disarm(), GUARD_FALLBACK_MS);
  function disarm() {
    for (const type of SWALLOWED_EVENTS) window.removeEventListener(type, swallow, true);
    window.removeEventListener("touchend", onTouchEnd, true);
    window.removeEventListener("pointerup", onRelease, true);
    window.removeEventListener("pointercancel", onRelease, true);
    window.removeEventListener("pointerdown", onNewPress, true);
    window.clearTimeout(releaseTimer);
    window.clearTimeout(fallback);
    if (disarmReleaseGuard === disarm) disarmReleaseGuard = null;
  }
  for (const type of SWALLOWED_EVENTS) window.addEventListener(type, swallow, true);
  // 누른 자리가 남아 있으면 touchend 도 window 에 온다 — 그때는 click 합성 자체를 막는다.
  window.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
  window.addEventListener("pointerup", onRelease, true);
  window.addEventListener("pointercancel", onRelease, true);
  window.addEventListener("pointerdown", onNewPress, true);
  disarmReleaseGuard = disarm;
}

export function useLongPress<E extends Element>(onLongPress: (element: E) => void): LongPressHandlers<E> {
  const onLongPressRef = useRef(onLongPress);
  useLayoutEffect(() => { onLongPressRef.current = onLongPress; });
  const pressRef = useRef<Press<E> | null>(null);
  const firedAtRef = useRef(Number.NEGATIVE_INFINITY);

  // 언마운트는 아직 터지지 않은 누름만 거둔다. 이미 터진 누름의 click 차단은 armReleaseGuard 가 스스로 거둔다.
  useEffect(() => () => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  }, []);

  const [handlers] = useState<LongPressHandlers<E>>(() => {
    const cancel = () => {
      const press = pressRef.current;
      if (!press) return;
      window.clearTimeout(press.timer);
      pressRef.current = null;
    };
    const fire = () => {
      const press = pressRef.current;
      if (!press) return;
      window.clearTimeout(press.timer);
      pressRef.current = null;
      firedAtRef.current = performance.now();
      armReleaseGuard(press.pointerId);
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
        // 사이드바 끌기는 문턱에 닿는 순간(>=) 시작하므로 같은 경계에서 취소해야 한 손짓이 끌기와 길게 누르기가 함께 되지 않는다.
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) >= LONG_PRESS_SLOP_PX) cancel();
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
    };
  });
  return handlers;
}
