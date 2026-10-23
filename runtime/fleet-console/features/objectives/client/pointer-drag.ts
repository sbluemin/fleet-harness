import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

interface DragCallbacks {
  onStart(): void;
  onMove(event: PointerEvent): void;
  /** null은 취소다. 놓기 동작이나 영속 저장을 실행하지 않는다. */
  onEnd(event: PointerEvent | null): void;
}

/** 목록·그래프·폭 손잡이의 포인터 수명. 다시 잡기 전에 이전 추적과 리스너를 모두 끝낸다. */
export function usePointerDrag() {
  const active = useRef<(() => void) | null>(null);
  useEffect(() => () => active.current?.(), []);

  return (event: ReactPointerEvent, owner: HTMLElement, callbacks: DragCallbacks) => {
    if (event.button !== 0 || !event.isPrimary) return;
    active.current?.();
    const pointerId = event.pointerId;
    const doc = owner.ownerDocument, win = doc.defaultView!;
    let ended = false;
    const finish = (end: PointerEvent | null) => {
      if (ended) return;
      ended = true;
      active.current = null;
      win.removeEventListener("pointermove", move, true);
      win.removeEventListener("pointerup", up, true);
      win.removeEventListener("pointercancel", cancelPointer, true);
      win.removeEventListener("blur", cancel);
      win.removeEventListener("keydown", key, true);
      doc.removeEventListener("visibilitychange", visibility);
      owner.removeEventListener("lostpointercapture", lostCapture);
      if (owner.hasPointerCapture(pointerId)) owner.releasePointerCapture(pointerId);
      callbacks.onEnd(end);
    };
    const cancel = () => finish(null);
    const cancelPointer = (next: PointerEvent) => { if (next.pointerId === pointerId) cancel(); };
    const lostCapture = (next: PointerEvent) => {
      // 빠르게 다시 잡은 뒤 도착한 이전 lost 이벤트로 새 캡처까지 취소하지 않는다.
      if (next.pointerId === pointerId && !owner.hasPointerCapture(pointerId)) cancel();
    };
    const move = (next: PointerEvent) => {
      if (ended || next.pointerId !== pointerId) return;
      // 영역 밖에서 놓았거나 캡처가 끊긴 경우도, 눌리지 않은 이동으로 다시 끌리지 않는다.
      if ((next.buttons & 1) === 0) { cancel(); return; }
      callbacks.onMove(next);
    };
    const up = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(next); };
    const key = (next: KeyboardEvent) => {
      if (next.key !== "Escape") return;
      next.preventDefault(); next.stopPropagation(); cancel();
    };
    const visibility = () => { if (doc.hidden) cancel(); };
    active.current = cancel;
    win.addEventListener("pointermove", move, true);
    win.addEventListener("pointerup", up, true);
    win.addEventListener("pointercancel", cancelPointer, true);
    win.addEventListener("blur", cancel);
    win.addEventListener("keydown", key, true);
    doc.addEventListener("visibilitychange", visibility);
    owner.addEventListener("lostpointercapture", lostCapture);
    try { owner.setPointerCapture(pointerId); }
    catch { cancel(); return; }
    callbacks.onStart();
  };
}
