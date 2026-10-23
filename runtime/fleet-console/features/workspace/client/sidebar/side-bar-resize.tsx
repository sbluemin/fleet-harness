import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { setSideBarWidth, useSideBarState } from "./objective-records-side-bar-store.js";

// 사이드바 폭을 바꾸는 조작 표면 — 사이드바는 접히지 않으므로 폭만 바꾼다.
export function useSideBarResize(): {
  readonly resizing: boolean;
  readonly onPointerDown: (event: ReactPointerEvent) => void;
} {
  const sideBar = useSideBarState();
  const [resizing, setResizing] = useState(false);
  const removeListenersRef = useRef<(() => void) | null>(null);

  useEffect(() => () => removeListenersRef.current?.(), []);

  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sideBar.width;
    setResizing(true);

    const onMove = (moveEvent: PointerEvent) => {
      setSideBarWidth(startWidth + (moveEvent.clientX - startX));
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
  }, [sideBar.width]);

  return { resizing, onPointerDown };
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
