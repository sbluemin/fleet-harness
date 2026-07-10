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
    // 비활성 화면(라우트 이탈·focus mode)에서는 지연 이동을 만들지 않도록 pending을 즉시 완료한다.
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
      {sidebarClosed ? <button ref={sidebarHandleRef} type="button" className="float-handle float-left" onClick={onRestoreSidebar} aria-label="Expand sidebar" title="Expand sidebar"><ChromeHandleIcon /></button> : null}
      {railClosed ? <button ref={railHandleRef} type="button" className="float-handle float-right" onClick={onRestoreRail} aria-label="Show Activity Rail" title="Show Activity Rail"><ChromeHandleIcon /></button> : null}
    </>
  );
}


function ChromeHandleIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5.5h8.2M8.4 2.9l2.8 2.6-2.8 2.6M13 10.5H4.8M7.6 7.9l-2.8 2.6 2.8 2.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
