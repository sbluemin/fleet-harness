import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";

import type { OperationGroup, OperationNode, OperationNotification } from "../types.js";
import { CanvasContextMenu } from "../canvas/canvas-context-menu.js";
import { GroupContextMenu } from "../canvas/group-context-menu.js";
import { operationAccentFromNode, resolveAccentColor } from "../canvas/operation-accent.js";
import { setOperationOrder, toggleGroupCollapsed, useCanvasState, useCollapsedGroups } from "../canvas/canvas-store.js";
import { sortOperationsByOrder } from "../store.js";
import { applyVisibleReorder, dropIndexFromPoint, dropTargetFromPoint, insertIntoSegment, moveByTargetIndex, reorderWithinSegment, type DropSectionInfo } from "./operations-side-bar-hit-test.js";
import { OperationsSideBarChip, type SideBarEntry } from "./operations-side-bar-chip.js";
import { OperationsSideBarGroupHeader } from "./operations-side-bar-group-header.js";
import { MIN_RAIL_PX, setSideBarCollapsed, setSideBarWidth, tierFromWidth, useSideBarState } from "./operations-side-bar-store.js";

interface OperationsSideBarProps {
  readonly operations: readonly OperationNode[];
  readonly groups: readonly OperationGroup[];
  readonly minimized: readonly string[];
  readonly activeOperationId: string | null;
  readonly operationNotifications: Readonly<Record<string, OperationNotification>>;
  readonly catalog: readonly OperationCatalogPlugin[];
  readonly canLaunch: boolean;
  readonly mapFullscreen: boolean;
  readonly radarEnabled: boolean;
  readonly perimeterEnabled: boolean;
  readonly renderKindIcon: (pluginId: string, kind: OperationLaunchKind) => ReactNode;
  readonly onLaunchKind: (pluginId: string, kind: OperationLaunchKind) => void;
  readonly onResetView: () => void;
  readonly onMaximizeMap: () => void;
  readonly onToggleRadar: () => void;
  readonly onTogglePerimeter: () => void;
  readonly onClose: (operationId: string) => void;
  readonly onFocus: (operationId: string) => void;
  readonly onSetAccent: (operationId: string, accentKey: string | null) => void;
  readonly onRename: (operationId: string, title: string) => void;
  readonly onSetGroupId: (operationId: string, groupId: string | null) => void;
  readonly onCreateGroup: (theaterId: string, name: string, operationId: string) => void;
  readonly onSetGroupColor: (groupId: string, color: string | null) => void;
  readonly onRenameGroup: (groupId: string, name: string) => void;
  readonly onUngroupAll: (groupId: string) => void;
}

type ActiveContextMenu =
  | { readonly kind: "chip"; readonly operationId: string; readonly anchor: DOMRect }
  | { readonly kind: "group"; readonly groupId: string; readonly anchor: DOMRect };

interface NewMenuState {
  readonly anchor: { readonly x: number; readonly y: number };
  readonly viewportBounds?: { readonly width: number; readonly height: number };
}

interface DragState {
  readonly sourceId: string;
  readonly sourceGroupId: string | null;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly currentY: number;
  readonly dragging: boolean;
  readonly dropIndex: number;
  readonly dropGroupId: string | null;
}

const CLOSE_ARM_DURATION_MS = 1500;
const DRAG_THRESHOLD_PX = 6;
const AUTO_SCROLL_EDGE_PX = 34;
const AUTO_SCROLL_STEP_PX = 18;

export function OperationsSideBar({
  operations,
  groups,
  minimized,
  activeOperationId,
  operationNotifications,
  catalog,
  canLaunch,
  mapFullscreen,
  radarEnabled,
  perimeterEnabled,
  renderKindIcon,
  onLaunchKind,
  onResetView,
  onMaximizeMap,
  onToggleRadar,
  onTogglePerimeter,
  onClose,
  onFocus,
  onSetAccent,
  onRename,
  onSetGroupId,
  onCreateGroup,
  onSetGroupColor,
  onRenameGroup,
  onUngroupAll,
}: OperationsSideBarProps) {
  const chipsRef = useRef<HTMLOListElement | null>(null);
  const sideBar = useSideBarState();
  const { width, collapsed } = sideBar;
  const tier = collapsed ? "rail" : tierFromWidth(width);
  const canvas = useCanvasState();
  const closeArmTimeoutRef = useRef<number | null>(null);
  const [armedCloseId, setArmedCloseId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [activeContextMenu, setActiveContextMenu] = useState<ActiveContextMenu | null>(null);
  const [newMenu, setNewMenu] = useState<NewMenuState | null>(null);
  const [settingsMenu, setSettingsMenu] = useState<NewMenuState | null>(null);
  const collapsedGroups = useCollapsedGroups();

  const minimizedSet = new Set(minimized);
  const collapsedGroupSet = new Set(collapsedGroups);
  const allEntries: SideBarEntry[] = sortOperationsByOrder(operations, canvas.operationOrder).map((operation) => {
    const kind = catalog.find((p) => p.id === operation.pluginId)?.kinds.find((k) => k.type === operation.type) ?? null;
    const icon = kind ? renderKindIcon(operation.pluginId, kind) : null;
    return {
      operation,
      active: activeOperationId === operation.id,
      minimized: minimizedSet.has(operation.id),
      notificationCount: operationNotifications[operation.id]?.count ?? 0,
      icon,
    };
  });
  const groupedSections = groupOperations(allEntries, groups, canvas.operationOrder);
  const visibleEntries = groupedSections.flatMap((section) =>
    collapsedGroupSet.has(section.groupId ?? "") ? [] : section.entries,
  );
  const currentOrder = allEntries.map((entry) => entry.operation.id);

  const clearCloseArmTimer = useCallback(() => {
    if (closeArmTimeoutRef.current === null) return;
    window.clearTimeout(closeArmTimeoutRef.current);
    closeArmTimeoutRef.current = null;
  }, []);

  const disarmClose = useCallback(() => {
    clearCloseArmTimer();
    setArmedCloseId(null);
  }, [clearCloseArmTimer]);

  const armClose = useCallback(
    (operationId: string) => {
      clearCloseArmTimer();
      setArmedCloseId(operationId);
      closeArmTimeoutRef.current = window.setTimeout(() => {
        closeArmTimeoutRef.current = null;
        setArmedCloseId(null);
      }, CLOSE_ARM_DURATION_MS);
    },
    [clearCloseArmTimer],
  );

  useEffect(() => clearCloseArmTimer, [clearCloseArmTimer]);

  useEffect(() => {
    if (armedCloseId === null) return;
    if (allEntries.some((entry) => entry.operation.id === armedCloseId)) return;
    disarmClose();
  }, [armedCloseId, allEntries, disarmClose]);

  const contextMenuOperation = activeContextMenu?.kind === "chip"
    ? allEntries.find((entry) => entry.operation.id === activeContextMenu.operationId)?.operation ?? null
    : null;
  const contextMenuGroup = activeContextMenu?.kind === "group"
    ? groups.find((g) => g.id === activeContextMenu.groupId) ?? null
    : null;

  const keyboardMove = (operationId: string, direction: -1 | 1) => {
    const index = visibleEntries.findIndex((e) => e.operation.id === operationId);
    if (index === -1) return;
    const targetIndex = Math.max(0, Math.min(visibleEntries.length - 1, index + direction));
    if (targetIndex === index) return;
    const visibleOrder = visibleEntries.map((e) => e.operation.id);
    const nextVisibleOrder = moveByTargetIndex(visibleOrder, operationId, targetIndex);
    // currentOrder(collapsed 포함 전체)에 visible 재배치를 반영해 hidden op 순서를 보존한다.
    setOperationOrder(applyVisibleReorder(currentOrder, visibleOrder, nextVisibleOrder));
  };

  // entryIds는 collapsed 그룹도 실제 멤버를 담는다. dropTargetFromPoint는 DOM 기반이라 collapsed에서
  // index 0을 early-return하며 entryIds를 쓰지 않고, insertIntoSegment는 멤버 순서가 있어야 드롭 위치를
  // 올바르게 계산한다(빈 배열이면 멤버를 가진 collapsed 그룹에 드롭한 chip이 그룹 끝으로 밀린다).
  const dropSections: DropSectionInfo[] = groupedSections.map((section) => ({
    groupId: section.groupId,
    entryIds: section.entries.map((e) => e.operation.id),
  }));

  const beginPointerDrag = (event: ReactPointerEvent<HTMLLIElement>, operationId: string) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setActiveContextMenu(null);
    disarmClose();
    const sourceEntry = allEntries.find((e) => e.operation.id === operationId);
    const sourceGroupId = sourceEntry?.operation.groupId ?? null;
    setDrag({
      sourceId: operationId,
      sourceGroupId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentY: event.clientY,
      dragging: false,
      dropIndex: currentOrder.indexOf(operationId),
      dropGroupId: sourceGroupId,
    });
  };

  const updatePointerDrag = (event: ReactPointerEvent<HTMLLIElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.dragging && distance < DRAG_THRESHOLD_PX) return;
    const dropTarget = dropTargetFromPoint(event.clientY, dropSections, chipsRef.current, drag.sourceId);
    autoScrollSideBar(event.clientY, chipsRef.current);
    setDrag({ ...drag, currentY: event.clientY, dragging: true, dropIndex: dropTarget.index, dropGroupId: dropTarget.groupId });
  };

  const finishPointerDrag = (event: ReactPointerEvent<HTMLLIElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const { sourceId, sourceGroupId, dragging, dropIndex, dropGroupId } = drag;
    setDrag(null);
    if (!dragging) return;

    if (dropGroupId !== sourceGroupId) {
      // cross-group: groupId 변경 + 대상 그룹 내 dropIndex 위치로 order 재배치를 함께 처리한다.
      const dropSection = dropSections.find((s) => s.groupId === dropGroupId);
      const dropSegmentIds = dropSection?.entryIds ?? [];
      const allIds = allEntries.map((e) => e.operation.id);
      setOperationOrder(insertIntoSegment(allIds, sourceId, dropIndex, dropSegmentIds));
      onSetGroupId(sourceId, dropGroupId);
      return;
    }

    const section = groupedSections.find((s) => s.groupId === sourceGroupId);
    const segmentIds = section ? section.entries.map((e) => e.operation.id) : [];
    const currentLocalIndex = segmentIds.indexOf(sourceId);
    if (currentLocalIndex === -1 || dropIndex === currentLocalIndex) return;
    const allIds = allEntries.map((e) => e.operation.id);
    const nextOrder = reorderWithinSegment(allIds, sourceId, dropIndex, segmentIds);
    setOperationOrder(nextOrder);
  };

  const cancelPointerDrag = (event: ReactPointerEvent<HTMLLIElement>) => {
    if (drag && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
  };

  const handleResizeDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sideBar.width;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      setSideBarWidth(startWidth + dx);
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [sideBar.width]);

  const handleResizeDoubleClick = () => {
    setSideBarCollapsed(!collapsed);
    if (!collapsed) setSideBarWidth(MIN_RAIL_PX);
  };

  const openNewMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (newMenu) {
      setNewMenu(null);
      return;
    }
    setSettingsMenu(null);
    const rect = event.currentTarget.getBoundingClientRect();
    setNewMenu({
      anchor: { x: rect.right + 8, y: rect.top },
      viewportBounds: { width: window.innerWidth, height: window.innerHeight },
    });
  };

  const openSettingsMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (settingsMenu) {
      setSettingsMenu(null);
      return;
    }
    setNewMenu(null);
    const rect = event.currentTarget.getBoundingClientRect();
    setSettingsMenu({
      anchor: { x: rect.right + 8, y: rect.top },
      viewportBounds: { width: window.innerWidth, height: window.innerHeight },
    });
  };

  const displayWidth = collapsed ? MIN_RAIL_PX : width;

  if (allEntries.length === 0 && tier === "rail") {
    return (
      <aside
        className="operations-side-bar"
        data-tier={tier}
        data-canvas-blocker
        style={{ "--side-bar-width": `${displayWidth}px` } as CSSProperties}
      >
        <header className="operations-side-bar-header">
          <button
            type="button"
            className="side-bar-new-btn"
            onClick={openNewMenu}
            aria-label="New Operation"
            title="New Operation"
          >
            <NewIcon />
          </button>
        </header>
        <div className="operations-side-bar-resize-handle" onPointerDown={handleResizeDragStart} onDoubleClick={handleResizeDoubleClick} aria-hidden="true" />
        {newMenu ? createPortal(
          <CanvasContextMenu
            key={`${newMenu.anchor.x}:${newMenu.anchor.y}`}
            anchor={newMenu.anchor}
            viewportBounds={newMenu.viewportBounds}
            placement="cursor"
            mode="launch"
            catalog={catalog}
            canLaunch={canLaunch}
            renderKindIcon={renderKindIcon}
            onLaunchKind={(pluginId, kind) => { setNewMenu(null); onLaunchKind(pluginId, kind); }}
            onResetView={onResetView}
            onClose={() => setNewMenu(null)}
          />,
          document.body,
        ) : null}
      </aside>
    );
  }

  return (
    <aside
      className="operations-side-bar"
      data-tier={tier}
      data-canvas-blocker
      style={{ "--side-bar-width": `${displayWidth}px` } as CSSProperties}
    >
      <header className="operations-side-bar-header">
        <button
          type="button"
          className="side-bar-new-btn"
          onClick={openNewMenu}
          aria-label="New Operation"
          aria-expanded={newMenu !== null}
          title="New Operation"
        >
          <NewIcon />
          {tier !== "rail" ? <span>Operation</span> : null}
        </button>
        {tier !== "rail" ? (
          <button
            type="button"
            className="side-bar-settings-btn"
            onClick={openSettingsMenu}
            aria-expanded={settingsMenu !== null}
            aria-label="Map and display controls"
            title="Map and display controls"
          >
            <SettingsIcon />
          </button>
        ) : null}
      </header>

      <ol className="operations-side-bar-chips" ref={chipsRef} aria-label="Operations">
        {groupedSections.map((section) => {
          const isCollapsed = section.groupId !== null && collapsedGroupSet.has(section.groupId);
          return (
            <li key={section.groupId ?? "__ungrouped__"} data-drop-zone-group-id={section.groupId ?? "__ungrouped__"} className={section.groupId ? "side-bar-group-section" : "side-bar-ungrouped-section"}>
              {section.group ? (
                <OperationsSideBarGroupHeader
                  group={section.group}
                  count={section.entries.length}
                  collapsed={isCollapsed}
                  tier={tier}
                  onToggle={toggleGroupCollapsed}
                  onContextMenu={(groupId, anchor) => setActiveContextMenu({ kind: "group", groupId, anchor })}
                />
              ) : section.entries.length > 0 ? (
                <div className="side-bar-ungrouped-label" aria-label="Ungrouped operations">
                  {tier !== "rail" ? <span>Ungrouped</span> : null}
                </div>
              ) : null}
              {!isCollapsed ? (
                <ol
                  className={[
                    "side-bar-group-chips",
                    drag?.dragging && drag.dropGroupId === section.groupId && drag.dropGroupId !== drag.sourceGroupId
                      ? "side-bar-section--drop-target"
                      : "",
                  ].filter(Boolean).join(" ")}
                  data-group-section-id={section.groupId ?? "__ungrouped__"}
                  aria-label={section.group ? section.group.name : "Ungrouped"}
                >
                  {section.entries.map((entry) => {
                    const globalIndex = allEntries.indexOf(entry);
                    const sectionLocalIndex = section.entries.indexOf(entry);
                    const accentKey = canvas.operationAccent[entry.operation.id] ?? operationAccentFromNode(entry.operation);
                    const accentValue = accentKey ? resolveAccentColor(accentKey) : null;
                    const grpColor = section.group ? resolveAccentColor(section.group.color) : null;
                    return (
                      <OperationsSideBarChip
                        key={entry.operation.id}
                        entry={entry}
                        index={globalIndex}
                        isCloseArmed={armedCloseId === entry.operation.id}
                        accentValue={accentValue}
                        grpColor={grpColor}
                        dragging={drag?.sourceId === entry.operation.id && drag.dragging}
                        dragOffsetY={drag?.sourceId === entry.operation.id && drag.dragging ? drag.currentY - drag.startY : 0}
                        dropTarget={
                          drag?.dragging === true
                          && drag.dropGroupId === section.groupId
                          && drag.dropGroupId === drag.sourceGroupId
                          && drag.dropIndex === sectionLocalIndex
                          && drag.sourceId !== entry.operation.id
                        }
                        onArmClose={armClose}
                        onDisarmClose={disarmClose}
                        onClose={onClose}
                        onFocus={onFocus}
                        onKeyboardMove={keyboardMove}
                        onPointerDragStart={beginPointerDrag}
                        onPointerDragMove={updatePointerDrag}
                        onPointerDragEnd={finishPointerDrag}
                        onPointerDragCancel={cancelPointerDrag}
                        onOpenAccent={(operationId, anchor) => setActiveContextMenu({ kind: "chip", operationId, anchor })}
                        onRename={onRename}
                      />
                    );
                  })}
                </ol>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div
        className="operations-side-bar-resize-handle"
        onPointerDown={handleResizeDragStart}
        onDoubleClick={handleResizeDoubleClick}
        aria-hidden="true"
      />

      {newMenu ? createPortal(
        <CanvasContextMenu
          key={`${newMenu.anchor.x}:${newMenu.anchor.y}`}
          anchor={newMenu.anchor}
          viewportBounds={newMenu.viewportBounds}
          placement="cursor"
          mode="launch"
          catalog={catalog}
          canLaunch={canLaunch}
          renderKindIcon={renderKindIcon}
          onLaunchKind={(pluginId, kind) => { setNewMenu(null); onLaunchKind(pluginId, kind); }}
          onResetView={onResetView}
          onClose={() => setNewMenu(null)}
        />,
        document.body,
      ) : null}

      {settingsMenu ? createPortal(
        <CanvasContextMenu
          key={`settings:${settingsMenu.anchor.x}:${settingsMenu.anchor.y}`}
          anchor={settingsMenu.anchor}
          viewportBounds={settingsMenu.viewportBounds}
          placement="cursor"
          mode="controls"
          catalog={catalog}
          canLaunch={canLaunch}
          mapFullscreen={mapFullscreen}
          radarEnabled={radarEnabled}
          perimeterEnabled={perimeterEnabled}
          renderKindIcon={renderKindIcon}
          onLaunchKind={onLaunchKind}
          onResetView={() => { setSettingsMenu(null); onResetView(); }}
          onMaximizeMap={onMaximizeMap}
          onToggleRadar={onToggleRadar}
          onTogglePerimeter={onTogglePerimeter}
          onClose={() => setSettingsMenu(null)}
        />,
        document.body,
      ) : null}

      {activeContextMenu?.kind === "chip" && contextMenuOperation ? (
        <GroupContextMenu
          kind="chip"
          operation={contextMenuOperation}
          groups={groups}
          accentKey={canvas.operationAccent[contextMenuOperation.id] ?? operationAccentFromNode(contextMenuOperation)}
          anchor={activeContextMenu.anchor}
          actions={{
            onSetAccent: (key) => onSetAccent(contextMenuOperation.id, key),
            onSetGroupId: (groupId) => onSetGroupId(contextMenuOperation.id, groupId),
            onCreateGroup: (name) => onCreateGroup(contextMenuOperation.theaterId, name, contextMenuOperation.id),
          }}
          onClose={() => setActiveContextMenu(null)}
        />
      ) : activeContextMenu?.kind === "group" && contextMenuGroup ? (
        <GroupContextMenu
          kind="group-header"
          group={contextMenuGroup}
          anchor={activeContextMenu.anchor}
          actions={{
            onSetColor: (color) => onSetGroupColor(contextMenuGroup.id, color),
            onRename: (name) => onRenameGroup(contextMenuGroup.id, name),
            onUngroupAll: () => onUngroupAll(contextMenuGroup.id),
          }}
          onClose={() => setActiveContextMenu(null)}
        />
      ) : null}
    </aside>
  );
}

interface GroupSection {
  readonly groupId: string | null;
  readonly group: OperationGroup | null;
  readonly entries: SideBarEntry[];
}

export function groupOperations(
  entries: readonly SideBarEntry[],
  groups: readonly OperationGroup[],
  operationOrder: readonly string[],
): GroupSection[] {
  const sortedGroups = [...groups].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  const sections: GroupSection[] = sortedGroups.map((group) => ({
    groupId: group.id,
    group,
    entries: [],
  }));
  const ungrouped: GroupSection = { groupId: null, group: null, entries: [] };
  const groupById = new Map(sortedGroups.map((g) => [g.id, g]));

  for (const entry of entries) {
    const gid = entry.operation.groupId ?? null;
    if (gid !== null && groupById.has(gid)) {
      const section = sections.find((s) => s.groupId === gid);
      section?.entries.push(entry);
    } else {
      ungrouped.entries.push(entry);
    }
  }

  void operationOrder;
  return [...sections, ungrouped];
}


function autoScrollSideBar(clientY: number, chipsElement: HTMLOListElement | null): void {
  if (!chipsElement) return;
  const rect = chipsElement.getBoundingClientRect();
  if (clientY < rect.top + AUTO_SCROLL_EDGE_PX) {
    chipsElement.scrollTop -= AUTO_SCROLL_STEP_PX;
  } else if (clientY > rect.bottom - AUTO_SCROLL_EDGE_PX) {
    chipsElement.scrollTop += AUTO_SCROLL_STEP_PX;
  }
}

function NewIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M12 2.4v3.4M12 18.2v3.4M2.4 12h3.4M18.2 12h3.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M12 9.2v5.6M9.2 12h5.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M8 1.4v1.4M8 13.2v1.4M1.4 8h1.4M13.2 8h1.4M3.3 3.3l1 1M11.7 11.7l1 1M11.7 3.3l-1 1M3.3 11.7l-1 1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}
