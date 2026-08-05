import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { setSideBarCollapsed, setSideBarWidth, useSideBarState } from "./operations-side-bar-store.js";

// Map과 War Room 사이드바는 같은 좌측 열 상태를 공유한다 — 폭과 접힘을 바꾸는
// 조작 표면도 한 구현을 써야 모드 전환 사이에서 같은 계약을 지킨다.
export function useSideBarResize(): {
  readonly resizing: boolean;
  readonly onPointerDown: (event: ReactPointerEvent) => void;
  readonly onDoubleClick: () => void;
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

  const onDoubleClick = useCallback(() => {
    setSideBarCollapsed(!sideBar.collapsed);
  }, [sideBar.collapsed]);

  return { resizing, onPointerDown, onDoubleClick };
}

export function SideBarResizeHandle({
  onPointerDown,
  onDoubleClick,
}: {
  readonly onPointerDown: (event: ReactPointerEvent) => void;
  readonly onDoubleClick: () => void;
}) {
  return (
    <div
      className="operations-side-bar-resize-handle"
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      aria-hidden="true"
    />
  );
}
