import { useRef, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";

import { terminateTerminalSession } from "../api.js";
import { Terminal } from "../components/terminal.js";
import { failTerminateTerminalSession, selectTerminalSession } from "../store.js";
import { claimTopZIndex, type CanvasViewport, type PanelGeometry } from "./canvas-store.js";
import { PanelResizeHandles } from "./panel-resize.js";
import { removeShellPanel, setActiveShellPanel, setShellPanelGeometry } from "./shell-panels.js";
import { clearMaximizedPanelId, minimizeWindowPanel, shellPanelHandle } from "./window-registry.js";

interface ShellCanvasPanelProps {
  readonly id: string;
  readonly theaterId: string;
  readonly geometry: PanelGeometry;
  readonly viewport: CanvasViewport;
  readonly active: boolean;
  // 최소화 상태 — 언마운트 대신 숨겨 Terminal/WS를 살려둔다(theater-shell PTY가 grace로 죽지 않게).
  readonly minimized?: boolean;
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

export function ShellCanvasPanel({ id, theaterId, geometry, viewport, active, minimized = false, maximized = false, onFocusRequest, onMaximize }: ShellCanvasPanelProps) {
  const dragRef = useRef<DragState | null>(null);

  // 활성화: ① Operations 선택 해제(상호배타 — selectTerminalSession(null)) ② 이 셸을 활성으로 표시
  // ③ 공유 z 카운터에서 최상단 값을 받아 맨 앞으로. 종류와 무관하게 활성화한 패널이 맨 앞·하이라이트된다.
  const bringToFront = () => {
    selectTerminalSession(null);
    setActiveShellPanel(id);
    // 최대화 오버레이에선 오버레이 전용 geometry를 저장 geometry로 영속하지 않는다(복원 시 원래 위치·크기 보존).
    if (!maximized) setShellPanelGeometry(id, { ...geometry, zIndex: claimTopZIndex() });
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // 최대화 상태에선 드래그 이동을 막는다(updateDrag가 오버레이 좌표를 저장 geometry에 덮어쓰지 않게).
    if (maximized) return;
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
    // 최대화된 셸을 닫으면 최대화 상태도 해제한다 — 안 그러면 maximizedPanelId가 사라진 셸을 가리켜
    // 다음 Alt 순환이 의도치 않게 재최대화한다.
    if (maximized) clearMaximizedPanelId();
    removeShellPanel(id);
    void terminateTerminalSession(id).catch((error) => {
      failTerminateTerminalSession(error instanceof Error ? error.message : String(error));
    });
  };

  return (
    <article
      className={`canvas-panel canvas-panel--shell ${minimized ? "is-minimized" : ""} ${active ? "is-active" : ""}`}
      style={{
        left: geometry.x,
        top: geometry.y,
        width: geometry.width,
        height: geometry.height,
        zIndex: geometry.zIndex,
      }}
      onPointerDown={bringToFront}
      data-canvas-panel
      aria-hidden={minimized || undefined}
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
        <Terminal sessionId={id} kind="shell" theaterId={theaterId} active={active} zoom={viewport.zoom} onExit={() => { if (maximized) clearMaximizedPanelId(); removeShellPanel(id); }} />
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
