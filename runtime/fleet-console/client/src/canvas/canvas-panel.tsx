import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";

import { renameTerminalSession, resumeTerminalSession, terminateTerminalSession } from "../api.js";
import { CarrierJobLines } from "../components/carrier-job-lines.js";
import { Terminal } from "../components/terminal.js";
import { sessionBeaconClassName, sessionDisplayLabel } from "../format.js";
import { isTerminalJobStatus } from "../reduce.js";
import { applySessionUpdate, failRenameTerminalSession, failResumeTerminalSession, failTerminateTerminalSession, removeTerminalSession, selectJob, selectTerminalSession, sessionJobs } from "../store.js";
import type { ConsoleState, SessionInfo } from "../types.js";
import { setPanelGeometry, type CanvasViewport, type PanelGeometry } from "./canvas-store.js";
import { PanelResizeHandles } from "./panel-resize.js";
import { clearMaximizedPanelId, minimizeWindowPanel, operationPanelHandle } from "./window-registry.js";

interface CanvasPanelProps {
  readonly state: ConsoleState;
  readonly session: SessionInfo;
  readonly geometry: PanelGeometry;
  readonly viewport: CanvasViewport;
  readonly active: boolean;
  // 최대화 오버레이 렌더 여부 — drag/geometry 영속을 막고 닫기 시 최대화를 해제한다.
  readonly maximized?: boolean;
  readonly onFocusRequest: () => void;
  readonly onMaximize: () => void;
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly geometry: PanelGeometry;
}

export function CanvasPanel({ state, session, geometry, viewport, active, maximized = false, onFocusRequest, onMaximize }: CanvasPanelProps) {
  const dragRef = useRef<DragState | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const committingRef = useRef(false);
  const skipBlurCommitRef = useRef(false);
  const jobs = sessionJobs(state, session);
  const activeJobs = jobs.filter(({ job }) => !isTerminalJobStatus(job.status)).map(({ job }) => job);
  const activeJobCount = activeJobs.length;
  const dormant = session.status === "dormant";
  const displayLabel = sessionDisplayLabel(session);
  const awaitingInput = state.operationNotifications[session.sessionId]?.kind === "input-waiting";
  // 외곽 "물결(wake)" 효과 상태: 비콘(인디케이터)과 동일한 색 의미를 따른다.
  // 입력 대기 → "awaiting"(warn/amber), 활성 캐리어 job → "live"(aurora), 그 외 에이전트 턴 진행 → "turn"(warn/amber).
  const underwayState: "awaiting" | "live" | "turn" | null = dormant
    ? null
    : awaitingInput
      ? "awaiting"
      : activeJobCount > 0
      ? "live"
      : session.turnState === "running"
        ? "turn"
        : null;

  const bringToFront = () => {
    selectTerminalSession(session.sessionId);
    // 최대화 오버레이에선 패널이 오버레이 전용 geometry를 받으므로 그것을 저장 geometry로 영속하면 안 된다
    // (복원 시 원래 위치·크기 손실). 활성화만 하고 geometry 영속은 건너뛴다.
    if (!maximized) setPanelGeometry(session.sessionId, geometry);
  };

  // dock의 job을 선택할 때, 비활성 패널이면 먼저 그 세션을 활성화해야 JobOverlay가 해당 tenant에서
  // job을 찾는다(selectedJob은 activeTerminalSessionId의 tenant 기준). 활성 패널이면 toggle 동작을 유지한다.
  const selectDockJob = (jobId: string) => {
    if (!active) selectTerminalSession(session.sessionId);
    selectJob(jobId);
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // 최대화 상태에선 드래그 이동을 막는다(updateDrag가 오버레이 좌표를 저장 geometry에 덮어쓰지 않게).
    if (maximized) return;
    event.preventDefault();
    event.stopPropagation();
    bringToFront();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      geometry,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    setPanelGeometry(session.sessionId, {
      ...drag.geometry,
      x: drag.geometry.x + (event.clientX - drag.startX) / viewport.zoom,
      y: drag.geometry.y + (event.clientY - drag.startY) / viewport.zoom,
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const stopButtonPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  useEffect(() => {
    if (!renaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming]);

  // 이름 영역 더블클릭 → 인라인 이름 변경. Operations(FloatingSessionEntry)의 rename 동작을 그대로 따른다.
  const beginRename = () => {
    bringToFront();
    skipBlurCommitRef.current = false;
    setDraftLabel(displayLabel);
    setRenaming(true);
  };

  const cancelRename = () => {
    skipBlurCommitRef.current = true;
    setRenaming(false);
    setDraftLabel("");
  };

  const commitRename = async () => {
    if (committingRef.current) return;
    committingRef.current = true;
    try {
      applySessionUpdate(await renameTerminalSession(session.sessionId, draftLabel));
    } catch (error) {
      failRenameTerminalSession(error instanceof Error ? error.message : String(error));
    } finally {
      committingRef.current = false;
      skipBlurCommitRef.current = true;
      setRenaming(false);
    }
  };

  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitRename();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRename();
    }
  };

  // 이름 영역 pointerdown은 드래그/포커스 경로(beginDrag)로 전파하지 않는다 — 더블클릭은 오직 rename.
  const onNamePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    bringToFront();
  };

  const stopCanvasPointer = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    bringToFront();
  };

  const stopCanvasWheel = (event: ReactWheelEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  return (
    <>
    <article
      className={`canvas-panel ${active ? "is-active" : ""} ${underwayState ? `is-running is-running--${underwayState}` : ""}`}
      style={{
        left: geometry.x,
        top: geometry.y,
        width: geometry.width,
        height: geometry.height,
        zIndex: geometry.zIndex,
      }}
      onPointerDown={bringToFront}
      data-canvas-panel
      aria-label={`Operation ${displayLabel}`}
    >
      <div
        className="canvas-panel-titlebar"
        onPointerDown={beginDrag}
        onPointerMove={updateDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onFocusRequest}
        data-canvas-blocker
      >
        <span className={sessionBeaconClassName(session, activeJobCount)} aria-hidden="true" />
        {renaming ? (
          <input
            ref={inputRef}
            className="canvas-panel-rename-input"
            value={draftLabel}
            aria-label={`${displayLabel} 이름 변경`}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => setDraftLabel(event.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={() => {
              if (skipBlurCommitRef.current) {
                skipBlurCommitRef.current = false;
                return;
              }
              void commitRename();
            }}
          />
        ) : (
          <span
            className="canvas-panel-title"
            onPointerDown={onNamePointerDown}
            onDoubleClick={(event) => {
              event.stopPropagation();
              beginRename();
            }}
            title="Double-click to rename"
          >
            {displayLabel}
          </span>
        )}
        <span className="canvas-panel-cli">{session.cliLabel ?? session.cliId ?? "CLI"}</span>
        {activeJobCount > 0 ? <span className="canvas-panel-job-count">{activeJobCount}</span> : null}
        <button
          type="button"
          className="canvas-panel-icon-button"
          onPointerDown={stopButtonPointer}
          onClick={() => { minimizeWindowPanel(operationPanelHandle(session.sessionId)); }}
          aria-label={`Minimize operation ${displayLabel}`}
          title="Minimize panel"
        >
          <MinimizeIcon />
        </button>
        <button
          type="button"
          className={`canvas-panel-icon-button ${maximized ? "is-active" : ""}`}
          onPointerDown={stopButtonPointer}
          onClick={onMaximize}
          aria-label={maximized ? `Restore operation ${displayLabel}` : `Maximize operation ${displayLabel}`}
          title={maximized ? "Restore panel" : "Maximize panel"}
        >
          <MaximizePanelIcon />
        </button>
        <button
          type="button"
          className="canvas-panel-icon-button"
          onPointerDown={stopButtonPointer}
          onClick={() => { if (maximized) clearMaximizedPanelId(); void closeSession(session.sessionId); }}
          aria-label={`${dormant ? "Forget" : "Terminate"} operation ${displayLabel}`}
          title={dormant ? "Forget operation" : "Terminate operation"}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="canvas-panel-terminal" onPointerDown={stopCanvasPointer} onWheel={stopCanvasWheel} data-canvas-blocker>
        {dormant ? (
          <button type="button" className="canvas-panel-dormant" onClick={() => { void resumeSession(session.sessionId); }}>
            <span className="canvas-panel-dormant-status">Dormant</span>
            <span className="canvas-panel-dormant-action">Resume</span>
          </button>
        ) : (
          <Terminal sessionId={session.sessionId} active={active} zoom={viewport.zoom} onExit={() => { if (maximized) clearMaximizedPanelId(); removeTerminalSession(session.sessionId); }} />
        )}
      </div>
      <PanelResizeHandles geometry={geometry} zoom={viewport.zoom} onResize={(nextGeometry) => setPanelGeometry(session.sessionId, nextGeometry)} />
    </article>
    {activeJobs.length > 0 ? (
      // 진행 중 캐리어 스트림을 패널 '바깥 아래'에 floating으로 띄운다(터미널 출력을 가리지 않음).
      // world 좌표계에 두어 패널과 함께 이동·확대되며, top을 패널 하단 모서리에 맞춰 그 아래로 정렬한다.
      <div
        className="canvas-panel-jobdock"
        style={{ left: geometry.x, top: geometry.y + geometry.height, width: geometry.width, zIndex: geometry.zIndex }}
        data-canvas-blocker
        aria-label={`Active carrier jobs for ${displayLabel}`}
      >
        <CarrierJobLines jobs={activeJobs} selectedJobId={state.selectedJobId} onSelect={selectDockJob} />
      </div>
    ) : null}
    </>
  );
}

async function resumeSession(sessionId: string): Promise<void> {
  try {
    const resumed = await resumeTerminalSession(sessionId);
    applySessionUpdate(resumed);
    selectTerminalSession(resumed.sessionId);
  } catch (error) {
    failResumeTerminalSession(error instanceof Error ? error.message : String(error));
  }
}

async function closeSession(sessionId: string): Promise<void> {
  try {
    await terminateTerminalSession(sessionId);
  } catch (error) {
    failTerminateTerminalSession(error instanceof Error ? error.message : String(error));
    return;
  }
  removeTerminalSession(sessionId);
}

function MinimizeIcon() {
  // 타이틀바 하단 수평선 — 패널이 아래(태스크바)로 가라앉는 방향성을 내재한 최소화 마크.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 11.5h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function MaximizePanelIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.2 4.2h7.6v7.6H4.2z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}
