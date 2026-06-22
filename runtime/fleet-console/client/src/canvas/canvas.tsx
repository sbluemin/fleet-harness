import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { createTheaterTerminalSession } from "../api.js";
import { OperationLaunchMenu } from "../components/operation-launch-menu.js";
import { beginCreateTerminalSession, completeCreateTerminalSession, failCreateTerminalSession, selectTerminalSession, theaterSessions } from "../store.js";
import type { AgentCliMetadata, ConsoleState } from "../types.js";
import { animateViewportTo, claimTopZIndex, setPanelGeometry, setViewport, toggleBackgroundAnimation, toggleMapFullscreen, useBackgroundAnimation, useCanvasState, useMapFullscreen, useMinimized, type PanelGeometry } from "./canvas-store.js";
import { CanvasContextMenu } from "./canvas-context-menu.js";
import { CanvasMinimap } from "./canvas-minimap.js";
import { CanvasPanel } from "./canvas-panel.js";
import { CanvasDock } from "./canvas-dock.js";
import { CanvasGrid } from "./canvas-grid.js";
import { MapShortcuts } from "./map-shortcuts.js";
import { RubberBand } from "./rubber-band.js";
import { ShellCanvasPanel } from "./shell-canvas-panel.js";
import { addShellPanel, getMinimizedShellPanelIds, setActiveShellPanel, useActiveShellId, useShellPanels } from "./shell-panels.js";
import { useCanvasInteraction } from "./use-canvas-interaction.js";
import { screenToCanvas, type CanvasPoint, type CanvasRect } from "./coordinates.js";
import { clearMaximizedPanelId, focusWindowPanel, getPanelHandles, maximizeWindowPanel, operationPanelHandle, shellPanelHandle, useMaximizedPanelId, type WindowPanelHandle } from "./window-registry.js";

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
  const isMapFullscreen = useMapFullscreen();
  const minimized = useMinimized();
  const maximizedPanelId = useMaximizedPanelId();
  const shellPanels = useShellPanels();
  const activeShellId = useActiveShellId();
  const sessions = theaterSessions(state);
  const [launchRequest, setLaunchRequest] = useState<LaunchRequest | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuRequest | null>(null);
  // 미니맵의 뷰포트 인디케이터 계산에 필요한 캔버스 픽셀 크기를 ResizeObserver로 추적한다.
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const disabled = !state.activeTheaterId || state.agentClis.length === 0 || state.creatingTerminalSession || state.addingTheater;

  useEffect(() => {
    const element = canvasRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const update = () => setCanvasSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // 상호배타 단일 지점: 어떤 Operation이든 활성화되면(=activeTerminalSessionId 비-null) 셸 활성 하이라이트를 해제한다.
  // 패널 클릭·사이드바·Alt+화살표·검색 점프 등 selectTerminalSession을 거치는 모든 경로를 여기서 한 번에 커버한다.
  useEffect(() => {
    if (state.activeTerminalSessionId !== null) setActiveShellPanel(null);
  }, [state.activeTerminalSessionId]);
  // 불변식: active Operation은 절대 최소화된(화면 밖) 세션이면 안 된다. 패널 최소화 액션은 물론,
  // 리로드·Theater 전환 시 resolveVisibleSessionId가 canvas.minimized를 모른 채 최소화된 비-dormant 세션을
  // active로 자동 선택하는 경로까지 한 곳에서 막는다 — 안 그러면 숨은 패널이 isActiveOperation 억제에 걸려
  // 입력 대기·턴 종료·캐리어 토스트가 사라진다. (복원은 minimized 제거가 선행되므로 여기서 해제되지 않는다.)
  useEffect(() => {
    if (state.activeTerminalSessionId !== null && minimized.includes(state.activeTerminalSessionId)) {
      selectTerminalSession(null);
    }
  }, [state.activeTerminalSessionId, minimized]);
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
  // Operations 패널과 동일한 공유 z 카운터에서 최상단 값을 받아 생성 즉시 맨 앞에 온다.
  const handleOpenShell = () => {
    const point = contextMenu?.canvasPoint;
    setContextMenu(null);
    if (!state.activeTheaterId || !point) return;
    // 새 셸은 생성 즉시 활성: Operations 선택을 해제하고 이 셸을 활성으로 표시한다.
    selectTerminalSession(null);
    const id = addShellPanel(state.activeTheaterId, { ...geometryAt(point, DEFAULT_SHELL_WIDTH, DEFAULT_SHELL_HEIGHT), zIndex: claimTopZIndex() });
    setActiveShellPanel(id);
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

  const minimizedSet = new Set(minimized);
  const minimizedShellSet = new Set(getMinimizedShellPanelIds());
  // 최소화된 패널은 캔버스에서 빠지므로 미니맵(캔버스 개관)에서도 제외해 "사라진 blip" 불일치를 막는다.
  const visiblePanels = Object.fromEntries(
    Object.entries(canvas.panels).filter(([sessionId]) => !minimizedSet.has(sessionId)),
  );
  const hasContent = sessions.length > 0 || Object.keys(shellPanels).length > 0;
  const operationIds = sessions.map((session) => session.sessionId);
  const panelHandles = getPanelHandles(operationIds);
  const maximizedHandle = maximizedPanelId ? panelHandles.find((handle) => handle.id === maximizedPanelId) ?? null : null;
  const maximizePanel = (target: WindowPanelHandle) => maximizeWindowPanel(target, panelHandles);
  const maximizedOverlayGeometry = {
    x: 0,
    y: 0,
    width: Math.max(320, canvasSize.width),
    height: Math.max(240, canvasSize.height - 72),
    zIndex: 20,
  };

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
        className={`canvas-background-toggle canvas-maximize-toggle ${isMapFullscreen ? "is-active" : ""}`}
        onClick={toggleMapFullscreen}
        data-canvas-blocker
        aria-label={isMapFullscreen ? "맵 전체화면 해제" : "맵 전체화면"}
        aria-pressed={isMapFullscreen}
        title={isMapFullscreen ? "Exit map fullscreen" : "Enter map fullscreen"}
      >
        {isMapFullscreen ? <RestoreIcon /> : <MaximizeIcon />}
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
          // 최소화된 패널은 캔버스에서 빠지고 하단 태스크바에 칩으로 표시된다(Terminal 언마운트→복원 시 재연결).
          if (minimizedSet.has(session.sessionId)) return null;
          if (maximizedPanelId === session.sessionId) return null;
          const handle = panelHandles.find((entry) => entry.id === session.sessionId) ?? operationPanelHandle(session.sessionId);
          return (
            <CanvasPanel
              key={session.sessionId}
              state={state}
              session={session}
              geometry={geometry}
              viewport={canvas.viewport}
              active={state.activeTerminalSessionId === session.sessionId}
              onFocusRequest={() => focusWindowPanel(operationPanelHandle(session.sessionId), canvasSize)}
              onMaximize={() => maximizePanel(handle)}
            />
          );
        })}
        {Object.entries(shellPanels).map(([id, entry]) => {
          // 최대화된 셸은 오버레이에서 단독 렌더되므로 world 루프에서는 건너뛴다.
          if (maximizedPanelId === id) return null;
          // 최소화된 셸은 언마운트하지 않고 visibility:hidden으로 숨긴다 — Terminal/WS를 살려둬
          // theater-shell의 소켓 단절 grace(4s)가 발동해 실행 중 셸이 죽는 것을 막는다(복원 시 동일 PTY 재부착).
          const minimizedShell = minimizedShellSet.has(id);
          const handle = panelHandles.find((panel) => panel.id === id) ?? shellPanelHandle(id);
          return (
            <ShellCanvasPanel
              key={id}
              id={id}
              theaterId={entry.theaterId}
              geometry={entry.geometry}
              viewport={canvas.viewport}
              active={!minimizedShell && activeShellId === id}
              minimized={minimizedShell}
              onFocusRequest={() => focusWindowPanel(shellPanelHandle(id), canvasSize)}
              onMaximize={() => maximizePanel(handle)}
            />
          );
        })}
      </div>
      {maximizedHandle ? (
        <div className="canvas-panel-maximized-layer" data-canvas-blocker>
          {sessions.map((session) => (
            session.sessionId === maximizedHandle.id ? (
              <CanvasPanel
                key={session.sessionId}
                state={state}
                session={session}
                geometry={maximizedOverlayGeometry}
                viewport={{ x: 0, y: 0, zoom: 1 }}
                maximized
                active={state.activeTerminalSessionId === session.sessionId}
                onFocusRequest={() => focusWindowPanel(maximizedHandle, canvasSize)}
                onMaximize={clearMaximizedPanelId}
              />
            ) : null
          ))}
          {Object.entries(shellPanels).map(([id, entry]) => (
            id === maximizedHandle.id ? (
              <ShellCanvasPanel
                key={id}
                id={id}
                theaterId={entry.theaterId}
                geometry={maximizedOverlayGeometry}
                viewport={{ x: 0, y: 0, zoom: 1 }}
                maximized
                active={activeShellId === id}
                onFocusRequest={() => focusWindowPanel(maximizedHandle, canvasSize)}
                onMaximize={clearMaximizedPanelId}
              />
            ) : null
          ))}
        </div>
      ) : null}
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
      <CanvasMinimap
        panels={visiblePanels}
        shellPanels={shellPanels}
        viewport={canvas.viewport}
        canvasSize={canvasSize}
        onJump={(center) => setViewport({
          x: canvasSize.width / 2 - center.x * canvas.viewport.zoom,
          y: canvasSize.height / 2 - center.y * canvas.viewport.zoom,
          zoom: canvas.viewport.zoom,
        })}
      />
      {/* 콘텐츠가 없을 때는 좌하단 빈 상태 안내가 핵심 단축키를 이미 알려주므로, 겹침을 막기 위해 단축키 맵을 숨긴다. */}
      {hasContent ? <MapShortcuts /> : null}
      {/* 최소화된 Operation 패널의 하단 Dock(world가 아닌 캔버스 고정 — 토글을 화면 가로 중앙 하단에 두고
          펼치면 그 아래로 칩이 중앙정렬로 펼쳐진다. 패널과 함께 이동·확대되지 않는다). */}
      <CanvasDock state={state} sessions={sessions} />
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

// 빈 캔버스 단일 클릭(캔버스 제어 의도): 포커스된 터미널을 blur하고 활성 선택을 해제한다(Operations·셸 모두).
function clearTerminalFocus(): void {
  if (typeof document !== "undefined") {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }
  selectTerminalSession(null);
  setActiveShellPanel(null);
}

// zIndex는 setPanelGeometry(Operations)·claimTopZIndex(셸)가 발급하므로 여기서는 placeholder(0)만 둔다.
function rectToGeometry(rect: CanvasRect): PanelGeometry {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    zIndex: 0,
  };
}

// 캔버스 좌표 지점에 기본 크기 패널을 배치하는 geometry를 만든다(우클릭 메뉴 생성용).
function geometryAt(point: CanvasPoint, width: number, height: number): PanelGeometry {
  return {
    x: point.x,
    y: point.y,
    width,
    height,
    zIndex: 0,
  };
}
