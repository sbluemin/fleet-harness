import { useEffect, useRef } from "react";

const EXIT_FALLBACK_SELECTOR = ".operations-side-bar .side-bar-collapse-btn, .float-handle, .page-back-link, main h2";

/* focus mode 리빌 핸들 + 포커스 컨트롤러 — 진입 시 이전 포커스를 저장하고 리빌로 이동,
   종료(unmount) 시 유효한 이전 target 또는 현재 화면의 안정 컨트롤로 복원한다.
   진입 트리거(context-menu item)는 리빌 mount 전에 unmount되는 것이 정상 경로라,
   body/documentElement/리빌 자신은 복원 대상에서 제외하고 폴백 체인으로 처리한다. */
export function FocusModeReveal({ onExit }: { readonly onExit: () => void }) {
  const revealRef = useRef<HTMLButtonElement>(null);
  const returnTargetRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnTargetRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => revealRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      const target = returnTargetRef.current;
      returnTargetRef.current = null;
      window.requestAnimationFrame(() => {
        if (isValidReturnTarget(target)) {
          target.focus();
          return;
        }
        const fallback = document.querySelector<HTMLElement>(EXIT_FALLBACK_SELECTOR);
        if (!fallback) return;
        if (fallback.tabIndex < 0 && !(fallback instanceof HTMLButtonElement) && !(fallback instanceof HTMLAnchorElement)) {
          fallback.setAttribute("tabindex", "-1");
        }
        fallback.focus();
      });
    };
  }, []);

  return (
    <button ref={revealRef} type="button" className="focus-mode-reveal" onClick={onExit} aria-label="Exit focus mode" title="Exit focus mode">
      <FocusModeIcon />
    </button>
  );
}

function isValidReturnTarget(target: HTMLElement | null): target is HTMLElement {
  if (!target || !target.isConnected) return false;
  if (target === document.body || target === document.documentElement) return false;
  if (target.classList.contains("focus-mode-reveal")) return false;
  return true;
}

function FocusModeIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
