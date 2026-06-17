import { useEffect, useRef } from "react";

import { OperationsCanvas } from "../canvas/canvas.js";
import { ensureDefaultGeometry, focusPanel, loadForTheater, prunePanels } from "../canvas/canvas-store.js";
import { clearShellPanels } from "../canvas/shell-panels.js";
import { resumeTerminalSession } from "../api.js";
import { FloatingJobOverlay } from "../components/floating-job-overlay.js";
import { FloatingSidebar } from "../components/floating-sidebar.js";
import { useOperationsMode } from "../operations-mode.js";
import { OperationsClassic } from "./operations-classic.js";
import { applySessionUpdate, consumeOperationFocus, failResumeTerminalSession, selectTerminalSession, theaterSessionOrder } from "../store.js";
import type { ConsoleState } from "../types.js";

interface OperationsProps {
  readonly state: ConsoleState;
}

export function Operations({ state }: OperationsProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const mode = useOperationsMode();
  const sessionOrder = theaterSessionOrder(state);

  useEffect(() => {
    loadForTheater(state.activeTheaterId);
    // Theater가 바뀌면 이전 Theater cwd에 묶인 ephemeral 셸 패널을 비운다(언마운트 → 백엔드 grace 정리).
    clearShellPanels();
  }, [state.activeTheaterId]);

  useEffect(() => {
    for (const sessionId of sessionOrder) ensureDefaultGeometry(sessionId);
    prunePanels(sessionOrder);
  }, [sessionOrder]);

  // 검색 등에서 들어온 일회성 이동 요청을 처리한다. 위의 loadForTheater/ensureDefaultGeometry
  // effect가 먼저 선언되어 해당 Theater의 패널이 로드·보장된 뒤 실행되므로 focusPanel이 안전하다.
  // Helm(classic)은 사이드바 선택만으로 해당 Operation이 보이므로 확대 없이 신호만 비운다.
  useEffect(() => {
    const sessionId = state.pendingOperationFocus;
    if (sessionId === null) return;
    // Helm(classic)은 사이드바 선택만으로 보이므로 확대 없이 신호만 비운다.
    if (mode === "classic") {
      consumeOperationFocus();
      return;
    }
    // consumeOperationFocus()는 pendingOperationFocus를 비워 이 effect를 재실행시킨다. 최상단에서
    // 동기로 비우면 resume await 도중 cleanup이 cancelled를 세워 자기-취소되어(점프가 resume만 하고
    // 확대를 건너뜀) 버린다. 그래서 모든 작업을 마친 뒤 마지막에 비운다. sessions도 의존성에서 제외해
    // resume이 유발하는 sessions 갱신이 in-flight 작업을 취소하지 않게 한다(트리거 시점 스냅샷 사용).
    let cancelled = false;
    const focusPendingOperation = async () => {
      let focusedSessionId = sessionId;
      const session = state.sessions[sessionId];
      if (session?.status === "dormant") {
        try {
          const resumed = await resumeTerminalSession(sessionId);
          if (cancelled) return;
          applySessionUpdate(resumed);
          selectTerminalSession(resumed.sessionId);
          focusedSessionId = resumed.sessionId;
        } catch (error) {
          if (!cancelled) failResumeTerminalSession(error instanceof Error ? error.message : String(error));
          consumeOperationFocus();
          return;
        }
      }
      if (cancelled) return;
      const viewportSize = viewportSizeFor(bodyRef.current);
      if (viewportSize) focusPanel(focusedSessionId, viewportSize);
      consumeOperationFocus();
    };
    void focusPendingOperation();
    return () => {
      cancelled = true;
    };
    // sessions는 의도적으로 의존성에서 제외한다(위 주석).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.pendingOperationFocus, mode]);

  if (mode === "classic") return <OperationsClassic state={state} />;

  return (
    <div className="console-body is-canvas" ref={bodyRef}>
      <OperationsCanvas state={state} />
      <FloatingSidebar state={state} getViewportSize={() => viewportSizeFor(bodyRef.current)} />
      <FloatingJobOverlay state={state} />
    </div>
  );
}

function viewportSizeFor(element: HTMLElement | null): { readonly width: number; readonly height: number } | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}
