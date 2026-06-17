import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";

import { renameTerminalSession, resumeTerminalSession, terminateTerminalSession } from "../api.js";
import { CarrierJobLines } from "../components/carrier-job-lines.js";
import { Terminal } from "../components/terminal.js";
import { sessionDisplayLabel } from "../format.js";
import { isTerminalJobStatus } from "../reduce.js";
import { applySessionUpdate, failRenameTerminalSession, failResumeTerminalSession, failTerminateTerminalSession, removeTerminalSession, selectJob, selectTerminalSession, sessionJobs } from "../store.js";
import type { ConsoleState, SessionInfo } from "../types.js";
import { focusPanel, setPanelGeometry, setViewport, type CanvasViewport, type PanelGeometry } from "./canvas-store.js";
import { PanelResizeHandles } from "./panel-resize.js";

interface CanvasPanelProps {
  readonly state: ConsoleState;
  readonly session: SessionInfo;
  readonly geometry: PanelGeometry;
  readonly viewport: CanvasViewport;
  readonly active: boolean;
  readonly getCanvasRect: () => DOMRect | null;
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly geometry: PanelGeometry;
}

// 제목 탭 더블클릭 판정: beginDrag가 pointerdown에서 preventDefault/pointer-capture를 호출해
// native dblclick이 신뢰되지 않으므로, 두 번의 pointerdown 간격·이동량으로 직접 더블클릭을 가린다.
const TITLE_DOUBLE_CLICK_MS = 320;
const TITLE_DOUBLE_CLICK_DISTANCE = 6;

export function CanvasPanel({ state, session, geometry, viewport, active, getCanvasRect }: CanvasPanelProps) {
  const dragRef = useRef<DragState | null>(null);
  const lastTitlePointerRef = useRef<{ readonly time: number; readonly x: number; readonly y: number } | null>(null);
  const [restoreViewport, setRestoreViewport] = useState<CanvasViewport | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const committingRef = useRef(false);
  const skipBlurCommitRef = useRef(false);
  const jobs = sessionJobs(state, session);
  const activeJobs = jobs.filter(({ job }) => !isTerminalJobStatus(job.status)).map(({ job }) => job);
  const activeJobCount = activeJobs.length;
  const dormant = session.status === "dormant";
  const live = activeJobCount > 0 || session.status === "registered" || session.status === "live" || session.status === "terminal-only";
  const displayLabel = sessionDisplayLabel(session);

  const bringToFront = () => {
    selectTerminalSession(session.sessionId);
    setPanelGeometry(session.sessionId, geometry);
  };

  // dock의 job을 선택할 때, 비활성 패널이면 먼저 그 세션을 활성화해야 JobOverlay가 해당 tenant에서
  // job을 찾는다(selectedJob은 activeTerminalSessionId의 tenant 기준). 활성 패널이면 toggle 동작을 유지한다.
  const selectDockJob = (jobId: string) => {
    if (!active) selectTerminalSession(session.sessionId);
    selectJob(jobId);
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    // 제목 탭 더블클릭 → 포커스 토글(확대 ↔ 복귀). 근접한 두 번째 pointerdown이면 드래그 대신 포커스로 처리한다.
    const now = Date.now();
    const last = lastTitlePointerRef.current;
    if (
      last
      && now - last.time < TITLE_DOUBLE_CLICK_MS
      && Math.abs(event.clientX - last.x) < TITLE_DOUBLE_CLICK_DISTANCE
      && Math.abs(event.clientY - last.y) < TITLE_DOUBLE_CLICK_DISTANCE
    ) {
      lastTitlePointerRef.current = null;
      handleFocusToggle();
      return;
    }
    lastTitlePointerRef.current = { time: now, x: event.clientX, y: event.clientY };
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

  const handleFocusToggle = () => {
    bringToFront();
    if (restoreViewport) {
      setViewport(restoreViewport);
      setRestoreViewport(null);
      return;
    }
    const canvasRect = getCanvasRect();
    if (!canvasRect) return;
    setRestoreViewport(viewport);
    setPanelGeometry(session.sessionId, geometry);
    focusPanel(session.sessionId, { width: canvasRect.width, height: canvasRect.height });
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
      className={`canvas-panel ${active ? "is-active" : ""}`}
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
        data-canvas-blocker
      >
        <span className={`tenant-beacon ${live ? "is-live" : dormant ? "is-dormant" : ""}`} aria-hidden="true" />
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
            onDoubleClick={beginRename}
            title="Double-click to rename"
          >
            {displayLabel}
          </span>
        )}
        <span className="canvas-panel-cli">{session.cliLabel ?? session.cliId ?? "CLI"}</span>
        {activeJobCount > 0 ? <span className="canvas-panel-job-count">{activeJobCount}</span> : null}
        <button
          type="button"
          className={`canvas-panel-icon-button ${restoreViewport ? "is-active" : ""}`}
          onPointerDown={stopButtonPointer}
          onClick={handleFocusToggle}
          aria-label={restoreViewport ? "터미널 포커스 복귀" : "터미널 확대 포커스"}
          title={restoreViewport ? "Restore canvas" : "Focus terminal"}
        >
          {restoreViewport ? <CollapseIcon /> : <ExpandIcon />}
        </button>
        <button
          type="button"
          className="canvas-panel-icon-button"
          onPointerDown={stopButtonPointer}
          onClick={() => { void closeSession(session.sessionId); }}
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
          <Terminal sessionId={session.sessionId} active={active} onExit={() => removeTerminalSession(session.sessionId)} />
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

function ExpandIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.8 3.4H3.4v2.4M10.2 3.4h2.4v2.4M5.8 12.6H3.4v-2.4M10.2 12.6h2.4v-2.4" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.8 6h2.4V3.6M12.2 6H9.8V3.6M3.8 10h2.4v2.4M12.2 10H9.8v2.4" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
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
