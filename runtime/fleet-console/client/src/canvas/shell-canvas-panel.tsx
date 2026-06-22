import { useRef, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";

import { terminateTerminalSession } from "../api.js";
import { Terminal } from "../components/terminal.js";
import { failTerminateTerminalSession, selectTerminalSession } from "../store.js";
import { claimTopZIndex, type CanvasViewport, type PanelGeometry } from "./canvas-store.js";
import { PanelResizeHandles } from "./panel-resize.js";
import { removeShellPanel, setActiveShellPanel, setShellPanelGeometry } from "./shell-panels.js";
import { minimizeWindowPanel, shellPanelHandle } from "./window-registry.js";

interface ShellCanvasPanelProps {
  readonly id: string;
  readonly theaterId: string;
  readonly geometry: PanelGeometry;
  readonly viewport: CanvasViewport;
  readonly active: boolean;
  readonly onFocusRequest: () => void;
  readonly onMaximize: () => void;
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly geometry: PanelGeometry;
}

export function ShellCanvasPanel({ id, theaterId, geometry, viewport, active, onFocusRequest, onMaximize }: ShellCanvasPanelProps) {
  const dragRef = useRef<DragState | null>(null);

  // 활성화: ① Operations 선택 해제(상호배타 — selectTerminalSession(null)) ② 이 셸을 활성으로 표시
  // ③ 공유 z 카운터에서 최상단 값을 받아 맨 앞으로. 종류와 무관하게 활성화한 패널이 맨 앞·하이라이트된다.
  const bringToFront = () => {
    selectTerminalSession(null);
    setActiveShellPanel(id);
    setShellPanelGeometry(id, { ...geometry, zIndex: claimTopZIndex() });
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    bringToFront();
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, geometry };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    setShellPanelGeometry(id, {
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

  const stopCanvasPointer = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    bringToFront();
  };

  const stopCanvasWheel = (event: ReactWheelEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  // 닫기: 레지스트리에서 제거(언마운트)하고 백엔드 PTY도 즉시 종료한다(grace 대기 없이).
  const close = () => {
    removeShellPanel(id);
    void terminateTerminalSession(id).catch((error) => {
      failTerminateTerminalSession(error instanceof Error ? error.message : String(error));
    });
  };

  return (
    <article
      className={`canvas-panel canvas-panel--shell ${active ? "is-active" : ""}`}
      style={{
        left: geometry.x,
        top: geometry.y,
        width: geometry.width,
        height: geometry.height,
        zIndex: geometry.zIndex,
      }}
      onPointerDown={bringToFront}
      data-canvas-panel
      aria-label="Shell panel"
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
        <span className="tenant-beacon is-live" aria-hidden="true" />
        <span className="canvas-panel-title">Shell</span>
        <span className="canvas-panel-cli">shell</span>
        <button
          type="button"
          className="canvas-panel-icon-button"
          onPointerDown={stopButtonPointer}
          onClick={() => { minimizeWindowPanel(shellPanelHandle(id)); }}
          aria-label="Minimize shell panel"
          title="Minimize panel"
        >
          <MinimizeIcon />
        </button>
        <button
          type="button"
          className="canvas-panel-icon-button"
          onPointerDown={stopButtonPointer}
          onClick={onMaximize}
          aria-label="Maximize shell panel"
          title="Maximize panel"
        >
          <MaximizePanelIcon />
        </button>
        <button
          type="button"
          className="canvas-panel-icon-button"
          onPointerDown={stopButtonPointer}
          onClick={close}
          aria-label="Close shell panel"
          title="Close shell"
        >
          <CloseIcon />
        </button>
      </div>
      <div className="canvas-panel-terminal" onPointerDown={stopCanvasPointer} onWheel={stopCanvasWheel} data-canvas-blocker>
        <Terminal sessionId={id} kind="shell" theaterId={theaterId} active={active} zoom={viewport.zoom} onExit={() => removeShellPanel(id)} />
      </div>
      <PanelResizeHandles geometry={geometry} zoom={viewport.zoom} onResize={(next) => setShellPanelGeometry(id, next)} />
    </article>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function MinimizeIcon() {
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
