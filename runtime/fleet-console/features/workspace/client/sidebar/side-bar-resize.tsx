import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import {
  MIN_EXPANDED_PX,
  getSideBarState,
  setSideBarManualCompact,
  setSideBarWidth,
  sideBarDragCanResize,
  sideBarOccupiedWidth,
} from "./objective-records-side-bar-store.js";

/**
 * 끌기의 걸림 — 펼친 폭의 하한(MIN_EXPANDED_PX)에서 열이 한 번 멈춰 서고, 포인터가 거기서 이만큼 더 물러나야 좁은 열로 넘어간다.
 * 좁은 열에서 되돌릴 때는 포인터가 하한 가까이(ENTER보다 바깥쪽)에 닿아야 펼쳐진다. 두 문턱 사이의 간격이 경계 떨림을 막는다.
 */
const COMPACT_ENTER_AT_PX = MIN_EXPANDED_PX - 48;
const COMPACT_EXIT_AT_PX = MIN_EXPANDED_PX - 24;

// 사이드바 폭을 바꾸는 조작 표면 — 사이드바는 접히지 않고, 하한 아래로 끌면 좁은 열로 넘어간다.
export function useSideBarResize(): {
  readonly resizing: boolean;
  /** 좁은 열로 넘어간 직후의 짧은 순간 — 폭이 뚝 끊기지 않고 미끄러지게 전환을 켠다. */
  readonly snapping: boolean;
  readonly onPointerDown: (event: ReactPointerEvent) => void;
} {
  const [resizing, setResizing] = useState(false);
  const [snapping, setSnapping] = useState(false);
  const snapTimerRef = useRef<number | undefined>(undefined);
  const removeListenersRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    removeListenersRef.current?.();
    window.clearTimeout(snapTimerRef.current);
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    event.preventDefault();
    const start = getSideBarState();
    if (!sideBarDragCanResize(start)) return;
    const startX = event.clientX;
    // 포인터가 잡은 가장자리의 위치 — 좁은 열에서 시작하면 그 열의 폭에서, 펼친 폭에서 시작하면 그 폭에서 센다.
    const startEdge = sideBarOccupiedWidth(start);
    setResizing(true);

    const onMove = (moveEvent: PointerEvent) => {
      const edge = startEdge + (moveEvent.clientX - startX);
      const compact = getSideBarState().manualCompact
        ? edge < COMPACT_EXIT_AT_PX
        : edge < COMPACT_ENTER_AT_PX;
      if (compact !== getSideBarState().manualCompact) {
        setSnapping(true);
        window.clearTimeout(snapTimerRef.current);
        snapTimerRef.current = window.setTimeout(() => setSnapping(false), 260);
      }
      setSideBarManualCompact(compact);
      // 좁은 열이면 기억된 폭을 그대로 두고, 펼친 쪽이면 하한에서 걸려 멈춘다(setSideBarWidth가 하한을 지킨다).
      if (!compact) setSideBarWidth(edge);
    };

    const removeListeners = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("pointercancel", onEnd);
      if (removeListenersRef.current === removeListeners) removeListenersRef.current = null;
    };

    const onEnd = () => {
      setResizing(false);
      removeListeners();
    };

    removeListenersRef.current?.();
    removeListenersRef.current = removeListeners;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
  }, []);

  return { resizing, snapping, onPointerDown };
}

export function SideBarResizeHandle({
  onPointerDown,
}: {
  readonly onPointerDown: (event: ReactPointerEvent) => void;
}) {
  return (
    <div
      className="objective-records-side-bar-resize-handle"
      onPointerDown={onPointerDown}
      aria-hidden="true"
    />
  );
}
