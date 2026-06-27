import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { ConsoleTheme, FleetClientPlugin, OperationActivity, OperationKindDescriptor, TerminalRenderer } from "@fleet-console/sdk/plugin";

import { fetchOperations, renameOperation as renameOperationRequest } from "../api.js";
import { hydrateOperations, setActiveOperation } from "../store.js";
import { createHostCapabilities } from "../plugin-capabilities.js";
import { usePluginRegistry } from "../plugin-registry.js";
import type { ConsoleState, OperationNode, TerminalFontSettings } from "../types.js";
import { animateViewportTo, claimTopZIndex, clearMaximizedOperationId, focusOperation, getSnapshot as getCanvasSnapshot, minimizeOperation, restoreOperation, setMaximizedOperationId, setOperationAccent, setOperationGeometry, setViewport, toggleBackgroundAnimation, toggleMapFullscreen, useBackgroundAnimation, useCanvasState, useMapFullscreen, useMaximizedOperationId, useMinimized, type OperationGeometry } from "./canvas-store.js";
import { CanvasDock } from "./canvas-dock.js";
import { CanvasContextMenu, CommandReticleIcon } from "./canvas-context-menu.js";
import { recordClosedOperation, removeClosedOperation, useRecentlyClosed, type ClosedOperationSnapshot } from "./recently-closed.js";
import { CanvasMinimap } from "./canvas-minimap.js";
import { CanvasGrid } from "./canvas-grid.js";
import { MapShortcuts } from "./map-shortcuts.js";
import { OperationFrame } from "./operation-frame.js";
import { OperationEdges } from "./operation-edges-layer.js";
import { computeOperationEdges, type EdgeOperationInput } from "./operation-edges.js";
import { RubberBand } from "./rubber-band.js";
import { useCanvasInteraction } from "./use-canvas-interaction.js";
import { screenToCanvas, type CanvasPoint, type CanvasRect } from "./coordinates.js";

interface OperationsCanvasProps {
  readonly state: ConsoleState;
}

interface ContextMenuRequest {
  // 캔버스(<main>) 기준 화면 좌표(메뉴 표시 위치).
  readonly anchor: CanvasPoint;
  // 우클릭 지점의 캔버스(world) 좌표(새 패널 배치 기준).
  readonly canvasPoint: CanvasPoint;
}

interface PluginOperationRendererProps {
  readonly active: boolean;
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly descriptor: OperationKindDescriptor;
  readonly geometry: OperationGeometry;
  readonly operation: OperationNode;
  readonly terminalFont: TerminalFontSettings;
  readonly terminalRenderer: TerminalRenderer;
  readonly theme: ConsoleTheme;
  readonly viewportZoom: number;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onGeometryChange: (geometry: OperationGeometry) => void;
}

const EMPTY_GUIDE = "Shift-drag to create a Shell. Right-click for actions. Drag to pan; scroll to zoom.";
const DEFAULT_SHELL_WIDTH = 560;
const DEFAULT_SHELL_HEIGHT = 360;
const RESET_VIEWPORT = { x: 0, y: 0, zoom: 1 } as const;
// 패널 최대화 시 하단 Dock(태스크바) 풋프린트만큼 남겨 Dock을 가리지 않게 한다(canary 동일 — safe-inset 58 + bottom 여백).
const MAXIMIZED_DOCK_INSET = 72;
// 사용자 close(헤더 X)와 PTY 자가종료(onExit→onClose)가 같은 operation의 close path를 중복 실행하는 것을 막는다.
// 재진입은 이미 삭제된 operation에 중복 DELETE를 보내 404 콘솔 노이즈를 만든다(기능 영향은 없으나 race를 가린다).
const closingOperationIds = new Set<string>();

export function OperationsCanvas({ state }: OperationsCanvasProps) {
  const canvasRef = useRef<HTMLElement | null>(null);
  const canvas = useCanvasState();
  const backgroundAnimationEnabled = useBackgroundAnimation();
  const mapFullscreen = useMapFullscreen();
  const maximizedOperationId = useMaximizedOperationId();
  const minimized = useMinimized();
  const activePluginOperationId = state.activeOperationId;
  const [contextMenu, setContextMenu] = useState<ContextMenuRequest | null>(null);
  const [catalog, setCatalog] = useState<readonly OperationCatalogPlugin[]>([]);
  const [launchPending, setLaunchPending] = useState(false);
  const registry = usePluginRegistry();
  // launch 시점에 보유한 불투명 kind를 operation별로 기억한다 — close 시 Recover 스냅샷에 담아 재오픈에 쓴다.
  const launchKindsRef = useRef<Map<string, { readonly pluginId: string; readonly kind: OperationLaunchKind }>>(new Map());
  const recentlyClosed = useRecentlyClosed(state.activeTheaterId);
  // 미니맵의 뷰포트 인디케이터 계산에 필요한 캔버스 픽셀 크기를 ResizeObserver로 추적한다.
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const disabled = !state.activeTheaterId || state.addingTheater;

  useEffect(() => {
    const element = canvasRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const update = () => setCanvasSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void fetchOperationCatalog(abort.signal)
      .then(setCatalog)
      .catch(() => {
        if (!abort.signal.aborted) setCatalog([]);
      });
    return () => abort.abort();
  }, []);
  const interaction = useCanvasInteraction({
    viewport: canvas.viewport,
    disabled,
    // pan은 즉시, 휠 줌은 보간 경로(스토어 rAF tween)로 분기한다.
    onViewportChange: setViewport,
    onZoom: animateViewportTo,
    onCreate: (rect) => {
      setContextMenu(null);
      if (state.activeTheaterId && !launchPending) {
        const target = resolveDefaultLaunchTarget(catalog);
        if (!target) return;
        const geometry = { ...rectToGeometry(rect), zIndex: claimTopZIndex() };
        void launchViaPlugin(target.pluginId, target.kind, state.activeTheaterId, geometry);
      }
    },
    consumePointerDown: contextMenu !== null,
    onConsumePointerDown: () => { setContextMenu(null); },
    onClick: clearTerminalFocus,
  });

  const launchViaPlugin = async (pluginId: string, kind: OperationLaunchKind, theaterId: string, geometry: OperationGeometry) => {
    const plugin = registry.plugins.find((candidate) => candidate.id === pluginId);
    if (!plugin?.launch || kind.disabled) return;
    // 최대화 상태에서 패널을 추가하면 최대화를 풀지 않고 새 패널을 최대화로 전환한다(#105 — Dock 칩 전환과 동일 멘탈모델).
    const swapMaximized = maximizedOperationId !== null;
    setLaunchPending(true);
    try {
      const capabilities = createHostCapabilities();
      const created = await plugin.launch({ theaterId, kind, geometry, operations: capabilities.operations });
      launchKindsRef.current.set(created.id, { pluginId, kind });
      setOperationGeometry(created.id, geometry);
      void updatePluginOperationGeometry(created.id, geometry);
      setActiveOperation(created.id);
      if (swapMaximized) setMaximizedOperationId(created.id);
      void fetchOperations(null).then(hydrateOperations).catch(() => {});
    } finally {
      setLaunchPending(false);
    }
  };

  const handleLaunchKind = (pluginId: string, kind: OperationLaunchKind) => {
    const point = contextMenu?.canvasPoint;
    setContextMenu(null);
    if (!state.activeTheaterId || !point) return;
    const geometry = { ...geometryAt(point, DEFAULT_SHELL_WIDTH, DEFAULT_SHELL_HEIGHT), zIndex: claimTopZIndex() };
    void launchViaPlugin(pluginId, kind, state.activeTheaterId, geometry);
  };

  const handleResetView = () => {
    setContextMenu(null);
    setViewport({ ...RESET_VIEWPORT });
  };

  // Map 섹션 — top-right 컨트롤과 동일 동작을 Operations Control 메뉴에서도 노출한다(이동이 아닌 surface).
  const handleMaximizeMap = () => {
    setContextMenu(null);
    toggleMapFullscreen();
  };

  const handleToggleRadar = () => {
    setContextMenu(null);
    toggleBackgroundAnimation();
  };

  // 닫는 Operation을 Recover 스냅샷으로 기록한다 — 이번 세션에 런치돼 kind를 아는 것만 대상으로 한다
  // (복원된 dormant 등 kind 미상 Operation은 정확히 재오픈할 수 없어 제외한다).
  const captureClosedOperation = (operation: OperationNode) => {
    const launched = launchKindsRef.current.get(operation.id);
    if (!launched) return;
    recordClosedOperation({
      id: operation.id,
      theaterId: operation.theaterId,
      pluginId: launched.pluginId,
      title: operation.renamedTitle ?? operation.title,
      kind: launched.kind,
      geometry: operation.geometry,
      closedAt: Date.now(),
    });
    launchKindsRef.current.delete(operation.id);
  };

  const handleReopen = (snapshot: ClosedOperationSnapshot) => {
    setContextMenu(null);
    removeClosedOperation(snapshot.id);
    if (!state.activeTheaterId) return;
    // 닫힌 뒤 kind가 stale할 수 있으므로(예: sign-out) 현재 catalog에서 같은 id로 재해석한다.
    const fresh = catalog.find((plugin) => plugin.id === snapshot.pluginId)?.kinds.find((kind) => kind.id === snapshot.kind.id) ?? snapshot.kind;
    if (fresh.disabled) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    const fallback = geometryAt(screenToCanvas({ x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 }, canvas.viewport), DEFAULT_SHELL_WIDTH, DEFAULT_SHELL_HEIGHT);
    const geometry = { ...(snapshot.geometry ?? fallback), zIndex: claimTopZIndex() };
    void launchViaPlugin(snapshot.pluginId, fresh, state.activeTheaterId, geometry);
  };

  // 좌하단 '+' 런처: 우클릭 컨텍스트 메뉴와 동일한 메뉴를 명시 버튼으로 연다.
  // 클릭 지점이 없으므로 새 패널은 현재 캔버스 화면 중앙의 world 좌표에 생성한다.
  const handleOpenLauncher = () => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const anchor: CanvasPoint = { x: 16, y: rect.height - 52 };
    const canvasPoint = screenToCanvas({ x: rect.width / 2, y: rect.height / 2 }, canvas.viewport);
    setContextMenu({ anchor, canvasPoint });
    void fetchOperationCatalog().then(setCatalog).catch(() => {});
  };

  // 아이콘 렌더는 플러그인 소유 — 호스트는 plugin id로 찾아 위임만 한다(특정 플러그인 지식 비종속).
  const renderKindIcon = (pluginId: string, kind: OperationLaunchKind): ReactNode =>
    registry.plugins.find((candidate) => candidate.id === pluginId)?.renderLaunchIcon?.(kind) ?? null;

  const handleContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    // 빈 캔버스에서만 컨텍스트 메뉴를 띄운다 — 패널/메뉴/터미널 위 우클릭은 무시(기본 동작 유지).
    if (event.target instanceof Element && event.target.closest("[data-canvas-blocker], [data-canvas-operation]")) return;
    event.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const anchor: CanvasPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    setContextMenu({ anchor, canvasPoint: screenToCanvas(anchor, canvas.viewport) });
    void fetchOperationCatalog().then(setCatalog).catch(() => {});
  };

  const minimizedSet = new Set(minimized);
  useEffect(() => {
    if (state.activeOperationId && minimizedSet.has(state.activeOperationId)) setActiveOperation(null);
  }, [minimized, state.activeOperationId]);
  // 최소화된 패널은 캔버스에서 빠지므로 미니맵(캔버스 개관)에서도 제외해 "사라진 blip" 불일치를 막는다.
  const visibleOperations = Object.fromEntries(
    Object.entries(canvas.operations).filter(([sessionId]) => !minimizedSet.has(sessionId)),
  );
  const theaterOperations = (state.operations ?? []).filter((operation) => operation.theaterId === state.activeTheaterId);
  const pluginOperations = theaterOperations;
  const hasContent = theaterOperations.length > 0;
  const operationKindRegistry = registry.operationKinds;
  useEffect(() => {
    const localAccent = getCanvasSnapshot().operationAccent;
    for (const operation of theaterOperations) {
      const serverAccent = operationAccentFromNode(operation);
      const currentAccent = localAccent[operation.id] ?? null;
      if (serverAccent !== currentAccent) setOperationAccent(operation.id, serverAccent);
    }
  }, [theaterOperations]);
  // 부모-자식 간선: 화면에 떠 있는(비최소화) Operation만을 대상으로, 패널 렌더와 동일한 방식으로 geometry를
  // 해석해 양 끝이 모두 보이는 쌍만 잇는다(드래그 중 canvas.operations가 갱신되면 간선도 실시간 추종).
  const visibleOperationIds = new Set(theaterOperations.filter((operation) => !minimizedSet.has(operation.id)).map((operation) => operation.id));
  const edgeInputs: EdgeOperationInput[] = theaterOperations.filter((operation) => !minimizedSet.has(operation.id)).map((operation) => ({
    id: operation.id,
    parentId: operation.parentId,
    geometry: canvas.operations[operation.id] ?? operation.geometry ?? ensurePluginGeometry(operation),
  }));
  const operationEdges = computeOperationEdges(edgeInputs, visibleOperationIds);
  const maximizedOperationExists = maximizedOperationId !== null && theaterOperations.some((operation) => operation.id === maximizedOperationId && !minimizedSet.has(operation.id));
  const panelMaximized = maximizedOperationExists ? maximizedOperationId : null;
  const topPanelZIndex = maxOperationZIndex(canvas.operations) + 1;
  const handleDockFocus = (operationId: string) => {
    const operation = theaterOperations.find((candidate) => candidate.id === operationId);
    if (!operation) return;
    const geometry = getCanvasSnapshot().operations[operationId] ?? operation.geometry ?? ensurePluginGeometry(operation);
    if (!getCanvasSnapshot().operations[operationId]) setOperationGeometry(operationId, geometry);
    if (panelMaximized) {
      restoreOperation(operationId);
      setActiveOperation(operationId);
      setMaximizedOperationId(operationId);
      return;
    }
    setActiveOperation(operationId);
    focusOperation(operationId, canvasSize);
  };

  return (
    <main
      className={`operations-canvas ${interaction.spaceActive ? "is-panning" : ""} ${interaction.shiftActive ? "is-creating" : ""} ${panelMaximized ? "is-panel-maximized" : ""}`}
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
        className={`canvas-background-toggle canvas-map-fullscreen-toggle ${mapFullscreen ? "is-active" : ""}`}
        onClick={toggleMapFullscreen}
        data-canvas-blocker
        aria-label={mapFullscreen ? "Exit fullscreen" : "Maximize map"}
        aria-pressed={mapFullscreen}
        title={mapFullscreen ? "Exit fullscreen" : "Maximize map"}
      >
        {mapFullscreen ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        type="button"
        className={`canvas-background-toggle ${backgroundAnimationEnabled ? "is-active" : ""}`}
        onClick={toggleBackgroundAnimation}
        data-canvas-blocker
        aria-label="Radar sweep"
        aria-pressed={backgroundAnimationEnabled}
        title={backgroundAnimationEnabled ? "Radar sweep: on" : "Radar sweep: off"}
      >
        <RadarToggleIcon />
      </button>
      <div
        className="operations-canvas-world"
        style={{
          transform: `translate(${canvas.viewport.x}px, ${canvas.viewport.y}px) scale(${canvas.viewport.zoom})`,
        }}
      >
        <OperationEdges edges={operationEdges} zoom={canvas.viewport.zoom} />
        {pluginOperations.map((operation) => {
          const baseGeometry = canvas.operations[operation.id] ?? operation.geometry ?? ensurePluginGeometry(operation);
          const operationMaximized = panelMaximized === operation.id;
          const frameGeometry = operationMaximized ? maximizedGeometryFor(canvas.viewport, canvasSize, topPanelZIndex) : baseGeometry;
          return renderPluginOperation(operation, {
          active: activePluginOperationId === operation.id,
          geometry: frameGeometry,
          operationKindRegistry,
          status: state.operationStatus[operation.id],
          theme: state.activeTheme,
          terminalRenderer: state.terminalRenderer,
          terminalFont: state.terminalFont,
          viewportZoom: canvas.viewport.zoom,
          minimized: minimizedSet.has(operation.id),
          maximized: operationMaximized,
          onActivate: () => {
            setActiveOperation(operation.id);
            if (!operationMaximized) setOperationGeometry(operation.id, canvas.operations[operation.id] ?? operation.geometry ?? ensurePluginGeometry(operation));
          },
          onClose: () => {
            if (state.activeOperationId === operation.id) setActiveOperation(null);
            if (panelMaximized === operation.id) clearMaximizedOperationId();
            captureClosedOperation(operation);
            void closePluginOperation(operation, registry.plugins);
          },
          onMinimize: () => {
            if (state.activeOperationId === operation.id) setActiveOperation(null);
            minimizeOperation(operation.id);
          },
          onMaximize: () => {
            if (operationMaximized) {
              clearMaximizedOperationId();
            } else {
              setActiveOperation(operation.id);
              setMaximizedOperationId(operation.id);
            }
          },
          onRename: (title) => {
            void renamePluginOperation(operation.id, title);
          },
          onGeometryChange: (geometry) => {
            if (!operationMaximized) setOperationGeometry(operation.id, geometry);
          },
          onGeometryCommit: (geometry) => {
            if (!operationMaximized) void updatePluginOperationGeometry(operation.id, getCanvasSnapshot().operations[operation.id] ?? geometry);
          },
        });
        })}
      </div>
      {!hasContent ? (
        <div className="operations-canvas-empty" data-canvas-blocker>
          <span className="operations-canvas-empty-mark" aria-hidden="true" />
          <p>{state.activeTheaterId ? EMPTY_GUIDE : "Add a Theater from the top bar to start operations."}</p>
        </div>
      ) : null}
      {interaction.rubberBand ? <RubberBand rect={interaction.rubberBand} viewport={canvas.viewport} /> : null}
      {contextMenu ? (
        <CanvasContextMenu
          key={`${contextMenu.anchor.x}:${contextMenu.anchor.y}`}
          anchor={contextMenu.anchor}
          viewportBounds={viewportBoundsFor(canvasRef.current)}
          catalog={catalog}
          canLaunch={!!state.activeTheaterId && !launchPending}
          theaterLabel={state.theaters.find((theater) => theater.id === state.activeTheaterId)?.label}
          operationCount={theaterOperations.length}
          mapFullscreen={mapFullscreen}
          radarEnabled={backgroundAnimationEnabled}
          renderKindIcon={renderKindIcon}
          onLaunchKind={handleLaunchKind}
          recentlyClosed={recentlyClosed.map((entry) => ({ id: entry.id, title: entry.title }))}
          onResetView={handleResetView}
          onMaximizeMap={handleMaximizeMap}
          onToggleRadar={handleToggleRadar}
          onReopen={(id) => {
            const entry = recentlyClosed.find((candidate) => candidate.id === id);
            if (entry) handleReopen(entry);
          }}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
      <CanvasMinimap
        operations={visibleOperations}
        pluginOperations={Object.fromEntries(theaterOperations.filter((operation) => !minimizedSet.has(operation.id)).map((operation) => [operation.id, {
          theaterId: operation.theaterId,
          geometry: canvas.operations[operation.id] ?? operation.geometry ?? ensurePluginGeometry(operation),
        }]))}
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
      {/* 좌하단 '+' 런처 — 우클릭 컨텍스트 메뉴(Operation 생성·뷰 리셋)를 명시 버튼으로도 연다.
          Theater가 있을 때만 노출하고, 최대화 상태에서도 Dock 옆 생성 경로를 보존한다. */}
      {state.activeTheaterId ? (
        <button
          type="button"
          className="canvas-launcher-fab"
          onClick={handleOpenLauncher}
          data-canvas-blocker
          aria-label="Open Operations Control"
          title="Operations Control"
        >
          <CommandReticleIcon />
        </button>
      ) : null}
      <CanvasDock
        operations={theaterOperations}
        minimized={minimized}
        activeOperationId={activePluginOperationId}
        operationStatus={state.operationStatus}
        operationNotifications={state.operationNotifications}
        getSubtitle={(operation) => getOperationSubtitle(operation, operationKindRegistry)}
        onClose={(operationId) => {
          const operation = theaterOperations.find((candidate) => candidate.id === operationId);
          if (!operation) return;
          if (state.activeOperationId === operationId) setActiveOperation(null);
          if (panelMaximized === operationId) clearMaximizedOperationId();
          captureClosedOperation(operation);
          void closePluginOperation(operation, registry.plugins);
        }}
        onFocus={handleDockFocus}
        onSetAccent={(operationId, accent) => {
          void updatePluginOperationAccent(operationId, accent)
            .then(() => fetchOperations(null).then(hydrateOperations))
            .catch(() => undefined);
        }}
      />
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
  setActiveOperation(null);
}

// zIndex는 setOperationGeometry(Operations)·claimTopZIndex(셸)가 발급하므로 여기서는 placeholder(0)만 둔다.
function rectToGeometry(rect: CanvasRect): OperationGeometry {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    zIndex: 0,
  };
}

// 캔버스 좌표 지점에 기본 크기 패널을 배치하는 geometry를 만든다(우클릭 메뉴 생성용).
function geometryAt(point: CanvasPoint, width: number, height: number): OperationGeometry {
  return {
    x: point.x,
    y: point.y,
    width,
    height,
    zIndex: 0,
  };
}

function renderPluginOperation(operation: OperationNode, options: {
  readonly active: boolean;
  readonly geometry: OperationGeometry;
  readonly operationKindRegistry: readonly OperationKindDescriptor[];
  readonly status?: OperationActivity;
  readonly theme: ConsoleTheme;
  readonly terminalRenderer: TerminalRenderer;
  readonly terminalFont: TerminalFontSettings;
  readonly viewportZoom: number;
  readonly minimized: boolean;
  readonly maximized: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onMinimize: () => void;
  readonly onMaximize: () => void;
  readonly onRename: (title: string) => void;
  readonly onGeometryChange: (geometry: OperationGeometry) => void;
  readonly onGeometryCommit: (geometry: OperationGeometry) => void;
}) {
  const descriptor = options.operationKindRegistry.find((kind) => kind.pluginId === operation.pluginId && kind.type === operation.type);
  const geometry = options.geometry;
  if (!descriptor?.render) return null;
  const capabilities = createHostCapabilities(() => {
    void fetchOperations(null).then(hydrateOperations).catch(() => {});
  });
  return (
    <OperationFrame
      key={operation.id}
      operation={operation}
      active={options.active}
      geometry={geometry}
      zoom={options.viewportZoom}
      subtitle={descriptor.subtitle?.(operation)}
      status={options.status}
      minimized={options.minimized}
      maximized={options.maximized}
      onActivate={options.onActivate}
      onClose={options.onClose}
      onMinimize={options.onMinimize}
      onMaximize={options.onMaximize}
      onRename={options.onRename}
      onGeometryChange={options.onGeometryChange}
      onGeometryCommit={options.onGeometryCommit}
    >
      <PluginErrorBoundary fallback={<div className="fc-plugin-error">Plugin operation failed to render.</div>}>
        <PluginOperationRenderer
          active={options.active}
          capabilities={capabilities}
          descriptor={descriptor}
          geometry={geometry}
          operation={operation}
          terminalFont={options.terminalFont}
          terminalRenderer={options.terminalRenderer}
          theme={options.theme}
          viewportZoom={options.viewportZoom}
          onActivate={options.onActivate}
          onClose={options.onClose}
          onGeometryChange={options.onGeometryChange}
        />
      </PluginErrorBoundary>
    </OperationFrame>
  );
}

function PluginOperationRenderer({
  active,
  capabilities,
  descriptor,
  geometry,
  operation,
  terminalFont,
  terminalRenderer,
  theme,
  viewportZoom,
  onActivate,
  onClose,
  onGeometryChange,
}: PluginOperationRendererProps) {
  if (!descriptor.render) return null;
  return descriptor.render({
    operationId: operation.id,
    theaterId: operation.theaterId,
    pluginId: operation.pluginId,
    type: operation.type,
    operation,
    geometry,
    active,
    zoom: viewportZoom,
    theme,
    terminalRenderer,
    terminalFont,
    api: capabilities.api,
    lifecycle: capabilities.lifecycle,
    terminal: capabilities.terminal,
    notifications: capabilities.notifications,
    operations: capabilities.operations,
    preferences: capabilities.preferences,
    status: capabilities.status,
    onActivate,
    onClose,
    onGeometryChange,
  });
}

function getOperationSubtitle(operation: OperationNode, registry: readonly OperationKindDescriptor[]): string | undefined {
  return registry.find((kind) => kind.pluginId === operation.pluginId && kind.type === operation.type)?.subtitle?.(operation);
}

function ensurePluginGeometry(operation: OperationNode): OperationGeometry {
  return operation.geometry ?? { x: 0, y: 0, width: DEFAULT_SHELL_WIDTH, height: DEFAULT_SHELL_HEIGHT, zIndex: 0 };
}

function operationAccentFromNode(operation: OperationNode): string | null {
  const accent = (operation as OperationNode & { readonly accent?: unknown }).accent;
  return typeof accent === "string" ? accent : null;
}

function maximizedGeometryFor(viewport: { readonly x: number; readonly y: number; readonly zoom: number }, canvasSize: { readonly width: number; readonly height: number }, zIndex: number): OperationGeometry {
  return {
    x: -viewport.x / viewport.zoom,
    y: -viewport.y / viewport.zoom,
    width: Math.max(320, canvasSize.width) / viewport.zoom,
    height: Math.max(240, canvasSize.height - MAXIMIZED_DOCK_INSET) / viewport.zoom,
    zIndex,
  };
}

function maxOperationZIndex(operations: Record<string, OperationGeometry>): number {
  return Object.values(operations).reduce((max, geometry) => Math.max(max, geometry.zIndex), 0);
}

function resolveDefaultLaunchTarget(catalog: readonly OperationCatalogPlugin[]): { readonly pluginId: string; readonly kind: OperationLaunchKind } | null {
  const availableKinds = catalog.flatMap((plugin) =>
    plugin.kinds
      .filter((kind) => kind.disabled !== true)
      .map((kind) => ({ pluginId: plugin.id, kind })),
  );
  return availableKinds.find(({ kind }) => kind.type === "shell") ?? availableKinds[0] ?? null;
}

async function updatePluginOperationGeometry(operationId: string, geometry: OperationGeometry): Promise<void> {
  await fetch(`/operations/${encodeURIComponent(operationId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ geometry }),
  });
}

async function updatePluginOperationAccent(operationId: string, accent: string | null): Promise<void> {
  await fetch(`/operations/${encodeURIComponent(operationId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accent }),
  });
}

async function renamePluginOperation(operationId: string, title: string): Promise<void> {
  await renameOperationRequest(operationId, title);
  await fetchOperations(null).then(hydrateOperations);
}

async function closePluginOperation(operation: OperationNode, plugins: readonly FleetClientPlugin[]): Promise<void> {
  // close가 진행 중인 동안 onExit 재진입은 무시한다(중복 DELETE/404 방지). operation id는 한 번 닫히면 재사용되지 않는다.
  if (closingOperationIds.has(operation.id)) return;
  closingOperationIds.add(operation.id);
  try {
    const plugin = plugins.find((candidate) => candidate.id === operation.pluginId);
    try {
      await plugin?.closeOperation?.(operation.id);
    } finally {
      await fetch(`/operations/${encodeURIComponent(operation.id)}`, { method: "DELETE" }).catch(() => undefined);
    }
    await fetchOperations(null).then(hydrateOperations);
  } finally {
    closingOperationIds.delete(operation.id);
  }
}
