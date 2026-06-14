import { useEffect, useRef } from "react";

import { closeShell, SHELL_SESSION_ID } from "../store.js";
import type { ConsoleState } from "../types.js";
import { Terminal } from "./terminal.js";

interface ShellOverlayProps {
  readonly state: ConsoleState;
}

export function ShellOverlay({ state }: ShellOverlayProps) {
  // 셸을 열기 직전의 포커스(예: Admiral 터미널)를 보관했다가 닫을 때 복원한다.
  // 자식 Terminal이 focus()로 포커스를 가져가기 전(렌더 단계)에 읽어야 직전 포커스를 잃지 않는다.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  if (state.shellOpen && returnFocusRef.current === null) {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
  }

  useEffect(() => {
    if (!state.shellOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeShell();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      // 셸이 닫히면 직전 포커스로 되돌려 Admiral 터미널 입력이 끊기지 않게 한다.
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      target?.focus?.();
    };
  }, [state.shellOpen]);

  if (!state.shellOpen) return null;

  return (
    <div className="shell-overlay" role="dialog" aria-modal="true" aria-label="Shell">
      <button type="button" className="shell-overlay-scrim" onClick={closeShell} aria-label="Close shell" />
      <section className="shell-overlay-card">
        <header className="shell-overlay-header">
          <span className="shell-overlay-kicker">Free Shell</span>
          <h2>Local Shell</h2>
        </header>
        <button type="button" className="shell-overlay-close" onClick={closeShell} aria-label="Close shell">
          ×
        </button>
        <div className="shell-overlay-terminal">
          <Terminal key={SHELL_SESSION_ID} sessionId={SHELL_SESSION_ID} kind="shell" onExit={closeShell} />
        </div>
      </section>
    </div>
  );
}
