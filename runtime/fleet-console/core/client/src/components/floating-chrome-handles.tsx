import { useEffect, useRef } from "react";

type ChromeRestoreFocusTarget = "sidebar" | "rail" | null;

interface FloatingChromeHandlesProps {
  readonly active: boolean;
  readonly sidebarClosed: boolean;
  readonly railClosed: boolean;
  readonly pendingTarget: ChromeRestoreFocusTarget;
  readonly onRestoreSidebar: () => void;
  readonly onRestoreRail: () => void;
  readonly onFocusComplete: () => void;
}

export function FloatingChromeHandles({ active, sidebarClosed, railClosed, pendingTarget, onRestoreSidebar, onRestoreRail, onFocusComplete }: FloatingChromeHandlesProps) {
  const sidebarHandleRef = useRef<HTMLButtonElement>(null);
  const railHandleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (pendingTarget === null) return;
    // 비활성 화면(Operations 라우트 이탈)에서는 지연 이동을 만들지 않도록 pending을 즉시 완료한다.
    if (!active) {
      onFocusComplete();
      return;
    }
    const isClosed = pendingTarget === "sidebar" ? sidebarClosed : railClosed;
    const handle = pendingTarget === "sidebar" ? sidebarHandleRef.current : railHandleRef.current;
    const controllerSelector = pendingTarget === "sidebar"
      ? ".operations-side-bar .side-bar-collapse-btn"
      : ".right-rail .right-rail-chrome-toggle";
    const frame = window.requestAnimationFrame(() => {
      if (isClosed && handle?.isConnected) {
        handle.focus();
      } else {
        const controller = document.querySelector<HTMLElement>(controllerSelector);
        if (controller?.isConnected) controller.focus();
        else handle?.focus();
      }
      onFocusComplete();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, onFocusComplete, pendingTarget, railClosed, sidebarClosed]);

  if (!active) return null;
  return (
    <>
      {sidebarClosed ? <button ref={sidebarHandleRef} type="button" className="float-handle float-left" onClick={onRestoreSidebar} aria-label="Expand sidebar" title="Expand sidebar"><PanelExpandIcon side="left" /></button> : null}
      {railClosed ? <button ref={railHandleRef} type="button" className="float-handle float-right" onClick={onRestoreRail} aria-label="Show Activity Rail" title="Show Activity Rail"><PanelExpandIcon side="right" /></button> : null}
    </>
  );
}


/* 패널 확장 아이콘 — 사이드 영역이 채워진 패널 모양(#45 시안). side로 좌/우 미러. */
function PanelExpandIcon({ side }: { readonly side: "left" | "right" }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.75" y="3" width="12.5" height="10" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x={side === "left" ? 3 : 8.6} y="4.25" width="4.4" height="7.5" rx="1.2" fill="currentColor" />
    </svg>
  );
}
