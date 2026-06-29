import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";
import { fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";
import type { ClientApiCapability, FleetClientPlugin } from "@fleet-console/sdk/plugin";

import { fetchOperations, patchOperation } from "../api.js";
import { animateViewportTo, claimTopZIndex, clearMaximizedOperationId, ensureDefaultGeometry, focusOperation as focusCanvasOperation, getMaximizedOperationId, getSnapshot as getCanvasSnapshot, loadForTheater, pruneOperations, restoreOperation, setMaximizedOperationId, setOperationGeometry, toggleBackgroundAnimation, toggleMapFullscreen, togglePerimeterAnimation, useBackgroundAnimation, useMapFullscreen, useMaximizedOperationId, useMinimized, usePerimeterAnimation, type OperationGeometry } from "../canvas/canvas-store.js";
import { screenToCanvas, type CanvasPoint } from "../canvas/coordinates.js";
import { OperationsCanvas } from "../canvas/canvas.js";
import { createHostCapabilities } from "../plugin-capabilities.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { RightRail } from "../rail/right-rail.js";
import { OperationsSideBar } from "../sidebar/operations-side-bar.js";
import { CodexReadingSheet } from "../components/codex-reading-sheet.js";
import { compareOperationCreatedAt, consumeOperationFocus, focusOperation, hydrateOperations, nextOperationId, setActiveOperation, sortOperationsByOrder } from "../store.js";
import type { ConsoleState, OperationNode } from "../types.js";

const STABLE_RAIL_API: ClientApiCapability = createHostCapabilities().api;
const DEFAULT_SHELL_WIDTH = 560;
const DEFAULT_SHELL_HEIGHT = 360;
// 사용자 close와 PTY 자가종료가 같은 operation의 close path를 중복 실행하는 것을 막는다.
const closingOperationIds = new Set<string>();

interface OperationsProps {
  readonly state: ConsoleState;
}

export function Operations({ state }: OperationsProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const maximizedOperationId = useMaximizedOperationId();
  const minimized = useMinimized();
  const radarEnabled = useBackgroundAnimation();
  const perimeterEnabled = usePerimeterAnimation();
  const mapFullscreen = useMapFullscreen();
  const registry = usePluginRegistry();
  const [catalog, setCatalog] = useState<readonly OperationCatalogPlugin[]>([]);

  const operationOrder = useMemo(
    () => sortedTheaterOperations(state).map((operation) => operation.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.operations, state.activeTheaterId],
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    loadForTheater(state.activeTheaterId);
  }, [state.activeTheaterId]);

  useEffect(() => {
    if (!state.activeTheaterId) { setCatalog([]); return; }
    void fetchOperationCatalog().then(setCatalog).catch(() => {});
  }, [state.activeTheaterId]);

  // Alt+←/→ 로 현재 Theater 내 Operation 포커스를 순환 이동한다.
  useEffect(() => {
    const maximizedRef = { current: maximizedOperationId };
    const handler = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches("input, textarea, [contenteditable='true']") && !active.closest(".xterm")) return;
      // Alt 순환 순서를 Left SideBar 표시 순서(드래그 재정렬 반영)와 정확히 일치시킨다.
      const snapshot = stateRef.current;
      const order = sortOperationsByOrder(
        snapshot.operations.filter((operation) => operation.theaterId === snapshot.activeTheaterId),
        getCanvasSnapshot().operationOrder,
      ).map((operation) => operation.id);
      if (order.length === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const currentId = maximizedRef.current ?? stateRef.current.activeOperationId;
      const nextId = nextOperationId(order, currentId, event.key === "ArrowRight" ? 1 : -1);
      if (!nextId) return;
      if (maximizedRef.current) {
        setActiveOperation(nextId);
        setMaximizedOperationId(nextId);
        return;
      }
      focusOperation(nextId);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [maximizedOperationId]);

  useEffect(() => {
    for (const operationId of operationOrder) ensureDefaultGeometry(operationId);
    if (state.operationsHydrated) pruneOperations(operationOrder);
  }, [operationOrder, state.operationsHydrated]);

  // 검색 등에서 들어온 일회성 이동 요청을 처리한다.
  useEffect(() => {
    const operationId = state.pendingOperationFocus;
    if (operationId === null) return;
    clearMaximizedOperationId();
    const viewportSize = viewportSizeFor(bodyRef.current);
    if (viewportSize) focusCanvasOperation(operationId, viewportSize);
    consumeOperationFocus();
  }, [state.pendingOperationFocus]);

  const canLaunch = !!state.activeTheaterId && !state.addingTheater;
  const theaterOperations = (state.operations ?? []).filter((op) => op.theaterId === state.activeTheaterId);

  const renderKindIcon = useCallback((pluginId: string, kind: OperationLaunchKind): ReactNode => {
    const plugin = registry.plugins.find((p) => p.id === pluginId);
    return plugin?.renderLaunchIcon?.(kind) ?? null;
  }, [registry.plugins]);

  const handleCanvasLaunchKind = useCallback((pluginId: string, kind: OperationLaunchKind, canvasPoint: CanvasPoint) => {
    if (!stateRef.current.activeTheaterId) return;
    const geometry = { ...canvasPointToGeometry(canvasPoint), zIndex: claimTopZIndex() };
    void launchViaPlugin(pluginId, kind, geometry, stateRef.current.activeTheaterId, registry.plugins);
  }, [registry.plugins]);

  const handleSideBarLaunchKind = useCallback((pluginId: string, kind: OperationLaunchKind) => {
    if (!stateRef.current.activeTheaterId) return;
    const canvasPoint = canvasCenterPoint(bodyRef.current);
    const geometry = { ...canvasPointToGeometry(canvasPoint), zIndex: claimTopZIndex() };
    void launchViaPlugin(pluginId, kind, geometry, stateRef.current.activeTheaterId, registry.plugins);
  }, [registry.plugins]);

  const handleLaunchAtGeometry = useCallback((pluginId: string, kind: OperationLaunchKind, geometry: OperationGeometry) => {
    if (!stateRef.current.activeTheaterId) return;
    void launchViaPlugin(pluginId, kind, geometry, stateRef.current.activeTheaterId, registry.plugins);
  }, [registry.plugins]);

  const handleResetView = useCallback(() => {
    animateViewportTo({ x: 0, y: 0, zoom: 1 });
  }, []);

  const handleMaximizeMap = useCallback(() => {
    toggleMapFullscreen();
  }, []);

  const handleToggleRadar = useCallback(() => {
    toggleBackgroundAnimation();
  }, []);

  const handleTogglePerimeter = useCallback(() => {
    togglePerimeterAnimation();
  }, []);

  const handleFocus = useCallback((operationId: string) => {
    const operation = stateRef.current.operations.find((candidate) => candidate.id === operationId);
    if (!operation) return;
    // 최대화 중인 패널이 있고 클릭 대상이 다른 op면 최대화 패널을 전환하고 끝낸다.
    // Alt+←/→ 순환(operations.tsx:73-76)과 동일 정책. getMaximizedOperationId()는 store 스냅샷에서 live로 읽으므로 [] deps 유지 가능.
    const currentMaximized = getMaximizedOperationId();
    if (currentMaximized !== null && currentMaximized !== operationId) {
      setActiveOperation(operationId);
      setMaximizedOperationId(operationId);
      return;
    }
    const snapshot = getCanvasSnapshot();
    const geometry = snapshot.operations[operationId] ?? operation.geometry ?? ensurePluginGeometry(operation);
    if (!snapshot.operations[operationId]) setOperationGeometry(operationId, geometry);
    restoreOperation(operationId);
    setActiveOperation(operationId);
    const viewportSize = viewportSizeFor(bodyRef.current);
    if (viewportSize) focusCanvasOperation(operationId, viewportSize);
  }, []);

  const handleSetAccent = useCallback((operationId: string, accentKey: string | null) => {
    void patchOperation(operationId, { accent: accentKey })
      .then(() => fetchOperations(null))
      .then(hydrateOperations)
      .catch(() => {});
  }, []);

  const handleClose = useCallback((operationId: string) => {
    if (closingOperationIds.has(operationId)) return;
    closingOperationIds.add(operationId);
    const pluginId = stateRef.current.operations.find((op) => op.id === operationId)?.pluginId;
    const plugin = (pluginId ? registry.plugins.find((p) => p.id === pluginId) : null) ?? null;
    void closeOperation(operationId, plugin).finally(() => closingOperationIds.delete(operationId));
  }, [registry.plugins]);

  return (
    <div
      className="console-body is-canvas"
      ref={bodyRef}
    >
      <OperationsSideBar
        operations={theaterOperations}
        minimized={minimized}
        activeOperationId={state.activeOperationId}
        operationNotifications={state.operationNotifications}
        catalog={catalog}
        canLaunch={canLaunch}
        mapFullscreen={mapFullscreen}
        radarEnabled={radarEnabled}
        perimeterEnabled={perimeterEnabled}
        renderKindIcon={renderKindIcon}
        onLaunchKind={handleSideBarLaunchKind}
        onResetView={handleResetView}
        onMaximizeMap={handleMaximizeMap}
        onToggleRadar={handleToggleRadar}
        onTogglePerimeter={handleTogglePerimeter}
        onClose={handleClose}
        onFocus={handleFocus}
        onSetAccent={handleSetAccent}
      />
      <OperationsCanvas
        state={state}
        catalog={catalog}
        canLaunch={canLaunch}
        mapFullscreen={mapFullscreen}
        radarEnabled={radarEnabled}
        perimeterEnabled={perimeterEnabled}
        renderKindIcon={renderKindIcon}
        onLaunchKind={handleCanvasLaunchKind}
        onLaunchAtGeometry={handleLaunchAtGeometry}
        onResetView={handleResetView}
        onMaximizeMap={handleMaximizeMap}
        onToggleRadar={handleToggleRadar}
        onTogglePerimeter={handleTogglePerimeter}
        onClose={handleClose}
        onFocus={handleFocus}
        onSetAccent={handleSetAccent}
      />
      <RightRail theaterId={state.activeTheaterId} api={STABLE_RAIL_API} />
      <CodexReadingSheet />
    </div>
  );
}

function sortedTheaterOperations(state: ConsoleState): readonly OperationNode[] {
  return state.operations
    .filter((operation) => operation.theaterId === state.activeTheaterId)
    .sort(compareOperationCreatedAt);
}

function viewportSizeFor(element: HTMLElement | null): { readonly width: number; readonly height: number } | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function ensurePluginGeometry(operation: OperationNode): OperationGeometry {
  return operation.geometry ?? { x: 0, y: 0, width: DEFAULT_SHELL_WIDTH, height: DEFAULT_SHELL_HEIGHT, zIndex: 0 };
}

function canvasCenterPoint(element: HTMLElement | null): CanvasPoint {
  const snapshot = getCanvasSnapshot();
  const width = element?.clientWidth ?? 800;
  const height = element?.clientHeight ?? 600;
  return screenToCanvas({ x: width / 2, y: height / 2 }, snapshot.viewport);
}

function canvasPointToGeometry(point: CanvasPoint): Omit<OperationGeometry, "zIndex"> {
  return {
    x: point.x - DEFAULT_SHELL_WIDTH / 2,
    y: point.y - DEFAULT_SHELL_HEIGHT / 2,
    width: DEFAULT_SHELL_WIDTH,
    height: DEFAULT_SHELL_HEIGHT,
  };
}

async function launchViaPlugin(
  pluginId: string,
  kind: OperationLaunchKind,
  geometry: OperationGeometry,
  theaterId: string,
  plugins: readonly FleetClientPlugin[],
): Promise<void> {
  const plugin = plugins.find((p) => p.id === pluginId);
  const resync = () => { void fetchOperations(null).then(hydrateOperations).catch(() => {}); };
  const capabilities = createHostCapabilities(resync);
  let newOperationId: string | null = null;
  if (plugin?.launch) {
    const result = await plugin.launch({ theaterId, kind, geometry, operations: capabilities.operations });
    newOperationId = result.id;
  } else {
    const operation = await capabilities.operations.createRoot({
      theaterId,
      type: kind.type,
      pluginId,
      title: kind.title,
      geometry,
    });
    newOperationId = operation.id;
  }
  await fetchOperations(null).then(hydrateOperations).catch(() => {});
  if (newOperationId) focusOperation(newOperationId);
}

async function closeOperation(operationId: string, plugin: FleetClientPlugin | null): Promise<void> {
  try {
    if (plugin?.closeOperation) await plugin.closeOperation(operationId);
  } catch { /* 플러그인 close 오류는 무시 */ }
  await fetch(`/api/v1/operations/${encodeURIComponent(operationId)}`, { method: "DELETE" }).catch(() => {});
  await fetchOperations(null).then(hydrateOperations).catch(() => {});
}
