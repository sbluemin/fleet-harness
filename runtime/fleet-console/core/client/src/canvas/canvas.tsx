import { Fragment, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { CompanionPanelDescriptor, ConsoleTheme, FleetClientPlugin, OperationActivity, OperationKindDescriptor, OperationRenderContext } from "@fleet-console/sdk/plugin";

import { fetchOperations } from "../api.js";
import { isBlockingDialogOpen } from "../blocking-dialog.js";
import { flattenGroupedOrder, hydrateOperations, requestOperationLaunchMenu, setActiveOperation } from "../store.js";
import { createHostCapabilities } from "../plugin-capabilities.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { useGlobalSettingsStore } from "../global-settings-store.js";
import type { ConsoleState, OperationNode } from "../types.js";
import { resolveConsoleLanguage } from "../whatsnew-i18n.js";
import { calculateGridSlots, animateViewportTo, claimTopZIndex, clearCompanionOperationId, clearMaximizedOperationId, focusOperation, forceDropCompanionOperationId, getSnapshot as getCanvasSnapshot, minimizeOperation, panelMotionSuppressed, restoreOperation, setCompanionOperationId, setCompanionPanelVisible, setMaximizedOperationId, setOperationGeometry, setViewport, useCanvasState, useCompanionOperationId, useCompanionPanelVisibilityOverrides, useFormationLayout, useFormationView, useMaximizedOperationId, useMinimized, type OperationGeometry } from "./canvas-store.js";
import { escapeSelectorValue, playMinimizeFlight } from "./panel-motion.js";
import { CanvasContextMenu } from "./canvas-context-menu.js";
import { CanvasMinimap } from "./canvas-minimap.js";
import { resolveAccentColor } from "./operation-accent.js";
import { CanvasGrid } from "./canvas-grid.js";
import { OperationFrame } from "./operation-frame.js";
import { hasVisibleCanvasContent, OperationsCanvasEmptyState } from "./operations-canvas-empty-state.js";
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
  readonly keyboardFocusRequestId?: number;
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly geometry: OperationGeometry;
  readonly operation: OperationNode;
  readonly theme: ConsoleTheme;
  readonly language: "en" | "ko";
  readonly viewportZoom: number;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onGeometryChange: (geometry: OperationGeometry) => void;
  readonly onRequestCompanions: (open: boolean) => void;
  readonly companionsOpen: boolean;
  readonly hiddenCompanionPanelIds: readonly string[];
  readonly onSetCompanionPanelVisible: (companionPanelId: string, visible: boolean) => void;
  readonly render: (context: OperationRenderContext) => unknown;
}

const DEFAULT_SHELL_WIDTH = 560;
const DEFAULT_SHELL_HEIGHT = 360;
/* components.css의 .canvas-operation-titlebar top(-1 * --space-3)과 짝을 이루는 상수. */
const TITLEBAR_OUTSET_PX = 12;

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
  const companionOperationId = useCompanionOperationId();
  const companionPanelVisibilityOverrides = useCompanionPanelVisibilityOverrides(companionOperationId);
  const lastValidCompanionRef = useRef<{ readonly operation: OperationNode; readonly descriptor: OperationKindDescriptor } | null>(null);
  const minimized = useMinimized();
  const activePluginOperationId = state.activeOperationId;
  const [contextMenu, setContextMenu] = useState<ContextMenuRequest | null>(null);
  const registry = usePluginRegistry();
  const globalSettings = useGlobalSettingsStore();
  const language = resolveConsoleLanguage(globalSettings.state?.language ?? "auto");
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
    disabled: disabled || formationView || companionOperationId !== null,
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
  const operationKindRegistry = registry.operationKinds;
  const maximizedOperationExists = maximizedOperationId !== null && theaterOperations.some((operation) => operation.id === maximizedOperationId && !minimizedSet.has(operation.id));
  const panelMaximized = maximizedOperationExists ? maximizedOperationId : null;
  const currentCompanionOperation = companionOperationId === null ? undefined : theaterOperations.find((operation) => operation.id === companionOperationId && !minimizedSet.has(operation.id));
  const currentCompanionDescriptor = currentCompanionOperation ? operationKindRegistry.find((kind) => kind.pluginId === currentCompanionOperation.pluginId && kind.type === currentCompanionOperation.type) : undefined;
  if (companionOperationId === null) lastValidCompanionRef.current = null;
  if (currentCompanionOperation && currentCompanionDescriptor?.companions?.length) {
    lastValidCompanionRef.current = { operation: currentCompanionOperation, descriptor: currentCompanionDescriptor };
  }
  const preservedCompanion = !currentCompanionOperation && lastValidCompanionRef.current?.operation.id === companionOperationId
    ? lastValidCompanionRef.current
    : null;
  const companionOperation = currentCompanionOperation ?? preservedCompanion?.operation;
  const companionDescriptor = currentCompanionDescriptor ?? preservedCompanion?.descriptor;
  const companionPanels = companionDescriptor?.companions ?? [];
  const visibleCompanionPanels = companionPanels.filter((panel) => companionPanelVisibilityOverrides[panel.id] ?? !panel.defaultHidden);
  const hiddenCompanionPanelIds = companionPanels.filter((panel) => !visibleCompanionPanels.includes(panel)).map((panel) => panel.id);
  const panelCompanion = companionOperation && companionPanels.length > 0 ? companionOperation.id : null;
  const currentPanelCompanion = currentCompanionOperation && currentCompanionDescriptor?.companions?.length ? currentCompanionOperation.id : null;
  const pluginOperations = companionOperation && !theaterOperations.some((operation) => operation.id === companionOperation.id)
    ? [...theaterOperations, companionOperation]
    : theaterOperations;
  const hasContent = hasVisibleCanvasContent(pluginOperations, minimizedSet);
  useEffect(() => {
    if (companionOperationId === null || currentPanelCompanion !== null) return;
    // ops 푸시 직후 대상 Operation이 목록에서 일시적으로 빠지는 레이스가 있어, 방금 연 분석
    // 레이아웃이 즉시 닫히지 않도록 부재가 지속될 때만 정리한다(복귀 시 cleanup으로 취소).
    const timer = setTimeout(() => {
      lastValidCompanionRef.current = null;
      forceDropCompanionOperationId();
    }, 1_500);
    return () => clearTimeout(timer);
  }, [companionOperationId, currentPanelCompanion]);
  const formationOperationIds = flattenGroupedOrder(
    theaterOperations,
    state.groups.filter((group) => group.theaterId === state.activeTheaterId),
    canvas.operationOrder,
    [],
  ).filter((operation) => !minimizedSet.has(operation.id)).map((operation) => operation.id);
  const formationSlots = formationView ? calculateGridSlots({ x: 0, y: 0, width: canvasSize.width, height: canvasSize.height }, formationOperationIds.length, undefined, undefined, undefined, undefined, formationLayout) : [];
  const formationSlotByOperationId = new Map(formationOperationIds.map((operationId, index) => [operationId, formationSlots[index]!]));
  // Formation 진입·레이아웃 전환 시 슬롯 순서 stagger — 윈도우 리사이즈 재배치에는 적용하지 않는다.
  useEffect(() => {
    if (!formationView || panelMotionSuppressed()) return;
    const root = canvasRef.current;
    if (!root) return;
    const frames = formationOperationIds
      .map((operationId) => root.querySelector<HTMLElement>(`.canvas-operation[data-operation-id="${escapeSelectorValue(operationId)}"]`))
      .filter((element): element is HTMLElement => element !== null);
    // geometry 전용 CSS 변수 채널 — inline transition-delay는 존재 전환의 per-property 지연을 덮어쓴다.
    frames.forEach((element, index) => { element.style.setProperty("--panel-stagger-delay", `${index * 40}ms`); });
    const clear = () => { for (const element of frames) element.style.removeProperty("--panel-stagger-delay"); };
    const timer = window.setTimeout(clear, 600 + frames.length * 40);
    return () => {
      window.clearTimeout(timer);
      clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formationView, formationLayout]);
  // 최대화 시에는 net scale 1(기본 줌)로 렌더한다 — 현재 배율과 무관하게 터미널이 선명하게 그려진다.
  const effectiveZoom = panelMaximized || panelCompanion || formationView ? 1 : canvas.viewport.zoom;
  const topPanelZIndex = maxOperationZIndex(canvas.operations) + 1;
  const companionSlotCount = visibleCompanionPanels.length + 1;

  return (
    <main
      className={`operations-canvas ${interaction.spaceActive ? "is-panning" : ""} ${interaction.shiftActive ? "is-creating" : ""} ${glanceVisible ? "is-glance" : ""} ${panelMaximized ? "is-panel-maximized" : ""} ${panelCompanion ? "is-companion-layout" : ""} ${formationView ? "is-formation-view" : ""}`}
      onPointerDown={interaction.onPointerDown}
      onPointerMove={interaction.onPointerMove}
      onPointerUp={interaction.onPointerUp}
      onPointerCancel={interaction.onPointerCancel}
      onWheel={interaction.onWheel}
      onContextMenu={handleContextMenu}
      ref={canvasRef}
      tabIndex={-1}
    >
      <CanvasGrid viewport={canvas.viewport} />
      <div
        style={{
          // 최대화 시 transform 제거(none)로 net scale 1. 일반 상태에서는 pan 좌표를 정수 픽셀로 스냅해
          // will-change 합성 레이어의 서브픽셀 오프셋 리샘플(글자 번짐)을 제거한다.
          transform: panelMaximized || panelCompanion || formationView
            ? "none"
            : `translate(${Math.round(canvas.viewport.x)}px, ${Math.round(canvas.viewport.y)}px) scale(${canvas.viewport.zoom})`,
        }}
        className="operations-canvas-world"
      >
        {pluginOperations.map((operation) => {
          const baseGeometry = canvas.operations[operation.id] ?? operation.geometry ?? ensurePluginGeometry(operation);
          const operationMaximized = panelMaximized === operation.id;
          const operationCompanion = panelCompanion === operation.id;
          // focus layer는 peer를 실제 최소화하지 않고, mount를 보존한 채 렌더만 감춘다.
          const focusLayerHidden = (panelMaximized !== null || panelCompanion !== null) && !operationMaximized && !operationCompanion;
          const formationSlot = formationSlotByOperationId.get(operation.id);
          const frameGeometry = operationMaximized
            ? maximizedGeometryFor(canvasSize, topPanelZIndex)
            : operationCompanion ? companionGeometryFor(canvasSize, 0, companionSlotCount, topPanelZIndex)
            : formationSlot ? { ...baseGeometry, ...formationSlot } : baseGeometry;
          // 보더 위 명판(top: -space-3)이 캔버스 상단 클립에 잘리는 뷰포트-상대 위치면 내부 인셋으로 전환한다.
          // 최대화/Formation은 전용 CSS 인셋 규칙이 이미 소유한다.
          const topEdge = !operationMaximized && !operationCompanion && !formationSlot
            && canvas.viewport.y + frameGeometry.y * effectiveZoom < TITLEBAR_OUTSET_PX * effectiveZoom;
          return renderPluginOperation(operation, {
            active: activePluginOperationId === operation.id,
            keyboardFocusRequestId: state.keyboardFocusRequest?.operationId === operation.id
              ? state.keyboardFocusRequest.requestId
              : 0,
            geometry: frameGeometry,
            topEdge,
            operationKindRegistry,
            status: state.operationStatus[operation.id],
            theme: state.activeTheme,
            language,
            viewportZoom: effectiveZoom,
            minimized: minimizedSet.has(operation.id),
            maximized: operationMaximized,
            companion: operationCompanion,
            companions: operationCompanion ? visibleCompanionPanels : [],
            companionGeometries: operationCompanion ? visibleCompanionPanels.map((_, index) => companionGeometryFor(canvasSize, index + 1, companionSlotCount, topPanelZIndex)) : [],
            hiddenCompanionPanelIds: operationCompanion ? hiddenCompanionPanelIds : [],
            formation: formationView,
            focusLayerHidden,
            onRenderHiddenFocus: () => {
              const focusTarget = canvasRef.current?.querySelector<HTMLElement>("[data-focus-layer-target='true']");
              if (focusTarget) {
                focusTarget.focus();
                return;
              }
              canvasRef.current?.focus();
            },
            accentKey: canvas.operationAccent[operation.id] ?? operationAccentFromNode(operation),
            onActivate: () => {
              setActiveOperation(operation.id);
              if (!operationMaximized && !operationCompanion && !formationView) setOperationGeometry(operation.id, canvas.operations[operation.id] ?? operation.geometry ?? ensurePluginGeometry(operation));
            },
            onClose: () => {
              if (state.activeOperationId === operation.id) setActiveOperation(null);
              if (panelMaximized === operation.id) clearMaximizedOperationId();
              if (panelCompanion === operation.id) forceDropCompanionOperationId();
              onClose(operation.id);
            },
            onMinimize: () => {
              if (state.activeOperationId === operation.id) setActiveOperation(null);
              playMinimizeFlight(operation.id);
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
              if (!operationMaximized && !operationCompanion && !formationView) setOperationGeometry(operation.id, geometry);
            },
            onGeometryCommit: (geometry) => {
              if (!operationMaximized && !operationCompanion && !formationView) void updatePluginOperationGeometry(operation.id, getCanvasSnapshot().operations[operation.id] ?? geometry);
            },
          });
        })}
      </div>
      {!hasContent ? (
        <OperationsCanvasEmptyState
          activeTheaterId={state.activeTheaterId}
          theaterLabel={state.theaters.find((theater) => theater.id === state.activeTheaterId)?.label ?? state.activeTheaterId ?? ""}
          operations={theaterOperations}
          canLaunch={canLaunch}
          onOpenOperation={onFocus}
          onNewOperation={requestOperationLaunchMenu}
        />
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
        accents={Object.fromEntries(theaterOperations.flatMap((operation) => {
          const accentKey = canvas.operationAccent[operation.id] ?? operationAccentFromNode(operation);
          const color = accentKey ? resolveAccentColor(accentKey) : null;
          return color ? [[operation.id, color] as const] : [];
        }))}
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

// Companion layout은 world transform이 none인 전용 화면 레이아웃이다. Operation과 companion panel이
// 동일한 슬롯 폭을 사용하므로 Map의 geometry/viewport를 변경하지 않고 EXIT 시 원상 복원된다.
function companionGeometryFor(canvasSize: { readonly width: number; readonly height: number }, slotIndex: number, slotCount: number, zIndex: number): OperationGeometry {
  const count = Math.max(1, slotCount);
  const gap = 8;
  const width = Math.max(0, (canvasSize.width - gap * (count - 1)) / count);
  return {
    x: slotIndex * (width + gap),
    y: 0,
    width,
    height: Math.max(0, canvasSize.height),
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
  readonly keyboardFocusRequestId: number;
  readonly geometry: OperationGeometry;
  readonly operationKindRegistry: readonly OperationKindDescriptor[];
  readonly status?: OperationActivity;
  readonly theme: ConsoleTheme;
  readonly language: "en" | "ko";
  readonly viewportZoom: number;
  readonly minimized: boolean;
  readonly maximized: boolean;
  readonly companion: boolean;
  readonly companions: readonly CompanionPanelDescriptor[];
  readonly companionGeometries: readonly OperationGeometry[];
  readonly hiddenCompanionPanelIds: readonly string[];
  readonly formation: boolean;
  readonly focusLayerHidden: boolean;
  readonly onRenderHiddenFocus: () => void;
  readonly topEdge: boolean;
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
  const onRequestCompanions = (open: boolean) => {
    if (open) {
      setActiveOperation(operation.id);
      setCompanionOperationId(operation.id);
    } else clearCompanionOperationId();
  };
  const onSetCompanionPanelVisible = (companionPanelId: string, visible: boolean) => {
    setCompanionPanelVisible(operation.id, companionPanelId, visible);
  };
  return (
    <Fragment key={operation.id}>
      <OperationFrame
        operation={operation}
        active={options.active}
        geometry={geometry}
        zoom={options.viewportZoom}
        status={options.status}
        minimized={options.minimized}
        maximized={options.maximized}
        topEdge={options.topEdge}
        renderHidden={options.focusLayerHidden}
        focusLayerTarget={options.maximized || options.companion}
        interactionDisabled={options.formation || options.companion || options.focusLayerHidden}
        accentKey={options.accentKey}
        onActivate={options.onActivate}
        onClose={options.onClose}
        onMinimize={options.onMinimize}
        onMaximize={options.onMaximize}
        onRename={options.onRename}
        onSetAccent={options.onSetAccent}
        onGeometryChange={options.onGeometryChange}
        onGeometryCommit={options.onGeometryCommit}
        onRenderHiddenFocus={options.onRenderHiddenFocus}
      >
        <PluginErrorBoundary fallback={<div className="fc-plugin-error">Plugin operation failed to render.</div>}>
          <PluginOperationRenderer
            active={options.active}
            keyboardFocusRequestId={options.keyboardFocusRequestId}
            capabilities={capabilities}
            geometry={geometry}
            operation={operation}
            theme={options.theme}
            language={options.language}
            viewportZoom={options.viewportZoom}
            onActivate={options.onActivate}
            onClose={options.onClose}
            onGeometryChange={options.onGeometryChange}
            onRequestCompanions={onRequestCompanions}
            companionsOpen={options.companion}
            hiddenCompanionPanelIds={options.hiddenCompanionPanelIds}
            onSetCompanionPanelVisible={onSetCompanionPanelVisible}
            render={descriptor.render}
          />
        </PluginErrorBoundary>
      </OperationFrame>
      {options.companions.map((companion, index) => (
        <CompanionFrame key={companion.id} descriptor={companion} geometry={options.companionGeometries[index]!} language={options.language}>
          <PluginErrorBoundary fallback={<div className="fc-plugin-error">Plugin companion failed to render.</div>}>
            <PluginOperationRenderer
              active={options.active}
              capabilities={capabilities}
              geometry={geometry}
              operation={operation}
              theme={options.theme}
              language={options.language}
              viewportZoom={options.viewportZoom}
              onActivate={options.onActivate}
              onClose={options.onClose}
              onGeometryChange={options.onGeometryChange}
              onRequestCompanions={onRequestCompanions}
              companionsOpen={options.companion}
              hiddenCompanionPanelIds={options.hiddenCompanionPanelIds}
              onSetCompanionPanelVisible={onSetCompanionPanelVisible}
              render={companion.render}
            />
          </PluginErrorBoundary>
        </CompanionFrame>
      ))}
    </Fragment>
  );
}

function PluginOperationRenderer({
  active,
  keyboardFocusRequestId,
  capabilities,
  geometry,
  operation,
  theme,
  language,
  viewportZoom,
  onActivate,
  onClose,
  onGeometryChange,
  onRequestCompanions,
  companionsOpen,
  hiddenCompanionPanelIds,
  onSetCompanionPanelVisible,
  render,
}: PluginOperationRendererProps) {
  return render({
    operationId: operation.id,
    theaterId: operation.theaterId,
    pluginId: operation.pluginId,
    type: operation.type,
    operation,
    geometry,
    active,
    ...(keyboardFocusRequestId === undefined ? {} : { keyboardFocusRequestId }),
    zoom: viewportZoom,
    theme,
    language,
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
    onRequestCompanions,
    companionsOpen,
    hiddenCompanionPanelIds,
    onSetCompanionPanelVisible,
  }) as ReactNode;
}

function CompanionFrame({ descriptor, geometry, language, children }: {
  readonly descriptor: CompanionPanelDescriptor;
  readonly geometry: OperationGeometry;
  readonly language: ConsoleLocale;
  readonly children: ReactNode;
}) {
  const title = resolveLocalizedText(descriptor.title, language);
  const frameStyle = {
    left: Math.round(geometry.x),
    top: Math.round(geometry.y),
    width: Math.round(geometry.width),
    height: Math.round(geometry.height),
    zIndex: geometry.zIndex,
  } satisfies CSSProperties;
  return (
    <article className="canvas-operation canvas-companion-frame" style={frameStyle} data-canvas-operation aria-label={`Companion ${title}`}>
      {descriptor.hideCaption ? null : (
        <header className="canvas-companion-caption" data-canvas-blocker>
          <span className="canvas-companion-caption-dot" aria-hidden="true" />
          <span className="canvas-companion-caption-title">{title}</span>
        </header>
      )}
      <div className="canvas-operation-terminal canvas-companion-body" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} data-canvas-blocker>
        {children}
      </div>
    </article>
  );
}

async function updatePluginOperationGeometry(operationId: string, geometry: OperationGeometry): Promise<void> {
  await fetch(`/api/v1/operations/${encodeURIComponent(operationId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ geometry }),
  });
}
