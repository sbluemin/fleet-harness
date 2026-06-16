import { useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";

import { terminateTerminalSession } from "../api.js";
import { Terminal } from "../components/terminal.js";
import { sessionDisplayLabel } from "../format.js";
import { isTerminalJobStatus } from "../reduce.js";
import { failTerminateTerminalSession, removeTerminalSession, selectTerminalSession, sessionJobs } from "../store.js";
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

export function CanvasPanel({ state, session, geometry, viewport, active, getCanvasRect }: CanvasPanelProps) {
  const dragRef = useRef<DragState | null>(null);
  const [restoreViewport, setRestoreViewport] = useState<CanvasViewport | null>(null);
  const jobs = sessionJobs(state, session);
  const activeJobCount = jobs.filter(({ job }) => !isTerminalJobStatus(job.status)).length;
  const live = activeJobCount > 0 || session.status === "registered" || session.status === "live" || session.status === "terminal-only";
  const displayLabel = sessionDisplayLabel(session);

  const bringToFront = () => {
    selectTerminalSession(session.sessionId);
    setPanelGeometry(session.sessionId, geometry);
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
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

  const stopCanvasPointer = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    bringToFront();
  };

  const stopCanvasWheel = (event: ReactWheelEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  return (
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
        <span className={`tenant-beacon ${live ? "is-live" : ""}`} aria-hidden="true" />
        <span className="canvas-panel-title">{displayLabel}</span>
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
          aria-label={`Terminate operation ${displayLabel}`}
          title="Terminate operation"
        >
          <CloseIcon />
        </button>
      </div>
      <div className="canvas-panel-terminal" onPointerDown={stopCanvasPointer} onWheel={stopCanvasWheel} data-canvas-blocker>
        <Terminal sessionId={session.sessionId} onExit={() => removeTerminalSession(session.sessionId)} />
      </div>
      <PanelResizeHandles geometry={geometry} zoom={viewport.zoom} onResize={(nextGeometry) => setPanelGeometry(session.sessionId, nextGeometry)} />
    </article>
  );
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
