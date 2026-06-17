import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { createTheaterTerminalSession } from "../api.js";
import { OperationLaunchMenu } from "../components/operation-launch-menu.js";
import { beginCreateTerminalSession, completeCreateTerminalSession, failCreateTerminalSession, selectTerminalSession, theaterSessions } from "../store.js";
import type { AgentCliMetadata, ConsoleState } from "../types.js";
import { animateViewportTo, setPanelGeometry, setViewport, toggleBackgroundAnimation, toggleMaximized, useBackgroundAnimation, useCanvasState, useMaximized, type PanelGeometry } from "./canvas-store.js";
import { CanvasContextMenu } from "./canvas-context-menu.js";
import { CanvasPanel } from "./canvas-panel.js";
import { CanvasGrid } from "./canvas-grid.js";
import { RubberBand } from "./rubber-band.js";
import { ShellCanvasPanel } from "./shell-canvas-panel.js";
import { addShellPanel, useShellPanels } from "./shell-panels.js";
import { useCanvasInteraction } from "./use-canvas-interaction.js";
import { screenToCanvas, type CanvasPoint, type CanvasRect } from "./coordinates.js";

interface OperationsCanvasProps {
  readonly state: ConsoleState;
}

interface LaunchRequest {
  readonly rect: CanvasRect;
  readonly anchor: CanvasPoint;
}

interface ContextMenuRequest {
  // 캔버스(<main>) 기준 화면 좌표(메뉴 표시 위치).
  readonly anchor: CanvasPoint;
  // 우클릭 지점의 캔버스(world) 좌표(새 패널 배치 기준).
  readonly canvasPoint: CanvasPoint;
}

const EMPTY_GUIDE = "Shift-drag to create an Operation. Right-click for actions. Drag to pan; scroll to zoom.";
const DEFAULT_OPERATION_WIDTH = 640;
const DEFAULT_OPERATION_HEIGHT = 400;
const DEFAULT_SHELL_WIDTH = 560;
const DEFAULT_SHELL_HEIGHT = 360;
const RESET_VIEWPORT = { x: 0, y: 0, zoom: 1 } as const;

export function OperationsCanvas({ state }: OperationsCanvasProps) {
  const canvasRef = useRef<HTMLElement | null>(null);
  const canvas = useCanvasState();
  const backgroundAnimationEnabled = useBackgroundAnimation();
  const maximized = useMaximized();
  const shellPanels = useShellPanels();
  const sessions = theaterSessions(state);
  const [launchRequest, setLaunchRequest] = useState<LaunchRequest | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuRequest | null>(null);
  const disabled = !state.activeTheaterId || state.agentClis.length === 0 || state.creatingTerminalSession || state.addingTheater;
  const interaction = useCanvasInteraction({
    viewport: canvas.viewport,
    disabled,
    // pan은 즉시, 휠 줌은 보간 경로(스토어 rAF tween)로 분기한다.
    onViewportChange: setViewport,
    onZoom: animateViewportTo,
    onCreate: (rect, anchor) => { setContextMenu(null); setLaunchRequest({ rect, anchor }); },
    consumePointerDown: launchRequest !== null || contextMenu !== null,
    onConsumePointerDown: () => { setLaunchRequest(null); setContextMenu(null); },
    onClick: clearTerminalFocus,
  });

  const handleLaunch = async (cli: AgentCliMetadata) => {
    if (!state.activeTheaterId || !launchRequest) return;
    beginCreateTerminalSession();
    try {
      const session = await createTheaterTerminalSession(state.activeTheaterId, cli.id);
      setPanelGeometry(session.sessionId, rectToGeometry(launchRequest.rect));
      completeCreateTerminalSession(session);
      selectTerminalSession(session.sessionId);
      setLaunchRequest(null);
    } catch (error) {
      failCreateTerminalSession(error instanceof Error ? error.message : String(error));
    }
  };

  // 우클릭 컨텍스트 메뉴에서 새 Operation을 우클릭 지점에 생성한다.
  const handleContextLaunch = async (cli: AgentCliMetadata) => {
    const point = contextMenu?.canvasPoint;
    setContextMenu(null);
    if (!state.activeTheaterId || !point) return;
    beginCreateTerminalSession();
    try {
      const session = await createTheaterTerminalSession(state.activeTheaterId, cli.id);
      setPanelGeometry(session.sessionId, geometryAt(point, DEFAULT_OPERATION_WIDTH, DEFAULT_OPERATION_HEIGHT));
      completeCreateTerminalSession(session);
      selectTerminalSession(session.sessionId);
    } catch (error) {
      failCreateTerminalSession(error instanceof Error ? error.message : String(error));
    }
  };

  // 순정 셸 패널을 우클릭 지점에 띄운다(Operation 미분류·비영속).
  const handleOpenShell = () => {
    const point = contextMenu?.canvasPoint;
    setContextMenu(null);
    if (!state.activeTheaterId || !point) return;
    addShellPanel(state.activeTheaterId, geometryAt(point, DEFAULT_SHELL_WIDTH, DEFAULT_SHELL_HEIGHT));
  };

  const handleResetView = () => {
    setContextMenu(null);
    setViewport({ ...RESET_VIEWPORT });
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    // 빈 캔버스에서만 컨텍스트 메뉴를 띄운다 — 패널/메뉴/터미널 위 우클릭은 무시(기본 동작 유지).
    if (event.target instanceof Element && event.target.closest("[data-canvas-blocker], [data-canvas-panel]")) return;
    event.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const anchor: CanvasPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    setLaunchRequest(null);
    setContextMenu({ anchor, canvasPoint: screenToCanvas(anchor, canvas.viewport) });
  };

  const hasContent = sessions.length > 0 || Object.keys(shellPanels).length > 0;

  return (
    <main
      className={`operations-canvas ${interaction.spaceActive ? "is-panning" : ""} ${interaction.shiftActive ? "is-creating" : ""}`}
      onPointerDown={interaction.onPointerDown}
      onPointerMove={interaction.onPointerMove}
      onPointerUp={interaction.onPointerUp}
      onPointerCancel={interaction.onPointerCancel}
      onWheel={interaction.onWheel}
      onContextMenu={handleContextMenu}
      ref={canvasRef}
    >
      <CanvasGrid viewport={canvas.viewport} backgroundAnimationEnabled={backgroundAnimationEnabled} />
      <button
        type="button"
        className={`canvas-background-toggle canvas-maximize-toggle ${maximized ? "is-active" : ""}`}
        onClick={toggleMaximized}
        data-canvas-blocker
        aria-label={maximized ? "맵 최대화 해제" : "맵 최대화"}
        aria-pressed={maximized}
        title={maximized ? "Exit fullscreen (Esc)" : "Maximize map"}
      >
        {maximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        type="button"
        className={`canvas-background-toggle ${backgroundAnimationEnabled ? "is-active" : ""}`}
        onClick={toggleBackgroundAnimation}
        data-canvas-blocker
        aria-label={backgroundAnimationEnabled ? "배경 애니메이션 끄기" : "배경 애니메이션 켜기"}
        title={backgroundAnimationEnabled ? "Background animation: on" : "Background animation: off"}
      >
        <RadarToggleIcon />
      </button>
      <div
        className="operations-canvas-world"
        style={{
          transform: `translate(${canvas.viewport.x}px, ${canvas.viewport.y}px) scale(${canvas.viewport.zoom})`,
        }}
      >
        {sessions.map((session) => {
          const geometry = canvas.panels[session.sessionId];
          if (!geometry) return null;
          return (
            <CanvasPanel
              key={session.sessionId}
              state={state}
              session={session}
              geometry={geometry}
              viewport={canvas.viewport}
              active={state.activeTerminalSessionId === session.sessionId}
              getCanvasRect={() => canvasRef.current?.getBoundingClientRect() ?? null}
            />
          );
        })}
        {Object.entries(shellPanels).map(([id, entry]) => (
          <ShellCanvasPanel
            key={id}
            id={id}
            theaterId={entry.theaterId}
            geometry={entry.geometry}
            viewport={canvas.viewport}
          />
        ))}
      </div>
      {!hasContent ? (
        <div className="operations-canvas-empty" data-canvas-blocker>
          <span className="operations-canvas-empty-mark" aria-hidden="true" />
          <p>{state.activeTheaterId ? EMPTY_GUIDE : "Add a Theater from the top bar to start operations."}</p>
          {state.terminalSessionError ? <p className="operations-canvas-error">{state.terminalSessionError}</p> : null}
        </div>
      ) : null}
      {interaction.rubberBand ? <RubberBand rect={interaction.rubberBand} viewport={canvas.viewport} /> : null}
      {launchRequest ? (
        <OperationLaunchMenu
          key={`${launchRequest.anchor.x}:${launchRequest.anchor.y}`}
          state={state}
          mode="menu"
          anchor={launchRequest.anchor}
          viewportBounds={viewportBoundsFor(canvasRef.current)}
          onSelect={handleLaunch}
          onClose={() => setLaunchRequest(null)}
        />
      ) : null}
      {contextMenu ? (
        <CanvasContextMenu
          key={`${contextMenu.anchor.x}:${contextMenu.anchor.y}`}
          state={state}
          anchor={contextMenu.anchor}
          viewportBounds={viewportBoundsFor(canvasRef.current)}
          onLaunchCli={(cli) => { void handleContextLaunch(cli); }}
          onOpenShell={handleOpenShell}
          onResetView={handleResetView}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </main>
  );
}

function RadarToggleIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.1" strokeDasharray="2 2" />
      <circle cx="8" cy="8" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.72" />
      <path d="M8 8 12.2 5.8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="8" cy="8" r=".9" fill="currentColor" />
    </svg>
  );
}

function MaximizeIcon() {
  // 맵 최대화 — 네 모서리 바깥 화살표(확장) 마크.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 6.4V3h3.4M13 6.4V3H9.6M3 9.6V13h3.4M13 9.6V13H9.6" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RestoreIcon() {
  // 최대화 해제 — 안쪽 화살표(축소) 마크.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.4 3v3.4H3M9.6 3v3.4H13M6.4 13V9.6H3M9.6 13V9.6H13" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function viewportBoundsFor(element: HTMLElement | null): { readonly width: number; readonly height: number } | undefined {
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

// 빈 캔버스 단일 클릭(캔버스 제어 의도): 포커스된 터미널을 blur하고 활성 선택을 해제한다.
function clearTerminalFocus(): void {
  if (typeof document !== "undefined") {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }
  selectTerminalSession(null);
}

function rectToGeometry(rect: CanvasRect): PanelGeometry {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    zIndex: Date.now(),
  };
}

// 캔버스 좌표 지점에 기본 크기 패널을 배치하는 geometry를 만든다(우클릭 메뉴 생성용).
function geometryAt(point: CanvasPoint, width: number, height: number): PanelGeometry {
  return {
    x: point.x,
    y: point.y,
    width,
    height,
    zIndex: Date.now(),
  };
}
