import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { ConsoleTheme, FleetClientPlugin, OperationActivity, OperationKindDescriptor } from "@fleet-console/sdk/plugin";

import { fetchOperations } from "../api.js";
import { isBlockingDialogOpen } from "../blocking-dialog.js";
import { flattenGroupedOrder, hydrateOperations, setActiveOperation } from "../store.js";
import { createHostCapabilities } from "../plugin-capabilities.js";
import { usePluginRegistry } from "../plugin-registry.js";
import type { ConsoleState, OperationNode } from "../types.js";
import { calculateGridSlots, animateViewportTo, claimTopZIndex, clearMaximizedOperationId, focusOperation, getSnapshot as getCanvasSnapshot, minimizeOperation, restoreOperation, setMaximizedOperationId, setOperationGeometry, setViewport, useCanvasState, useFormationLayout, useFormationView, useMaximizedOperationId, useMinimized, type OperationGeometry } from "./canvas-store.js";
import { CanvasContextMenu } from "./canvas-context-menu.js";
import { CanvasMinimap } from "./canvas-minimap.js";
import { CanvasGrid } from "./canvas-grid.js";
import { OperationFrame } from "./operation-frame.js";
import { RubberBand } from "./rubber-band.js";
import { useCanvasInteraction } from "./use-canvas-interaction.js";
import { screenToCanvas, type CanvasPoint, type CanvasRect } from "./coordinates.js";

interface OperationsCanvasProps {
  readonly state: ConsoleState;
  readonly catalog: readonly OperationCatalogPlugin[];
  readonly canLaunch: boolean;
  readonly renderKindIcon: (pluginId: string, kind: OperationLaunchKind) => ReactNode;
  readonly onLaunchKind: (pluginId: string, kind: OperationLaunchKind, canvasPoint: CanvasPoint) => void;
  readonly onLaunchAtGeometry: (pluginId: string, kind: OperationLaunchKind, geometry: OperationGeometry) => void;
  readonly onClose: (operationId: string) => void;
  readonly onFocus: (operationId: string) => void;
  readonly onRename: (operationId: string, title: string) => void;
  readonly onSetAccent: (operationId: string, accentKey: string | null) => void;
}

interface ContextMenuRequest {
  readonly anchor: CanvasPoint;
  readonly canvasPoint: CanvasPoint;
}

interface PluginOperationRendererProps {
  readonly active: boolean;
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly descriptor: OperationKindDescriptor;
  readonly geometry: OperationGeometry;
  readonly operation: OperationNode;
  readonly theme: ConsoleTheme;
  readonly viewportZoom: number;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onGeometryChange: (geometry: OperationGeometry) => void;
}

const EMPTY_GUIDE = "Shift-drag to create a Shell. Right-click for actions. Drag to pan; scroll to zoom.";
const DEFAULT_SHELL_WIDTH = 560;
const DEFAULT_SHELL_HEIGHT = 360;

export function OperationsCanvas({
  state,
  catalog,
  canLaunch,
  renderKindIcon,
  onLaunchKind,
  onLaunchAtGeometry,
  onClose,
  onFocus,
  onRename,
  onSetAccent,
}: OperationsCanvasProps) {
  const canvasRef = useRef<HTMLElement | null>(null);
  const canvas = useCanvasState();
  const formationLayout = useFormationLayout();
  const formationView = useFormationView();
  const maximizedOperationId = useMaximizedOperationId();
  const minimized = useMinimized();
  const activePluginOperationId = state.activeOperationId;
  const [contextMenu, setContextMenu] = useState<ContextMenuRequest | null>(null);
  const registry = usePluginRegistry();
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const glanceVisible = useGlanceHold();
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

  const interaction = useCanvasInteraction({
    viewport: canvas.viewport,
    // Formation은 읽기 전용 감독 그리드다 — 슬롯 사이 빈 공간에서 숨은 viewport를 팬/줌하거나
    // 오래된 월드 좌표로 생성하는 일이 없도록 캔버스 제스처를 통째로 게이트한다.
    disabled: disabled || formationView,
    onViewportChange: setViewport,
    onZoom: animateViewportTo,
    onCreate: (rect) => {
      setContextMenu(null);
      if (state.activeTheaterId && canLaunch) {
        const target = resolveDefaultLaunchTarget(catalog);
        if (!target) return;
        const geometry = { ...rectToGeometry(rect), zIndex: claimTopZIndex() };
        onLaunchAtGeometry(target.pluginId, target.kind, geometry);
      }
    },
    consumePointerDown: contextMenu !== null,
    onConsumePointerDown: () => { setContextMenu(null); },
    onClick: clearTerminalFocus,
  });

  const handleContextMenuLaunchKind = (pluginId: string, kind: OperationLaunchKind) => {
    const point = contextMenu?.canvasPoint;
    setContextMenu(null);
    if (!point) return;
    onLaunchKind(pluginId, kind, point);
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest("[data-canvas-blocker], [data-canvas-operation]")) return;
    event.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const anchor: CanvasPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    setContextMenu({ anchor, canvasPoint: screenToCanvas(anchor, canvas.viewport) });
  };

  const minimizedSet = new Set(minimized);
  useEffect(() => {
    if (state.activeOperationId && minimizedSet.has(state.activeOperationId)) setActiveOperation(null);
  }, [minimized, state.activeOperationId]);

  const visibleOperations = Object.fromEntries(
    Object.entries(canvas.operations).filter(([sessionId]) => !minimizedSet.has(sessionId)),
  );
  const theaterOperations = (state.operations ?? []).filter((operation) => operation.theaterId === state.activeTheaterId);
  const pluginOperations = theaterOperations;
  const hasContent = theaterOperations.length > 0;
  const operationKindRegistry = registry.operationKinds;
  const maximizedOperationExists = maximizedOperationId !== null && theaterOperations.some((operation) => operation.id === maximizedOperationId && !minimizedSet.has(operation.id));
  const panelMaximized = maximizedOperationExists ? maximizedOperationId : null;
  const formationOperationIds = flattenGroupedOrder(
    theaterOperations,
    state.groups.filter((group) => group.theaterId === state.activeTheaterId),
    canvas.operationOrder,
    [],
  ).filter((operation) => !minimizedSet.has(operation.id)).map((operation) => operation.id);
  const formationSlots = formationView ? calculateGridSlots({ x: 0, y: 0, width: canvasSize.width, height: canvasSize.height }, formationOperationIds.length, undefined, undefined, undefined, undefined, formationLayout) : [];
  const formationSlotByOperationId = new Map(formationOperationIds.map((operationId, index) => [operationId, formationSlots[index]!]));
  // 최대화 시에는 net scale 1(기본 줌)로 렌더한다 — 현재 배율과 무관하게 터미널이 선명하게 그려진다.
  const effectiveZoom = panelMaximized || formationView ? 1 : canvas.viewport.zoom;
  const topPanelZIndex = maxOperationZIndex(canvas.operations) + 1;

  return (
    <main
      className={`operations-canvas ${interaction.spaceActive ? "is-panning" : ""} ${interaction.shiftActive ? "is-creating" : ""} ${glanceVisible ? "is-glance" : ""} ${panelMaximized ? "is-panel-maximized" : ""} ${formationView ? "is-formation-view" : ""}`}
      onPointerDown={interaction.onPointerDown}
      onPointerMove={interaction.onPointerMove}
      onPointerUp={interaction.onPointerUp}
      onPointerCancel={interaction.onPointerCancel}
      onWheel={interaction.onWheel}
      onContextMenu={handleContextMenu}
      ref={canvasRef}
    >
      <CanvasGrid viewport={canvas.viewport} />
      <div
        style={{
          // 최대화 시 transform 제거(none)로 net scale 1. 일반 상태에서는 pan 좌표를 정수 픽셀로 스냅해
          // will-change 합성 레이어의 서브픽셀 오프셋 리샘플(글자 번짐)을 제거한다.
          transform: panelMaximized || formationView
            ? "none"
            : `translate(${Math.round(canvas.viewport.x)}px, ${Math.round(canvas.viewport.y)}px) scale(${canvas.viewport.zoom})`,
        }}
        className="operations-canvas-world"
      >
        {pluginOperations.map((operation) => {
          const baseGeometry = canvas.operations[operation.id] ?? operation.geometry ?? ensurePluginGeometry(operation);
          const operationMaximized = panelMaximized === operation.id;
          const formationSlot = formationSlotByOperationId.get(operation.id);
          const frameGeometry = operationMaximized
            ? maximizedGeometryFor(canvasSize, topPanelZIndex)
            : formationSlot ? { ...baseGeometry, ...formationSlot } : baseGeometry;
          return renderPluginOperation(operation, {
            active: activePluginOperationId === operation.id,
            geometry: frameGeometry,
            operationKindRegistry,
            status: state.operationStatus[operation.id],
            theme: state.activeTheme,
            viewportZoom: effectiveZoom,
            minimized: minimizedSet.has(operation.id),
            maximized: operationMaximized,
            formation: formationView,
            accentKey: canvas.operationAccent[operation.id] ?? operationAccentFromNode(operation),
            onActivate: () => {
              setActiveOperation(operation.id);
              if (!operationMaximized && !formationView) setOperationGeometry(operation.id, canvas.operations[operation.id] ?? operation.geometry ?? ensurePluginGeometry(operation));
            },
            onClose: () => {
              if (state.activeOperationId === operation.id) setActiveOperation(null);
              if (panelMaximized === operation.id) clearMaximizedOperationId();
              onClose(operation.id);
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
              onRename(operation.id, title);
            },
            onSetAccent: (accentKey) => {
              onSetAccent(operation.id, accentKey);
            },
            onGeometryChange: (geometry) => {
              if (!operationMaximized && !formationView) setOperationGeometry(operation.id, geometry);
            },
            onGeometryCommit: (geometry) => {
              if (!operationMaximized && !formationView) void updatePluginOperationGeometry(operation.id, getCanvasSnapshot().operations[operation.id] ?? geometry);
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
          placement="cursor"
          catalog={catalog}
          canLaunch={canLaunch && !formationView}
          renderKindIcon={renderKindIcon}
          onLaunchKind={handleContextMenuLaunchKind}
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
    </main>
  );
}

function viewportBoundsFor(element: HTMLElement | null): { readonly width: number; readonly height: number } | undefined {
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function clearTerminalFocus(): void {
  if (typeof document !== "undefined") {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }
  setActiveOperation(null);
}

function rectToGeometry(rect: CanvasRect): OperationGeometry {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, zIndex: 0 };
}

function ensurePluginGeometry(operation: OperationNode): OperationGeometry {
  return operation.geometry ?? { x: 0, y: 0, width: DEFAULT_SHELL_WIDTH, height: DEFAULT_SHELL_HEIGHT, zIndex: 0 };
}

// 최대화 패널은 world transform이 none인 상태에서 렌더되므로 화면 좌표(0,0) 기준 캔버스 풀사이즈로 배치한다.
// viewport에 의존하지 않아 현재 줌/팬과 무관하게 항상 net scale 1로 최대화된다.
function maximizedGeometryFor(canvasSize: { readonly width: number; readonly height: number }, zIndex: number): OperationGeometry {
  return {
    x: 0,
    y: 0,
    width: Math.max(320, canvasSize.width),
    height: Math.max(240, canvasSize.height),
    zIndex,
  };
}

function maxOperationZIndex(operations: Record<string, OperationGeometry>): number {
  return Object.values(operations).reduce((max, geometry) => Math.max(max, geometry.zIndex), 0);
}

export function useGlanceHold(): boolean {
  const [glanceVisible, setGlanceVisible] = useState(false);
  const heldAltCodesRef = useRef(new Set<string>());

  useEffect(() => {
    const clearGlance = () => {
      heldAltCodesRef.current.clear();
      setGlanceVisible(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      // 콘솔 전역 단축키 관례(global-shortcuts)와 동일하게, 블로킹 다이얼로그 위에는 HUD를 띄우지 않는다.
      if (!isGlanceAltKey(event) || event.repeat || event.ctrlKey || event.metaKey || isBlockingDialogOpen()) return;
      heldAltCodesRef.current.add(event.code);
      setGlanceVisible(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (!isGlanceAltKey(event)) return;
      heldAltCodesRef.current.delete(event.code);
      setGlanceVisible(heldAltCodesRef.current.size > 0);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") clearGlance();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", clearGlance);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", clearGlance);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return glanceVisible;
}

function isGlanceAltKey(event: KeyboardEvent): boolean {
  return event.code === "AltLeft" || event.code === "AltRight";
}

function resolveDefaultLaunchTarget(catalog: readonly OperationCatalogPlugin[]): { readonly pluginId: string; readonly kind: OperationLaunchKind } | null {
  const availableKinds = catalog.flatMap((plugin) =>
    plugin.kinds.filter((kind) => kind.disabled !== true).map((kind) => ({ pluginId: plugin.id, kind })),
  );
  return availableKinds.find(({ kind }) => kind.type === "shell") ?? availableKinds[0] ?? null;
}

// 패널 헤더 이름 변경은 캔버스 내부에서 즉시 처리한다.
function operationAccentFromNode(operation: OperationNode): string | null {
  return typeof operation.accent === "string" ? operation.accent : null;
}

function renderPluginOperation(operation: OperationNode, options: {
  readonly active: boolean;
  readonly geometry: OperationGeometry;
  readonly operationKindRegistry: readonly OperationKindDescriptor[];
  readonly status?: OperationActivity;
  readonly theme: ConsoleTheme;
  readonly viewportZoom: number;
  readonly minimized: boolean;
  readonly maximized: boolean;
  readonly formation: boolean;
  readonly accentKey: string | null;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onMinimize: () => void;
  readonly onMaximize: () => void;
  readonly onRename: (title: string) => void;
  readonly onSetAccent: (accentKey: string | null) => void;
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
      status={options.status}
      minimized={options.minimized}
      maximized={options.maximized}
      interactionDisabled={options.formation}
      accentKey={options.accentKey}
      onActivate={options.onActivate}
      onClose={options.onClose}
      onMinimize={options.onMinimize}
      onMaximize={options.onMaximize}
      onRename={options.onRename}
      onSetAccent={options.onSetAccent}
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
    api: capabilities.api,
    lifecycle: capabilities.lifecycle,
    terminal: capabilities.terminal,
    notifications: capabilities.notifications,
    operations: capabilities.operations,
    preferences: capabilities.preferences,
    settings: capabilities.settings,
    status: capabilities.status,
    onActivate,
    onClose,
    onGeometryChange,
  });
}

async function updatePluginOperationGeometry(operationId: string, geometry: OperationGeometry): Promise<void> {
  await fetch(`/api/v1/operations/${encodeURIComponent(operationId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ geometry }),
  });
}
