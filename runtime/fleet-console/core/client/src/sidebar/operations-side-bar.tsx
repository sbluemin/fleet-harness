import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { OperationActivity } from "@fleet-console/sdk/plugin";

import type { OperationGroup, OperationNode, OperationNotification, TheaterInfo } from "../types.js";
import { CanvasContextMenu } from "../canvas/canvas-context-menu.js";
import { focusCommandBandToggleWhenPanelContainsActiveElement } from "../components/command-band-focus.js";
import { DirectoryBrowserModal } from "../components/directory-browser-modal.js";
import { useConsoleState } from "../hooks/use-store.js";
import { GroupContextMenu } from "../canvas/group-context-menu.js";
import { operationAccentFromNode, resolveAccentColor } from "../canvas/operation-accent.js";
import { setOperationOrder, toggleFormationView, toggleGroupCollapsed, useCanvasState, useCollapsedGroups, useFormationView } from "../canvas/canvas-store.js";
import { sortOperationsByOrder } from "../store.js";
import { SideBarBrandFoot } from "../components/side-bar-brand-foot.js";
import { applyVisibleReorder, groupDropIndexFromPoint, dropTargetFromPoint, insertIntoSegment, moveByTargetIndex, reorderGroupIds, reorderWithinSegment, type DropSectionInfo } from "./operations-side-bar-hit-test.js";
import { OperationsSideBarChip, type SideBarEntry } from "./operations-side-bar-chip.js";
import { OperationsSideBarGroupHeader } from "./operations-side-bar-group-header.js";
import { setSideBarCollapsed, setSideBarWidth, setTheaterCollapsed, useCollapsedTheaters, useSideBarState } from "./operations-side-bar-store.js";
import { resolveOperationLaunchKind } from "./resolve-launch-kind.js";

interface OperationsSideBarProps {
  readonly theaters: readonly TheaterInfo[];
  readonly activeTheaterId: string | null;
  readonly operations: readonly OperationNode[];
  readonly groups: readonly OperationGroup[];
  readonly minimized: readonly string[];
  readonly activeOperationId: string | null;
  readonly operationNotifications: Readonly<Record<string, OperationNotification>>;
  readonly catalog: readonly OperationCatalogPlugin[];
  readonly canLaunch: boolean;
  readonly addingTheater: boolean;
  readonly theaterError: string | null;
  readonly renderKindIcon: (pluginId: string, kind: OperationLaunchKind) => ReactNode;
  readonly onLaunchKind: (pluginId: string, kind: OperationLaunchKind) => void;
  readonly onResetView: () => void;
  readonly onClose: (operationId: string) => void;
  readonly onFocus: (operationId: string) => void;
  readonly onSetAccent: (operationId: string, accentKey: string | null) => void;
  readonly onRename: (operationId: string, title: string) => void;
  readonly onSetGroupId: (operationId: string, groupId: string | null) => void;
  readonly onCreateGroup: (theaterId: string, name: string, operationId?: string) => void;
  readonly onSetGroupColor: (groupId: string, color: string | null) => void;
  readonly onRenameGroup: (groupId: string, name: string) => void;
  readonly onReorderGroups: (orderedGroupIds: readonly string[]) => void;
  readonly onUngroupAll: (groupId: string) => void;
  readonly onSelectTheater: (theaterId: string) => void;
  readonly onAddTheater: (path: string) => void;
  readonly onCancelAddTheater: () => void;
  readonly onForgetTheater: (theaterId: string) => void;
}

type ActiveContextMenu =
  | { readonly kind: "chip"; readonly operationId: string; readonly anchor: DOMRect }
  | { readonly kind: "group"; readonly groupId: string; readonly anchor: DOMRect }
  | { readonly kind: "theater"; readonly theaterId: string; readonly anchor: DOMRect; readonly returnFocus?: HTMLButtonElement | null };

interface NewMenuState {
  readonly anchor: { readonly x: number; readonly y: number };
  readonly viewportBounds?: { readonly width: number; readonly height: number };
}

interface ChipDragState {
  readonly kind: "chip";
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

interface GroupDragState {
  readonly kind: "group";
  readonly sourceGroupId: string;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly currentY: number;
  readonly dragging: boolean;
  readonly dropIndex: number;
}

type DragState = ChipDragState | GroupDragState;

interface TheaterEntryBuildInput {
  readonly theaterId: string;
  readonly operations: readonly OperationNode[];
  readonly operationOrder: readonly string[];
  readonly minimizedSet: ReadonlySet<string>;
  readonly activeOperationId: string | null;
  readonly operationNotifications: Readonly<Record<string, OperationNotification>>;
  readonly operationStatus: Readonly<Record<string, OperationActivity>>;
  readonly catalog: readonly OperationCatalogPlugin[];
  readonly renderKindIcon: (pluginId: string, kind: OperationLaunchKind) => ReactNode;
}

interface TheaterSectionHeaderProps {
  readonly theater: TheaterInfo;
  readonly operationCount: number;
  readonly active: boolean;
  readonly collapsed: boolean;
  readonly onSelectTheater: (theaterId: string) => void;
  readonly onToggleCollapsed: (theaterId: string) => void;
  readonly onOpenActions: (anchor: DOMRect, returnFocus?: HTMLButtonElement | null) => void;
  readonly onOpenLaunch: (event: MouseEvent<HTMLButtonElement>, theaterId: string) => void;
  readonly onContextMenu: (anchor: DOMRect) => void;
}

interface TheaterPeekSectionProps {
  readonly theater: TheaterInfo;
  readonly entries: readonly SideBarEntry[];
  readonly groups: readonly OperationGroup[];
  readonly operationCount: number;
  readonly collapsed: boolean;
  readonly onSelectTheater: (theaterId: string) => void;
  readonly onFocus: (operationId: string) => void;
  readonly onToggleCollapsed: (theaterId: string) => void;
  readonly onOpenActions: (anchor: DOMRect, returnFocus?: HTMLButtonElement | null) => void;
  readonly onOpenLaunch: (event: MouseEvent<HTMLButtonElement>, theaterId: string) => void;
  readonly onContextMenu: (anchor: DOMRect) => void;
}

interface TheaterActionsMenuProps {
  readonly theater: TheaterInfo;
  readonly groupCount: number;
  readonly anchor: DOMRect;
  readonly onCreateGroup: (name: string) => void;
  readonly onForgetTheater: () => void;
  readonly onClose: () => void;
}

const CLOSE_ARM_DURATION_MS = 1500;
const DRAG_THRESHOLD_PX = 6;
const AUTO_SCROLL_EDGE_PX = 34;
const AUTO_SCROLL_STEP_PX = 18;
const PEEK_CHIP_LIMIT = 4;

export function OperationsSideBar({
  theaters,
  activeTheaterId,
  operations,
  groups,
  minimized,
  activeOperationId,
  operationNotifications,
  catalog,
  canLaunch,
  addingTheater,
  theaterError,
  renderKindIcon,
  onLaunchKind,
  onResetView,
  onClose,
  onFocus,
  onSetAccent,
  onRename,
  onSetGroupId,
  onCreateGroup,
  onSetGroupColor,
  onRenameGroup,
  onReorderGroups,
  onUngroupAll,
  onSelectTheater,
  onAddTheater,
  onCancelAddTheater,
  onForgetTheater,
}: OperationsSideBarProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const chipsRef = useRef<HTMLOListElement | null>(null);
  const sideBar = useSideBarState();
  const { width, collapsed } = sideBar;
  const previousCollapsedRef = useRef(collapsed);
  const canvas = useCanvasState();
  const formationView = useFormationView();
  const closeArmTimeoutRef = useRef<number | null>(null);
  const [armedCloseId, setArmedCloseId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const entriesRef = useRef<SideBarEntry[]>([]);
  const currentOrderRef = useRef<string[]>([]);
  const dropSectionsRef = useRef<DropSectionInfo[]>([]);
  const orderedGroupIdsRef = useRef<string[]>([]);
  const onSetGroupIdRef = useRef(onSetGroupId);
  const onReorderGroupsRef = useRef(onReorderGroups);
  const [activeContextMenu, setActiveContextMenu] = useState<ActiveContextMenu | null>(null);
  const [newMenu, setNewMenu] = useState<NewMenuState | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [sideBarResizing, setSideBarResizing] = useState(false);
  const collapsedGroups = useCollapsedGroups();
  const collapsedTheaters = useCollapsedTheaters();
  const { operationStatus } = useConsoleState();

  useLayoutEffect(() => {
    if (!previousCollapsedRef.current && collapsed) focusCommandBandToggleWhenPanelContainsActiveElement(rootRef.current, ".command-band-sidebar-toggle");
    previousCollapsedRef.current = collapsed;
  }, [collapsed]);

  const activeOperations = operations.filter((operation) => operation.theaterId === activeTheaterId);
  const activeGroups = groups.filter((group) => group.theaterId === activeTheaterId);
  const minimizedSet = new Set(minimized);
  const collapsedGroupSet = new Set(collapsedGroups);
  const allEntries: SideBarEntry[] = sortOperationsByOrder(activeOperations, canvas.operationOrder).map((operation) => {
    const kind = resolveOperationLaunchKind(catalog, operation);
    const icon = kind ? renderKindIcon(operation.pluginId, kind) : null;
    return {
      operation,
      active: activeOperationId === operation.id,
      minimized: minimizedSet.has(operation.id),
      notificationCount: operationNotifications[operation.id] ? 1 : 0,
      status: operationStatus[operation.id],
      icon,
    };
  });
  const groupedSections = groupOperations(allEntries, activeGroups, canvas.operationOrder);
  const hasCustomGroups = groupedSections.some((section) => section.group !== null);
  const orderedGroupIds = groupedSections.flatMap((section) => section.groupId ? [section.groupId] : []);
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
  const contextMenuTheater = activeContextMenu?.kind === "theater"
    ? theaters.find((theater) => theater.id === activeContextMenu.theaterId) ?? null
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

  // window 이벤트 핸들러에서 commit 시점 최신값을 읽기 위해 매 렌더 ref를 동기화한다.
  useEffect(() => {
    entriesRef.current = allEntries;
    currentOrderRef.current = currentOrder;
    dropSectionsRef.current = dropSections;
    orderedGroupIdsRef.current = orderedGroupIds;
    onSetGroupIdRef.current = onSetGroupId;
    onReorderGroupsRef.current = onReorderGroups;
  });

  const updateDrag = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  // drag 시작(pointerId가 생김)에만 window 리스너 3개를 등록하고, drag 종료 시 정확히 3개 해제한다.
  const dragPointerId = drag?.pointerId ?? null;
  useEffect(() => {
    if (dragPointerId === null) return;

    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== dragPointerId) return;
      const current = dragRef.current;
      if (!current) return;
      if (event.buttons === 0) {
        updateDrag(null);
        return;
      }
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
      if (!current.dragging && distance < DRAG_THRESHOLD_PX) return;
      if (current.dragging) event.preventDefault();
      autoScrollSideBar(event.clientY, chipsRef.current);
      if (current.kind === "chip") {
        const dropTarget = dropTargetFromPoint(event.clientY, dropSectionsRef.current, chipsRef.current, current.sourceId);
        updateDrag({ ...current, currentY: event.clientY, dragging: true, dropIndex: dropTarget.index, dropGroupId: dropTarget.groupId });
        return;
      }
      const dropIndex = groupDropIndexFromPoint(event.clientY, orderedGroupIdsRef.current, chipsRef.current, current.sourceGroupId);
      updateDrag({ ...current, currentY: event.clientY, dragging: true, dropIndex });
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== dragPointerId) return;
      const snap = dragRef.current;
      updateDrag(null);
      if (!snap?.dragging) return;

      if (snap.kind === "group") {
        const nextGroupIds = reorderGroupIds(orderedGroupIdsRef.current, snap.sourceGroupId, snap.dropIndex);
        if (nextGroupIds.join("\0") === orderedGroupIdsRef.current.join("\0")) return;
        onReorderGroupsRef.current(nextGroupIds);
        return;
      }

      const { sourceId, sourceGroupId, dropIndex, dropGroupId } = snap;
      const sections = dropSectionsRef.current;
      const allIds = currentOrderRef.current;

      if (dropGroupId !== sourceGroupId) {
        const dropSection = sections.find((s) => s.groupId === dropGroupId);
        const dropSegmentIds = dropSection?.entryIds ?? [];
        setOperationOrder(insertIntoSegment(allIds, sourceId, dropIndex, dropSegmentIds));
        onSetGroupIdRef.current(sourceId, dropGroupId);
        return;
      }

      const sourceSection = sections.find((s) => s.groupId === sourceGroupId);
      const segmentIds = sourceSection?.entryIds ?? [];
      const currentLocalIndex = segmentIds.indexOf(sourceId);
      if (currentLocalIndex === -1 || dropIndex === currentLocalIndex) return;
      const nextOrder = reorderWithinSegment(allIds, sourceId, dropIndex, segmentIds);
      setOperationOrder(nextOrder);
    };

    const onCancel = (event: PointerEvent) => {
      if (event.pointerId !== dragPointerId) return;
      updateDrag(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [dragPointerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const beginPointerDrag = (event: ReactPointerEvent<HTMLLIElement>, operationId: string) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    setActiveContextMenu(null);
    disarmClose();
    const sourceEntry = allEntries.find((e) => e.operation.id === operationId);
    const sourceGroupId = sourceEntry?.operation.groupId ?? null;
    updateDrag({
      kind: "chip",
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

  const beginGroupPointerDrag = (event: ReactPointerEvent<HTMLDivElement>, groupId: string) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    if (!orderedGroupIds.includes(groupId)) return;
    setActiveContextMenu(null);
    disarmClose();
    updateDrag({
      kind: "group",
      sourceGroupId: groupId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentY: event.clientY,
      dragging: false,
      dropIndex: orderedGroupIds.indexOf(groupId),
    });
  };

  const handleResizeDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sideBar.width;
    setSideBarResizing(true);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      setSideBarWidth(startWidth + dx);
    };

    const onEnd = () => {
      setSideBarResizing(false);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("pointercancel", onEnd);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
  }, [sideBar.width]);

  const handleResizeDoubleClick = () => {
    setSideBarCollapsed(!collapsed);
  };

  const openTheaterBrowser = () => {
    setNewMenu(null);
    setActiveContextMenu(null);
    setBrowserOpen(true);
  };

  const cancelTheaterBrowser = () => {
    setBrowserOpen(false);
    onCancelAddTheater();
  };

  const confirmTheaterBrowser = (path: string) => {
    setBrowserOpen(false);
    onAddTheater(path);
  };

  // 사이드바 빈 영역 우클릭 = ＋New 버튼과 동일한 launch 오버레이를 커서 위치에 연다.
  // chip/그룹 헤더는 자체 우클릭 핸들러가 preventDefault()를 호출하므로(버블로 도달 시
  // defaultPrevented=true), 그쪽 우클릭은 accent/그룹 메뉴를 유지하고 여기서는 무시한다.
  const openNewMenuAtCursor = (event: React.MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    setActiveContextMenu(null);
    setNewMenu({
      anchor: { x: event.clientX, y: event.clientY },
      viewportBounds: { width: window.innerWidth, height: window.innerHeight },
    });
  };

  const closeActiveContextMenu = useCallback(() => {
    const returnFocus = activeContextMenu?.kind === "theater" ? activeContextMenu.returnFocus : null;
    setActiveContextMenu(null);
    returnFocus?.focus();
  }, [activeContextMenu]);

  const openTheaterLaunchMenu = (event: MouseEvent<HTMLButtonElement>, theaterId: string) => {
    event.stopPropagation();
    if (theaterId !== activeTheaterId) onSelectTheater(theaterId);
    setActiveContextMenu(null);
    const rect = event.currentTarget.getBoundingClientRect();
    setNewMenu({
      anchor: { x: rect.right + 8, y: rect.top },
      viewportBounds: { width: window.innerWidth, height: window.innerHeight },
    });
  };

  const toggleTheaterSectionCollapsed = (theaterId: string) => {
    setTheaterCollapsed(theaterId, !collapsedTheaters.includes(theaterId));
  };

  return (
    <aside
      className={`operations-side-bar ${collapsed ? "is-closed" : "is-expanded"}`}
      ref={rootRef}
      data-sidebar-state={collapsed ? "closed" : "expanded"}
      data-resizing={sideBarResizing ? "true" : undefined}
      data-canvas-blocker
      style={{ "--side-bar-width": `${width}px` } as CSSProperties}
      inert={collapsed}
      onContextMenu={openNewMenuAtCursor}
    >
      <div className="side-bar-theater-add-row">
        <button type="button" className="side-bar-theater-add-btn" onClick={openTheaterBrowser} disabled={addingTheater} aria-label="Add Theater" title={addingTheater ? "Adding Theater" : "Add Theater"}><PlusIcon /><span>Add Theater</span></button>
        <button type="button" className="side-bar-formation-toggle" onClick={toggleFormationView} disabled={activeTheaterId === null} aria-pressed={formationView} aria-label="Formation view" title="Formation view (Alt+F)"><FormationIcon /></button>
      </div>
      {!collapsed && theaterError ? <p className="side-bar-theater-error">{theaterError}</p> : null}

      <ol className="operations-side-bar-chips" ref={chipsRef} aria-label="Operations">
        {theaters.map((theater) => {
          const isActiveTheater = theater.id === activeTheaterId;
          const theaterOperationCount = operations.filter((operation) => operation.theaterId === theater.id).length;
          const theaterCollapsed = collapsedTheaters.includes(theater.id);
          if (!isActiveTheater) {
            const peekEntries = buildTheaterEntries({
              theaterId: theater.id,
              operations,
              operationOrder: canvas.operationOrder,
              minimizedSet,
              // 비활성 Theater의 칩은 캔버스에 없으므로 활성(brass/aria-current) 표시 대상이 아니다(Codex P3).
              activeOperationId: null,
              operationNotifications,
              operationStatus,
              catalog,
              renderKindIcon,
            });
            return (
              <TheaterPeekSection
                key={theater.id}
                theater={theater}
                entries={theaterCollapsed ? [] : peekEntries}
                groups={groups.filter((group) => group.theaterId === theater.id)}
                operationCount={theaterOperationCount}
                collapsed={theaterCollapsed}
                onSelectTheater={onSelectTheater}
                onFocus={onFocus}
                onToggleCollapsed={toggleTheaterSectionCollapsed}
                onOpenActions={(anchor, returnFocus) => {
                  setNewMenu(null);
                  setActiveContextMenu({ kind: "theater", theaterId: theater.id, anchor, returnFocus });
                }}
                onOpenLaunch={openTheaterLaunchMenu}
                onContextMenu={(anchor) => {
                  setNewMenu(null);
                  setActiveContextMenu({ kind: "theater", theaterId: theater.id, anchor });
                }}
              />
            );
          }
          return (
            <li
              key={theater.id}
              className="side-bar-theater-section side-bar-theater-section--active"
              data-theater-id={theater.id}
            >
              <TheaterSectionHeader
                theater={theater}
                operationCount={theaterOperationCount}
                active
                collapsed={theaterCollapsed}
                onSelectTheater={onSelectTheater}
                onToggleCollapsed={toggleTheaterSectionCollapsed}
                onOpenActions={(anchor, returnFocus) => {
                  setNewMenu(null);
                  setActiveContextMenu({ kind: "theater", theaterId: theater.id, anchor, returnFocus });
                }}
                onOpenLaunch={openTheaterLaunchMenu}
                onContextMenu={(anchor) => {
                  setNewMenu(null);
                  setActiveContextMenu({ kind: "theater", theaterId: theater.id, anchor });
                }}
              />
              {!theaterCollapsed ? (
              <ol className="side-bar-theater-groups" aria-label={`${theater.label} operations`}>
                {groupedSections.map((section) => {
          const isCollapsed = section.groupId !== null && collapsedGroupSet.has(section.groupId);
          const grpColor = section.group ? resolveAccentColor(section.group.color) : null;
          const sectionStyle = grpColor ? ({ "--grp-color": grpColor } as CSSProperties) : undefined;
          const groupIndex = section.groupId ? orderedGroupIds.indexOf(section.groupId) : -1;
          const isGroupDragging = drag?.kind === "group" && drag.sourceGroupId === section.groupId && drag.dragging;
          const groupDropBefore = drag?.kind === "group"
            && drag.dragging
            && section.groupId !== null
            && drag.sourceGroupId !== section.groupId
            && drag.dropIndex === groupIndex;
          const groupDropAfter = drag?.kind === "group"
            && drag.dragging
            && section.groupId !== null
            && drag.sourceGroupId !== section.groupId
            && groupIndex === orderedGroupIds.length - 1
            && drag.dropIndex === orderedGroupIds.length;
          const sectionClassName = [
            section.groupId ? "side-bar-group-section" : "side-bar-ungrouped-section",
            groupDropBefore ? "side-bar-group-section--drop-before" : "",
            groupDropAfter ? "side-bar-group-section--drop-after" : "",
          ].filter(Boolean).join(" ");
          return (
            <li key={section.groupId ?? "__ungrouped__"} data-drop-zone-group-id={section.groupId ?? "__ungrouped__"} className={sectionClassName} style={sectionStyle}>
              {section.group ? (
                <OperationsSideBarGroupHeader
                  group={section.group}
                  count={section.entries.length}
                  collapsed={isCollapsed}
                  dragging={isGroupDragging}
                  dragOffsetY={isGroupDragging ? drag.currentY - drag.startY : 0}
                  dropTarget={groupDropBefore}
                  onToggle={toggleGroupCollapsed}
                  onContextMenu={(groupId, anchor) => setActiveContextMenu({ kind: "group", groupId, anchor })}
                  onPointerDragStart={beginGroupPointerDrag}
                />
              ) : hasCustomGroups && section.entries.length > 0 ? (
                <div className="side-bar-ungrouped-label" aria-label="Ungrouped operations">
                  <span>Ungrouped</span>
                </div>
              ) : null}
              {!isCollapsed ? (
                <ol
                  className={[
                    "side-bar-group-chips",
                    drag?.kind === "chip" && drag.dragging && drag.dropGroupId === section.groupId && drag.dropGroupId !== drag.sourceGroupId
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
                    return (
                      <OperationsSideBarChip
                        key={entry.operation.id}
                        entry={entry}
                        index={globalIndex}
                        isCloseArmed={armedCloseId === entry.operation.id}
                        accentValue={accentValue}
                        dragging={drag?.kind === "chip" && drag.sourceId === entry.operation.id && drag.dragging}
                        dragOffsetY={drag?.kind === "chip" && drag.sourceId === entry.operation.id && drag.dragging ? drag.currentY - drag.startY : 0}
                        dropTarget={
                          drag?.kind === "chip"
                          && drag.dragging === true
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

      {activeContextMenu?.kind === "chip" && contextMenuOperation ? (
        <GroupContextMenu
          kind="chip"
          operation={contextMenuOperation}
          groups={groups.filter((group) => group.theaterId === contextMenuOperation.theaterId)}
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
      ) : activeContextMenu?.kind === "theater" && contextMenuTheater ? (
        <TheaterActionsMenu
          theater={contextMenuTheater}
          groupCount={groups.filter((group) => group.theaterId === contextMenuTheater.id).length}
          anchor={activeContextMenu.anchor}
          onCreateGroup={(name) => {
            onCreateGroup(contextMenuTheater.id, name);
            closeActiveContextMenu();
          }}
          onForgetTheater={() => {
            onForgetTheater(contextMenuTheater.id);
            closeActiveContextMenu();
          }}
          onClose={closeActiveContextMenu}
        />
      ) : null}
      <DirectoryBrowserModal open={browserOpen} onCancel={cancelTheaterBrowser} onConfirm={confirmTheaterBrowser} />
      {!collapsed ? <SideBarBrandFoot /> : null}
    </aside>
  );
}

function FormationIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
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

function buildTheaterEntries({
  theaterId,
  operations,
  operationOrder,
  minimizedSet,
  activeOperationId,
  operationNotifications,
  operationStatus,
  catalog,
  renderKindIcon,
}: TheaterEntryBuildInput): SideBarEntry[] {
  return sortOperationsByOrder(
    operations.filter((operation) => operation.theaterId === theaterId),
    operationOrder,
  ).map((operation) => {
    const kind = resolveOperationLaunchKind(catalog, operation);
    const icon = kind ? renderKindIcon(operation.pluginId, kind) : null;
    return {
      operation,
      active: activeOperationId === operation.id,
      minimized: minimizedSet.has(operation.id),
      notificationCount: operationNotifications[operation.id] ? 1 : 0,
      status: operationStatus[operation.id],
      icon,
    };
  });
}

function TheaterSectionHeader({
  theater,
  operationCount,
  active,
  collapsed,
  onSelectTheater,
  onToggleCollapsed,
  onOpenActions,
  onOpenLaunch,
  onContextMenu,
}: TheaterSectionHeaderProps) {
  const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    onContextMenu(event.currentTarget.getBoundingClientRect());
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // 중첩 행 컨트롤(∨/⋯/＋)에서 버블된 Enter/Space를 가로채면 버튼 키보드 활성화가 죽는다(Codex P2).
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelectTheater(theater.id);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className={`side-bar-theater-header${active ? " is-active" : ""}`}
      onClick={() => onSelectTheater(theater.id)}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      aria-current={active ? "true" : undefined}
      aria-expanded={!collapsed}
      title={theater.label}
    >
      <span className="side-bar-theater-anchor" aria-hidden="true">{theaterInitials(theater.label)}</span>
      <span className="side-bar-theater-name">{theater.label}</span>
      <span className="side-bar-theater-count">{operationCount}</span>
      <span className="side-bar-theater-row-controls" aria-label={`${theater.label} controls`}>
          <button
            type="button"
            className="side-bar-theater-row-btn side-bar-theater-collapse-btn"
            aria-label={collapsed ? `Expand ${theater.label}` : `Collapse ${theater.label}`}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand" : "Collapse"}
            onClick={(event) => {
              event.stopPropagation();
              onToggleCollapsed(theater.id);
            }}
          >
            <ChevronIcon collapsed={collapsed} />
          </button>
          <button
            type="button"
            className="side-bar-theater-row-btn"
            aria-label="Theater actions"
            title="Theater actions"
            onClick={(event) => {
              event.stopPropagation();
              onOpenActions(event.currentTarget.getBoundingClientRect(), event.currentTarget);
            }}
          >
            <MoreIcon />
          </button>
          <button
            type="button"
            className="side-bar-theater-row-btn"
            aria-label={`New Operation in ${theater.label}`}
            title={`New Operation in ${theater.label}`}
            onClick={(event) => onOpenLaunch(event, theater.id)}
          >
            <PlusIcon />
          </button>
      </span>
    </div>
  );
}

function TheaterPeekSection({
  theater,
  entries,
  groups,
  operationCount,
  collapsed,
  onSelectTheater,
  onFocus,
  onToggleCollapsed,
  onOpenActions,
  onOpenLaunch,
  onContextMenu,
}: TheaterPeekSectionProps) {
  // peek에서도 활성 섹션과 같은 그룹 구조를 유지한다 — 총 칩 수만 PEEK_CHIP_LIMIT로 제한하고,
  // 잘려나간 수는 "+N more"로 알린다(그룹 소속이 안 보이는 착시를 막는다).
  const sections = groupOperations(entries, groups, []);
  let remaining = PEEK_CHIP_LIMIT;
  let truncated = 0;
  const visibleSections: typeof sections = [];
  for (const section of sections) {
    if (section.entries.length === 0) continue;
    const take = section.entries.slice(0, Math.max(0, remaining));
    truncated += section.entries.length - take.length;
    remaining -= take.length;
    if (take.length > 0) visibleSections.push({ ...section, entries: take });
  }
  return (
    <li className="side-bar-theater-section side-bar-theater-section--peek" data-theater-id={theater.id}>
      <TheaterSectionHeader
        theater={theater}
        operationCount={operationCount}
        active={false}
        collapsed={collapsed}
        onSelectTheater={onSelectTheater}
        onToggleCollapsed={onToggleCollapsed}
        onOpenActions={onOpenActions}
        onOpenLaunch={onOpenLaunch}
        onContextMenu={onContextMenu}
      />
      {visibleSections.length > 0 ? (
        <ol className="side-bar-peek-chips" aria-label={`${theater.label} preview operations`}>
          {visibleSections.map((section) => {
            const grpColor = section.group ? resolveAccentColor(section.group.color) : null;
            return (
              <li
                key={section.groupId ?? "__ungrouped__"}
                className={section.groupId ? "side-bar-group-section side-bar-group-section--peek" : "side-bar-ungrouped-section"}
                style={grpColor ? ({ "--grp-color": grpColor } as CSSProperties) : undefined}
              >
                {section.group ? (
                  <div className="side-bar-peek-group-label" aria-label={`Group ${section.group.name}`}>
                    <span>{section.group.name}</span>
                    <span className="side-bar-peek-group-count">{section.entries.length}</span>
                  </div>
                ) : null}
                <ol className="side-bar-group-chips" aria-label={section.group ? section.group.name : "Ungrouped"}>
                  {section.entries.map((entry, index) => (
                    <OperationsSideBarChip
                      key={entry.operation.id}
                      entry={entry}
                      index={index}
                      isCloseArmed={false}
                      accentValue={null}
                      dragging={false}
                      dragOffsetY={0}
                      dropTarget={false}
                      preview
                      onArmClose={() => {}}
                      onDisarmClose={() => {}}
                      onClose={() => {}}
                      onFocus={onFocus}
                      onKeyboardMove={() => {}}
                      onPointerDragStart={() => {}}
                      onOpenAccent={() => {}}
                      onRename={() => {}}
                    />
                  ))}
                </ol>
              </li>
            );
          })}
          {truncated > 0 ? <li className="side-bar-peek-more">+{truncated} more</li> : null}
        </ol>
      ) : null}
    </li>
  );
}

function TheaterActionsMenu({ theater, groupCount, anchor, onCreateGroup, onForgetTheater, onClose }: TheaterActionsMenuProps) {
  const [showNewInput, setShowNewInput] = useState(false);
  const [newName, setNewName] = useState(`Group ${groupCount + 1}`);
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // 사이드바 하단 행에서 anchor.bottom+6 고정 배치가 뷰포트 아래로 밀리면 스크롤로 닫혀
  // Forget/New group에 도달할 수 없다(Codex P2) — 실측 높이로 상단을 클램프한다.
  const [menuTop, setMenuTop] = useState(anchor.bottom + 6);

  useLayoutEffect(() => {
    const height = menuRef.current?.getBoundingClientRect().height ?? 0;
    const maxTop = window.innerHeight - height - 8;
    setMenuTop(Math.max(8, Math.min(anchor.bottom + 6, maxTop)));
  }, [anchor, showNewInput]);

  useEffect(() => {
    if (showNewInput) inputRef.current?.select();
  }, [showNewInput]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  const confirmNewGroup = () => {
    const name = newName.trim();
    if (!name) return;
    onCreateGroup(name);
  };

  return createPortal(
    <div className="group-context-menu-overlay" role="presentation" onPointerDown={onClose}>
      <div
        ref={menuRef}
        className="theater-menu side-bar-theater-menu"
        role="menu"
        aria-label={`${theater.label} actions`}
        style={{
          position: "fixed",
          left: anchor.left,
          top: menuTop,
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {showNewInput ? (
          <input
            ref={inputRef}
            className="group-context-menu-new-input theater-menu-new-group-input"
            type="text"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !composingRef.current) { event.preventDefault(); confirmNewGroup(); }
              if (event.key === "Escape") { event.preventDefault(); setShowNewInput(false); }
            }}
            onBlur={() => setShowNewInput(false)}
            aria-label="New group name"
            placeholder="Group name"
          />
        ) : (
          <button
            type="button"
            role="menuitem"
            className="theater-menu-item theater-menu-new-group"
            onClick={() => setShowNewInput(true)}
          >
            <span className="theater-menu-check" aria-hidden="true"><PlusIcon /></span>
            <span className="theater-menu-label">New group…</span>
          </button>
        )}
        <div className="theater-menu-divider" aria-hidden="true" />
        <button
          type="button"
          role="menuitem"
          className="theater-menu-item theater-menu-forget"
          onClick={onForgetTheater}
        >
          <span className="theater-menu-check" aria-hidden="true"><TrashIcon /></span>
          <span className="theater-menu-label">Forget Theater</span>
        </button>
      </div>
    </div>,
    document.body,
  );
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

function ChevronIcon({ collapsed }: { readonly collapsed: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      {collapsed ? (
        <path d="M6 3.8 10.2 8 6 12.2" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M3.8 6 8 10.2 12.2 6" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.4v9.2M3.4 8h9.2" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  );
}

export function theaterInitials(label: string): string {
  // 하이픈/언더스코어/점도 단어 경계로 취급 — "fleet-harness" → "FH" (재가 시안 문법)
  const words = label.trim().split(/[\s\-_.]+/).filter(Boolean);
  const initials = words.length > 1
    ? words.flatMap((word) => firstGrapheme(word))
    : graphemes(label).filter((grapheme) => /[\p{L}\p{N}]/u.test(grapheme));
  return initials.slice(0, 2).join("").toUpperCase() || "--";
}

function firstGrapheme(value: string): string[] {
  return graphemes(value).slice(0, 1);
}

function graphemes(value: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map((segment) => segment.segment);
  }
  return Array.from(value);
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.2 5.8v6.1M8 5.8v6.1M10.8 5.8v6.1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M3.7 4.1h8.6M6.4 4.1l.4-1h2.4l.4 1M4.6 4.1l.5 9.1h5.8l.5-9.1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
