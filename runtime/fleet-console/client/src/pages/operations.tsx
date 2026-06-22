import { useEffect, useMemo, useRef } from "react";

import { OperationsCanvas } from "../canvas/canvas.js";
import { ensureDefaultGeometry, focusPanel, loadForTheater, prunePanels } from "../canvas/canvas-store.js";
import { getActiveShellId, loadShellPanelsForTheater } from "../canvas/shell-panels.js";
import { clearMaximizedPanelId, focusWindowPanel, getMaximizedPanelId, getPanelHandles, maximizeWindowPanel, nextPanelHandle, pruneDanglingMaximizedPanelId } from "../canvas/window-registry.js";
import { resumeTerminalSession } from "../api.js";
import { FloatingJobOverlay } from "../components/floating-job-overlay.js";
import { applySessionUpdate, consumeOperationFocus, failResumeTerminalSession, selectTerminalSession, theaterSessionOrder } from "../store.js";
import type { ConsoleState } from "../types.js";

interface OperationsProps {
  readonly state: ConsoleState;
}

export function Operations({ state }: OperationsProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // theaterSessionOrder는 매 호출 새 배열을 반환하므로 참조를 안정화한다 — 아래 prune effect가 매 렌더 도는 것을 막는다.
  const sessionOrder = useMemo(() => theaterSessionOrder(state), [state.sessions, state.sessionOrder, state.activeTheaterId]);
  // 최신 state를 keydown 핸들러에서 읽기 위한 ref(핸들러는 한 번만 등록).
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    loadForTheater(state.activeTheaterId);
    // 셸 패널도 같은 activeTheaterId 기준으로 복원한다(새로고침 후 유지, Theater 전환 시 해당 Theater 셸로 교체).
    // Operations 패널의 loadForTheater와 대칭이며, 이전 Theater의 보류 저장은 내부에서 flush된다.
    loadShellPanelsForTheater(state.activeTheaterId);
  }, [state.activeTheaterId]);

  // Alt+←/→ 로 현재 Theater 내 Operation 포커스를 순환 이동한다.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      // rename/검색 등 일반 입력 중에는 양보한다. 단, 터미널(xterm) 포커스 중에는 패널 전환을 허용한다.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches("input, textarea, [contenteditable='true']") && !active.closest(".xterm")) return;
      const order = theaterSessionOrder(stateRef.current);
      const handles = getPanelHandles(order);
      if (handles.length === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const maximizedPanelId = getMaximizedPanelId();
      // 비-최대화 순환 앵커: 활성 Operation이 없으면 활성 Shell을 기준으로 삼아, 셸에 포커스된 채로도 순차 순환이 이어지게 한다.
      const currentId = maximizedPanelId ?? stateRef.current.activeTerminalSessionId ?? getActiveShellId();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const next = nextPanelHandle(handles, currentId, delta);
      if (!next) return;
      if (maximizedPanelId) {
        // 최대화 전환: 대상만 복원·최대화하고 이전 최대화 패널 포함 나머지는 Dock으로. viewport는 고정.
        maximizeWindowPanel(next, handles);
        return;
      }
      const viewportSize = viewportSizeFor(bodyRef.current);
      if (viewportSize) focusWindowPanel(next, viewportSize);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  useEffect(() => {
    // 알려진 세션에는 항상 geometry를 보장한다 — 적재 실패 후 SSE로 늦게 도착한 세션도 캔버스에 보이게 한다
    // (geometry가 없으면 OperationsCanvas가 그 패널을 렌더하지 않는다). ensureDefaultGeometry는 기존 패널을
    // 덮어쓰지 않으므로 복원된 레이아웃에도 안전하다.
    for (const sessionId of sessionOrder) ensureDefaultGeometry(sessionId);
    // prune만 가드한다 — 첫 sessions 스냅샷 적재 전 빈 sessionOrder는 "로딩 중"이라, 이때 정리하면 방금 복원한
    // 패널을 지운다(bootstrap이 sessions보다 먼저 도착하는 race). 적재 완료(권위 있는 상태) 후에만 정리한다.
    if (!state.terminalSessionsHydrated) return;
    prunePanels(sessionOrder);
  }, [sessionOrder, state.terminalSessionsHydrated]);

  useEffect(() => {
    pruneDanglingMaximizedPanelId(sessionOrder, {
      operationSessionsHydrated: state.terminalSessionsHydrated,
      shellPanelsHydrated: true,
      theaterReady: state.activeTheaterId !== null,
    });
  }, [sessionOrder, state.activeTheaterId, state.terminalSessionsHydrated]);

  // 검색 등에서 들어온 일회성 이동 요청을 처리한다. 위의 loadForTheater/ensureDefaultGeometry
  // effect가 먼저 선언되어 해당 Theater의 패널이 로드·보장된 뒤 실행되므로 focusPanel이 안전하다.
  useEffect(() => {
    const sessionId = state.pendingOperationFocus;
    if (sessionId === null) return;
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
      // 검색/알림 점프는 패널 최대화를 해제한다(idempotent) — 안 그러면 대상이 최대화 오버레이 뒤로 포커스되어 화면이 그대로 보인다.
      clearMaximizedPanelId();
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
  }, [state.pendingOperationFocus]);

  return (
    <div className="console-body is-canvas" ref={bodyRef}>
      <OperationsCanvas state={state} />
      <FloatingJobOverlay state={state} />
    </div>
  );
}

function viewportSizeFor(element: HTMLElement | null): { readonly width: number; readonly height: number } | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}
