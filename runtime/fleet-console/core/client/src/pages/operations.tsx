import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";
import { fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";
import type { ClientApiCapability, FleetClientPlugin } from "@fleet-console/sdk/plugin";

import { addTheater, createGroup, deleteGroup, fetchGroups, fetchOperations, forgetTheater, issueTheaterFolderGrant, patchOperation, renameOperation, updateGroup, ApiError } from "../api.js";
import { animateViewportTo, claimTopZIndex, clearMaximizedOperationId, ensureDefaultGeometry, focusOperation as focusCanvasOperation, getFormationView, getLoadedTheaterId, getMaximizedOperationId, getSnapshot as getCanvasSnapshot, loadForTheater, pruneOperations, restoreOperation, setMaximizedOperationId, setOperationGeometry, toggleFormationView, useFormationView, useMaximizedOperationId, useMinimized, type OperationGeometry } from "../canvas/canvas-store.js";
import { screenToCanvas, type CanvasPoint } from "../canvas/coordinates.js";
import { OperationsCanvas } from "../canvas/canvas.js";
import { createHostCapabilities } from "../plugin-capabilities.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { RightRail } from "../rail/right-rail.js";
import { OperationsSideBar } from "../sidebar/operations-side-bar.js";
import { CodexReadingSheet } from "../components/codex-reading-sheet.js";
import { beginAddTheater, cancelAddTheater, compareOperationCreatedAt, completeAddTheater, consumeOperationFocus, failAddTheater, flattenGroupedOrder, focusOperation, getState, hydrateGroups, hydrateOperations, nextOperationId, removeTheater, setActiveOperation, setActiveTheater, sortOperationsByOrder } from "../store.js";
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
  const formationView = useFormationView();
  const minimized = useMinimized();
  const registry = usePluginRegistry();
  const [catalog, setCatalog] = useState<readonly OperationCatalogPlugin[]>([]);

  const operationOrder = useMemo(
    () => sortedTheaterOperations(state).map((operation) => operation.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.operations, state.activeTheaterId],
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const handleToggleFormation = useCallback(() => {
    toggleFormationView();
  }, []);

  useEffect(() => {
    loadForTheater(state.activeTheaterId);
  }, [state.activeTheaterId]);

  useEffect(() => {
    if (!state.activeTheaterId) { setCatalog([]); return; }
    void fetchOperationCatalog().then(setCatalog).catch(() => {});
  }, [state.activeTheaterId]);

  // Alt+←/→는 SideBar 가시 순서로 포커스를 순환하고, Alt+F는 같은 capture/editable 가드 정책을 공유한다.
  useEffect(() => {
    const maximizedRef = { current: maximizedOperationId };
    const formationRef = { current: formationView };
    const handler = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches("input, textarea, [contenteditable='true']") && !active.closest(".xterm")) return;
      // macOS의 Option+문자는 합성 문자를 내보내므로(event.key가 "©"/"ƒ") 물리 키 기준인 event.code로 판별한다.
      if (event.code === "KeyF" && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        handleToggleFormation();
        return;
      }
      if (event.shiftKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      // Alt 순환 순서를 Left SideBar 표시 순서(비-collapsed 그룹 order → 그룹 내 operationOrder → ungrouped)와 정확히 일치시킨다.
      const snapshot = stateRef.current;
      const canvas = getCanvasSnapshot();
      const order = flattenGroupedOrder(
        snapshot.operations.filter((operation) => operation.theaterId === snapshot.activeTheaterId),
        snapshot.groups.filter((g) => g.theaterId === snapshot.activeTheaterId),
        canvas.operationOrder,
        canvas.collapsedGroups,
      ).map((operation) => operation.id);
      if (order.length === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const currentId = maximizedRef.current ?? stateRef.current.activeOperationId;
      const nextId = nextOperationId(order, currentId, event.key === "ArrowRight" ? 1 : -1);
      if (!nextId) return;
      if (formationRef.current) {
        restoreOperation(nextId);
        setActiveOperation(nextId);
        return;
      }
      if (maximizedRef.current) {
        setActiveOperation(nextId);
        setMaximizedOperationId(nextId);
        return;
      }
      focusOperation(nextId);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [formationView, handleToggleFormation, maximizedOperationId]);

  useEffect(() => {
    for (const operationId of operationOrder) ensureDefaultGeometry(operationId);
    if (state.operationsHydrated) pruneOperations(operationOrder);
  }, [operationOrder, state.operationsHydrated]);

  // 검색·ALERTS 등에서 들어온 일회성 이동 요청을 처리한다.
  useEffect(() => {
    const operationId = state.pendingOperationFocus;
    if (operationId === null) return;
    if (formationView) {
      restoreOperation(operationId);
      setActiveOperation(operationId);
      consumeOperationFocus();
      return;
    }
    // 최대화 뷰 유지: theater 전환 effect(loadForTheater, 위쪽 effect)가 먼저 실행되어
    // 도착 Theater의 최대화 상태를 복원한 뒤이므로, 여기서 getMaximizedOperationId()는 도착 Theater 기준값이다.
    // 최대화 중이면 최대화 대상만 목적지 op로 교체한다 — handleFocus·Alt+←/→와 동일 정책.
    if (getMaximizedOperationId() !== null) {
      setMaximizedOperationId(operationId);
      consumeOperationFocus();
      return;
    }
    clearMaximizedOperationId();
    const viewportSize = viewportSizeFor(bodyRef.current);
    if (viewportSize) focusCanvasOperation(operationId, viewportSize);
    consumeOperationFocus();
  }, [formationView, state.pendingOperationFocus]);

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

  const handleFocus = useCallback((operationId: string) => {
    const operation = stateRef.current.operations.find((candidate) => candidate.id === operationId);
    if (!operation) return;
    if (operation.theaterId !== stateRef.current.activeTheaterId) {
      focusOperation(operationId);
      return;
    }
    if (getFormationView()) {
      restoreOperation(operationId);
      setActiveOperation(operationId);
      return;
    }
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

  const handleRename = useCallback((operationId: string, title: string) => {
    void renameOperation(operationId, title)
      .then(() => fetchOperations(null))
      .then(hydrateOperations)
      .catch(() => {});
  }, []);

  const handleSetGroupId = useCallback((operationId: string, groupId: string | null) => {
    void patchOperation(operationId, { groupId })
      .then(() => fetchOperations(null))
      .then(hydrateOperations)
      .catch(() => {});
  }, []);

  const handleCreateGroup = useCallback((theaterId: string, name: string, operationId?: string) => {
    void createGroup({ theaterId, name, color: "blue" })
      .then((group) => operationId ? patchOperation(operationId, { groupId: group.id }).then(() => {}) : undefined)
      .then(() => Promise.all([
        fetchOperations(null).then(hydrateOperations),
        fetchGroups(null).then(hydrateGroups),
      ]))
      .catch(() => {});
  }, []);

  const handleSetGroupColor = useCallback((groupId: string, color: string | null) => {
    if (!color) return;
    void updateGroup(groupId, { color })
      .then(() => fetchGroups(null))
      .then(hydrateGroups)
      .catch(() => {});
  }, []);

  const handleRenameGroup = useCallback((groupId: string, name: string) => {
    void updateGroup(groupId, { name })
      .then(() => fetchGroups(null))
      .then(hydrateGroups)
      .catch(() => {});
  }, []);

  const handleReorderGroups = useCallback((orderedGroupIds: readonly string[]) => {
    const groupById = new Map(stateRef.current.groups.map((group) => [group.id, group]));
    const patches = orderedGroupIds.flatMap((groupId, order) => {
      const group = groupById.get(groupId);
      if (!group || group.order === order) return [];
      return [updateGroup(groupId, { order })];
    });
    if (patches.length === 0) return;
    // 일부 PATCH가 실패해도 항상 서버 실제 순서로 재동기화한다 — Promise.all은 첫 실패에서 reject되어
    // refetch를 건너뛰므로, 성공/실패가 섞이면 낙관적 순서가 서버와 어긋난 채 UI에 남는다.
    void Promise.allSettled(patches)
      .then(() => fetchGroups(null))
      .then(hydrateGroups)
      .catch(() => {});
  }, []);

  const handleUngroupAll = useCallback((groupId: string) => {
    void deleteGroup(groupId)
      .then(() => Promise.all([
        fetchOperations(null).then(hydrateOperations),
        fetchGroups(null).then(hydrateGroups),
      ]))
      .catch(() => {});
  }, []);

  const handleClose = useCallback((operationId: string) => {
    if (closingOperationIds.has(operationId)) return;
    closingOperationIds.add(operationId);
    const pluginId = stateRef.current.operations.find((op) => op.id === operationId)?.pluginId;
    const plugin = (pluginId ? registry.plugins.find((p) => p.id === pluginId) : null) ?? null;
    void closeOperation(operationId, plugin).finally(() => closingOperationIds.delete(operationId));
  }, [registry.plugins]);

  const handleAddTheater = useCallback(async (path: string) => {
    beginAddTheater();
    try {
      const folderGrantId = await issueTheaterFolderGrant(path);
      const result = await addTheater(folderGrantId);
      completeAddTheater(result);
    } catch (error) {
      failAddTheater(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handleForgetTheater = useCallback(async (theaterId: string) => {
    // 서버는 Theater 삭제 시 소속 Operation/Group 레코드도 정리한다 — 로컬 목록만 지우면
    // stale 패널이 퀵서치 등에 남으므로(Codex P2) 두 컬렉션을 재수화한다.
    const refreshCollections = () => Promise.all([
      fetchOperations(null).then(hydrateOperations),
      fetchGroups(null).then(hydrateGroups),
    ]).then(() => {}).catch(() => {});
    try {
      await forgetTheater(theaterId);
      removeTheater(theaterId);
      await refreshCollections();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        removeTheater(theaterId);
        await refreshCollections();
        return;
      }
      failAddTheater(error instanceof Error ? error.message : String(error));
    }
  }, []);

  return (
    <div
      className="console-body is-canvas"
      ref={bodyRef}
    >
      <OperationsSideBar
        theaters={state.theaters}
        activeTheaterId={state.activeTheaterId}
        operations={state.operations}
        groups={state.groups}
        minimized={minimized}
        activeOperationId={state.activeOperationId}
        operationNotifications={state.operationNotifications}
        catalog={catalog}
        canLaunch={canLaunch}
        addingTheater={state.addingTheater}
        theaterError={state.theaterError}
        renderKindIcon={renderKindIcon}
        onLaunchKind={handleSideBarLaunchKind}
        onResetView={handleResetView}
        onClose={handleClose}
        onFocus={handleFocus}
        onSetAccent={handleSetAccent}
        onRename={handleRename}
        onSetGroupId={handleSetGroupId}
        onCreateGroup={handleCreateGroup}
        onSetGroupColor={handleSetGroupColor}
        onRenameGroup={handleRenameGroup}
        onReorderGroups={handleReorderGroups}
        onUngroupAll={handleUngroupAll}
        onSelectTheater={setActiveTheater}
        onAddTheater={handleAddTheater}
        onCancelAddTheater={cancelAddTheater}
        onForgetTheater={handleForgetTheater}
      />
      <OperationsCanvas
        state={state}
        catalog={catalog}
        canLaunch={canLaunch}
        renderKindIcon={renderKindIcon}
        onLaunchKind={handleCanvasLaunchKind}
        onLaunchAtGeometry={handleLaunchAtGeometry}
        onResetView={handleResetView}
        onToggleFormation={handleToggleFormation}
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
    const operation = await capabilities.operations.create({
      theaterId,
      type: kind.type,
      pluginId,
      title: kind.title,
      geometry,
    });
    newOperationId = operation.id;
  }
  await fetchOperations(null).then(hydrateOperations).catch(() => {});
  if (!newOperationId) return;
  // 최대화 패널이 떠 있는 상태에서 새 Operation을 만들면 최대화를 유지하고 새 패널을 최대화 대상으로 승계한다.
  // focusOperation은 pendingOperationFocus 경로로 clearMaximizedOperationId를 부르므로(최대화 해제), 최대화 중에는 호출하지 않는다.
  // handleFocus(operations.tsx)·Alt+←/→ 순환과 동일 정책으로, setMaximizedOperationId가 나머지 패널을 최소화해 새 패널만 전면화한다.
  //
  // 단, 비동기 launch 동안 사용자가 다른 Theater로 전환했을 수 있다. getMaximizedOperationId/setMaximizedOperationId는
  // canvas 스토어가 로드한 Theater 기준으로 동작하므로, 그 로드된 Theater가 launch 시점 Theater와 같을 때만 승계해야 한다.
  // 다르면 setMaximizedOperationId가 다른 Theater에 타 Theater 소속 op를 최대화 대상으로 잘못 등록해 패널 상태를 망가뜨린다.
  // store.activeTheaterId가 아니라 getLoadedTheaterId()를 보는 이유: loadForTheater가 passive effect라 store보다 늦게
  // 갱신되어, A→B→A 왕복 시 store는 A인데 canvas는 아직 B인 desync 창이 생기기 때문이다.
  const stillOnLaunchTheater = getLoadedTheaterId() === theaterId;
  // fetchOperations 실패(.catch)로 hydrate가 누락되면 store에 newOperationId가 없다. 이때 승계하면
  // setMaximizedOperationId가 기존 패널을 전부 최소화하지만 새 id는 캔버스에 없어 빈 화면이 박제된다.
  // hydrate된 경우에만 승계하고, 아니면 focusOperation(op 부재 시 안전하게 no-op)으로 기존 최대화 패널을 그대로 둔다.
  const operationHydrated = getState().operations.some((operation) => operation.id === newOperationId);
  if (stillOnLaunchTheater && operationHydrated && getMaximizedOperationId() !== null) {
    setActiveOperation(newOperationId);
    setMaximizedOperationId(newOperationId);
  } else {
    // Theater가 다르거나 hydrate 누락이면 Theater-aware한 focusOperation으로 처리한다(launch Theater로 복귀·포커스, 부재 시 no-op).
    focusOperation(newOperationId);
  }
}

async function closeOperation(operationId: string, plugin: FleetClientPlugin | null): Promise<void> {
  try {
    if (plugin?.closeOperation) await plugin.closeOperation(operationId);
  } catch { /* 플러그인 close 오류는 무시 */ }
  await fetch(`/api/v1/operations/${encodeURIComponent(operationId)}`, { method: "DELETE" }).catch(() => {});
  await fetchOperations(null).then(hydrateOperations).catch(() => {});
}
