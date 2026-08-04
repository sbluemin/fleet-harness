import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { Translate } from "@fleet-console/sdk/i18n";
import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { getT, useT, type CoreMessageKey } from "../i18n/index.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../operation-idle-arrival.js";
import type { OperationGroup, OperationNode, OperationNotification, TheaterInfo } from "../types.js";
import { CanvasContextMenu } from "../canvas/canvas-context-menu.js";
import { focusCommandBandToggleWhenPanelContainsActiveElement } from "../focus-guards.js";
import { DirectoryBrowserModal } from "../components/directory-browser-modal.js";
import { useConsoleState } from "../hooks/use-store.js";
import { GroupContextMenu } from "../canvas/group-context-menu.js";
import { operationAccentFromNode, resolveAccentColor } from "../canvas/operation-accent.js";
import { getTheaterCanvasSnapshot, setOperationOrder, toggleGroupCollapsed, toggleTheaterGroupCollapsed, useCanvasState, useCollapsedGroups } from "../canvas/canvas-store.js";
import { consumeOperationLaunchMenu, consumeSideBarAddTheater, consumeSideBarTheaterLaunch, sortOperationsByOrder } from "../store.js";
import { resolveOperationActivity } from "../operation-activity.js";
import { applyVisibleReorder, groupDropIndexFromPoint, dropTargetFromPoint, insertIntoSegment, moveByTargetIndex, reorderGroupIds, reorderTheaterIds, reorderWithinSegment, theaterDropIndexFromPoint, type DropSectionInfo } from "./operations-side-bar-hit-test.js";
import { useContextMenuKeyboard } from "./context-menu-keyboard.js";
import {
  subscribeSideBarOperationAction,
  type SideBarOperationMenuAction,
} from "./interaction.js";
import { OperationsSideBarChip, type SideBarEntry } from "./operations-side-bar-chip.js";
import { OperationsSideBarGroupHeader } from "./operations-side-bar-group-header.js";
import {
  consumeStatusLandings,
  setSideBarCollapsed,
  setSideBarWidth,
  setTheaterCollapsed,
  getStatusTransitionTick,
  getSideBarStatusSectionCollapsed,
  trackOperationActivityTransitions,
  toggleSideBarStatusAxis,
  toggleSideBarStatusSectionCollapsed,
  useCollapsedTheaters,
  useSideBarState,
  useSideBarStatusAxis,
  useSideBarStatusSectionCollapsed,
  type SideBarStatus,
} from "./operations-side-bar-store.js";
import { resolveOperationLaunchKind } from "./interaction.js";

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
  readonly onClose: (operationId: string) => void;
  readonly onMinimize: (operationId: string) => void;
  readonly onFocus: (operationId: string) => void;
  readonly onSetAccent: (operationId: string, accentKey: string | null) => void;
  readonly onRename: (operationId: string, title: string) => void;
  readonly onSetGroupId: (operationId: string, groupId: string | null) => void;
  readonly onCreateGroup: (theaterId: string, name: string, operationId?: string) => void;
  readonly onSetGroupColor: (groupId: string, color: string | null) => void;
  readonly onRenameGroup: (groupId: string, name: string) => void;
  readonly onReorderGroups: (orderedGroupIds: readonly string[]) => void;
  readonly onReorderTheaters: (orderedTheaterIds: readonly string[]) => void;
  readonly onUngroupAll: (groupId: string) => void;
  readonly onSelectTheater: (theaterId: string) => void;
  readonly onAddTheater: (path: string) => void;
  readonly onCancelAddTheater: () => void;
  readonly onForgetTheater: (theaterId: string) => void;
}

type ActiveContextMenu =
  | {
      readonly kind: "chip";
      readonly operationId: string;
      readonly anchor: DOMRect;
      readonly returnFocus?: HTMLElement | null;
      readonly requestedAction?: SideBarOperationMenuAction;
    }
  | { readonly kind: "group"; readonly groupId: string; readonly anchor: DOMRect; readonly returnFocus?: HTMLElement | null }
  | { readonly kind: "theater"; readonly theaterId: string; readonly anchor: DOMRect; readonly returnFocus?: HTMLElement | null };

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

interface TheaterDragState {
  readonly kind: "theater";
  readonly sourceTheaterId: string;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly currentY: number;
  readonly dragging: boolean;
  readonly dropIndex: number;
}

type DragState = ChipDragState | GroupDragState | TheaterDragState;

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
  readonly active: boolean;
  readonly collapsed: boolean;
  readonly statusAxis: boolean;
  readonly statusActionsOpen: boolean;
  readonly showStatusLiveTick: boolean;
  readonly dragging: boolean;
  readonly dropTarget: boolean;
  readonly dragOffsetY: number;
  readonly onSelectTheater: (theaterId: string) => void;
  readonly onToggleCollapsed: (theaterId: string) => void;
  readonly onToggleStatusAxis: () => void;
  readonly onOpenActions: (anchor: DOMRect, returnFocus?: HTMLButtonElement | null) => void;
  readonly onOpenLaunch: (event: MouseEvent<HTMLButtonElement>, theaterId: string) => void;
  readonly onContextMenu: (anchor: DOMRect, returnFocus?: HTMLElement | null) => void;
  readonly onPointerDragStart: (event: ReactPointerEvent<HTMLDivElement>, theaterId: string) => void;
}

interface TheaterInactiveSectionProps {
  readonly theater: TheaterInfo;
  readonly entries: readonly SideBarEntry[];
  readonly groups: readonly OperationGroup[];
  readonly collapsedGroups: ReadonlySet<string>;
  readonly operationAccent: Readonly<Record<string, string>>;
  readonly collapsed: boolean;
  readonly statusAxis: boolean;
  readonly statusActionsOpen: boolean;
  readonly showStatusLiveTick: boolean;
  readonly statusLandingIds: ReadonlySet<string>;
  readonly dragging: boolean;
  readonly dropBefore: boolean;
  readonly dropAfter: boolean;
  readonly dragOffsetY: number;
  readonly onSelectTheater: (theaterId: string) => void;
  readonly onFocus: (operationId: string) => void;
  readonly onToggleCollapsed: (theaterId: string) => void;
  readonly onToggleStatusAxis: () => void;
  readonly onOpenActions: (anchor: DOMRect, returnFocus?: HTMLButtonElement | null) => void;
  readonly onOpenLaunch: (event: MouseEvent<HTMLButtonElement>, theaterId: string) => void;
  readonly onContextMenu: (anchor: DOMRect, returnFocus?: HTMLElement | null) => void;
  readonly onPointerDragStart: (event: ReactPointerEvent<HTMLDivElement>, theaterId: string) => void;
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
const STATUS_LANDING_DURATION_MS = 500;

export interface StatusSection {
  readonly status: SideBarStatus;
  readonly label: string;
  readonly entries: readonly SideBarEntry[];
}

function buildStatusSectionOrder(t: Translate<CoreMessageKey>): readonly Omit<StatusSection, "entries">[] {
  return [
    { status: "awaiting", label: t("sidebar.status.awaiting") },
    { status: "running", label: t("sidebar.status.running") },
    { status: "background", label: t("sidebar.status.background") },
    { status: "idle", label: t("sidebar.status.idle") },
    { status: "dormant", label: t("sidebar.status.dormant") },
  ];
}

export function StatusSectionSlot({
  theaterId,
  section,
  unseenCount = 0,
  children,
}: {
  readonly theaterId: string;
  readonly section: StatusSection;
  readonly unseenCount?: number;
  readonly children: ReactNode;
}) {
  const t = useT();
  const empty = section.entries.length === 0;
  const collapsed = useSideBarStatusSectionCollapsed(theaterId, section.status, empty);
  return (
    <li
      className={[
        "side-bar-status-section",
        `side-bar-status-section--${section.status}`,
        empty ? "side-bar-status-section--empty" : "",
      ].filter(Boolean).join(" ")}
    >
      <div className={`side-bar-status-header side-bar-status-header--${section.status}`}>
        <button
          type="button"
          className="side-bar-status-header__toggle"
          onClick={() => toggleSideBarStatusSectionCollapsed(theaterId, section.status, empty)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("sidebar.status.expandSection", { label: section.label }) : t("sidebar.status.collapseSection", { label: section.label })}
          title={collapsed ? t("sidebar.status.expand") : t("sidebar.status.collapse")}
        >
          <StatusSectionCollapseArrow collapsed={collapsed} />
        </button>
        <span className="side-bar-status-header__dot" aria-hidden="true" />
        <span className="side-bar-status-header__label">{section.label}</span>
        {unseenCount > 0 ? <span className="side-bar-status-header__unseen">{unseenCount}</span> : null}
        <span className="side-bar-status-header__count">{section.entries.length}</span>
      </div>
      {!collapsed ? (
        <ol className="side-bar-group-chips" aria-label={t("sidebar.status.sectionOperations", { label: section.label })}>
          {empty ? <li className="side-bar-status-empty-hint">{t("sidebar.status.noOperations")}</li> : children}
        </ol>
      ) : null}
    </li>
  );
}

function StatusSectionCollapseArrow({ collapsed }: { readonly collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={`side-bar-status-header__arrow${collapsed ? " is-collapsed" : ""}`}
    >
      <path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
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
  onClose,
  onMinimize,
  onFocus,
  onSetAccent,
  onRename,
  onSetGroupId,
  onCreateGroup,
  onSetGroupColor,
  onRenameGroup,
  onReorderGroups,
  onReorderTheaters,
  onUngroupAll,
  onSelectTheater,
  onAddTheater,
  onCancelAddTheater,
  onForgetTheater,
}: OperationsSideBarProps) {
  const t = useT();
  const rootRef = useRef<HTMLElement | null>(null);
  const chipsRef = useRef<HTMLOListElement | null>(null);
  const sideBar = useSideBarState();
  const { width, collapsed } = sideBar;
  const statusAxis = useSideBarStatusAxis();
  const previousCollapsedRef = useRef(collapsed);
  const canvas = useCanvasState();
  const closeArmTimeoutRef = useRef<number | null>(null);
  const statusLandingTimeoutsRef = useRef<Set<number>>(new Set());
  const didMountStatusLandingRef = useRef(false);
  const [armedCloseId, setArmedCloseId] = useState<string | null>(null);
  const [statusLandingIds, setStatusLandingIds] = useState<ReadonlySet<string>>(new Set());
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const entriesRef = useRef<SideBarEntry[]>([]);
  const currentOrderRef = useRef<string[]>([]);
  const dropSectionsRef = useRef<DropSectionInfo[]>([]);
  const orderedGroupIdsRef = useRef<string[]>([]);
  const orderedTheaterIdsRef = useRef<string[]>([]);
  const onSetGroupIdRef = useRef(onSetGroupId);
  const onReorderGroupsRef = useRef(onReorderGroups);
  const onReorderTheatersRef = useRef(onReorderTheaters);
  const contextMenuReturnFocusRef = useRef<HTMLElement | null>(null);
  const [activeContextMenu, setActiveContextMenu] = useState<ActiveContextMenu | null>(null);
  const [newMenu, setNewMenu] = useState<NewMenuState | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [sideBarResizing, setSideBarResizing] = useState(false);
  const collapsedGroups = useCollapsedGroups();
  const collapsedTheaters = useCollapsedTheaters();
  const {
    operationStatus,
    activeOperationAcknowledged,
    pendingSideBarAddTheater,
    pendingSideBarTheaterLaunch,
    launchMenuRequest,
  } = useConsoleState();
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);

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
      status: resolveOperationActivity(operation, operationStatus),
      icon,
    };
  });
  const groupedSections = groupOperations(allEntries, activeGroups, canvas.operationOrder);
  const statusSections = groupOperationsByStatus(allEntries, getStatusTransitionTick, t);
  const idleUnseenIds = idleArrivalIds;
  const isIdleUnseen = (id: string) => id !== activeOperationId && idleUnseenIds.has(id);
  // STATUS 축 렌더는 entry/그룹 조회가 칩마다 반복되므로 O(n²)를 피해 Map으로 한 번만 인덱싱한다.
  const entryIndexById = new Map(allEntries.map((entry, index) => [entry.operation.id, index] as const));
  const groupMarkByGroupId = new Map(activeGroups.map((group) => {
    const color = resolveAccentColor(group.color);
    return [group.id, color ? { name: group.name, color } : null] as const;
  }));
  const hasCustomGroups = groupedSections.some((section) => section.group !== null);
  const orderedGroupIds = groupedSections.flatMap((section) => section.groupId ? [section.groupId] : []);
  const visibleEntries = groupedSections.flatMap((section) =>
    collapsedGroupSet.has(section.groupId ?? "") ? [] : section.entries,
  );
  const currentOrder = allEntries.map((entry) => entry.operation.id);
  const statusSignature = operations
    .map((operation) => `${operation.id}:${resolveOperationActivity(operation, operationStatus)}`)
    .join("\0");

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

  useEffect(() => subscribeSideBarOperationAction((request) => {
    const operation = operations.find((candidate) => candidate.id === request.operationId);
    if (!operation || operation.theaterId !== activeTheaterId) return false;
    if (collapsed) {
      setSideBarCollapsed(false);
      return false;
    }
    if (collapsedTheaters.includes(operation.theaterId)) {
      setTheaterCollapsed(operation.theaterId, false);
      return false;
    }
    // 상태축에서는 그룹 접힘이 배치에 영향을 주지 않는다 — 여기서 펼치면 사용자의 그룹축 설정만 조용히 바뀐다.
    if (statusAxis) {
      const status = resolveSideBarStatusSection(
        resolveOperationActivity(operation, operationStatus),
        operation.id,
        idleArrivalIds,
      );
      if (getSideBarStatusSectionCollapsed(operation.theaterId, status, false)) {
        toggleSideBarStatusSectionCollapsed(operation.theaterId, status, false);
      }
      return false;
    }
    if (operation.groupId && collapsedGroupSet.has(operation.groupId)) {
      toggleGroupCollapsed(operation.groupId);
      return false;
    }
    return false;
  }), [activeTheaterId, collapsed, collapsedGroupSet, collapsedTheaters, idleArrivalIds, operationStatus, operations, statusAxis]);

  useEffect(() => {
    if (armedCloseId === null) return;
    if (allEntries.some((entry) => entry.operation.id === armedCloseId)) return;
    disarmClose();
  }, [armedCloseId, allEntries, disarmClose]);

  // App의 동기 store 구독이 렌더 배칭 전의 각 전이를 기록한다. 아래 백업 호출은 App 없는
  // jsdom 경로를 자기완결적으로 유지하고, pending landing만 사이드바 표시 수명주기로 소비한다.
  useEffect(() => {
    trackOperationActivityTransitions({
      operations,
      operationStatus,
      activeTheaterId,
      activeOperationId,
      activeOperationAcknowledged,
    });
    const landedIds = consumeStatusLandings();
    if (!didMountStatusLandingRef.current) {
      didMountStatusLandingRef.current = true;
      return;
    }
    if (!statusAxis) {
      for (const timeoutId of statusLandingTimeoutsRef.current) window.clearTimeout(timeoutId);
      statusLandingTimeoutsRef.current.clear();
      setStatusLandingIds((current) => current.size === 0 ? current : new Set());
      return;
    }
    if (landedIds.length === 0) return;
    // 이동 배치별 독립 타이머: 기존 flash를 취소하지 않고 병합했다가 이 배치의 ID만 만료시킨다.
    setStatusLandingIds((current) => {
      const next = new Set(current);
      for (const id of landedIds) next.add(id);
      return next;
    });
    const timeoutId = window.setTimeout(() => {
      statusLandingTimeoutsRef.current.delete(timeoutId);
      setStatusLandingIds((current) => {
        const next = new Set(current);
        for (const id of landedIds) next.delete(id);
        return next.size === current.size ? current : next;
      });
    }, STATUS_LANDING_DURATION_MS);
    statusLandingTimeoutsRef.current.add(timeoutId);
  // statusSignature is the stable primitive dependency for the operation/status map assembled above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusAxis, statusSignature, activeTheaterId, activeOperationId, activeOperationAcknowledged]);

  useEffect(() => () => {
    for (const timeoutId of statusLandingTimeoutsRef.current) window.clearTimeout(timeoutId);
    statusLandingTimeoutsRef.current.clear();
  }, []);

  // 팔레트 "New Operation" 커맨드 요청을 소비해 ＋New 버튼과 동일한 launch 오버레이를 그 버튼 앵커 위치에 연다.
  useEffect(() => {
    if (!launchMenuRequest) return;
    consumeOperationLaunchMenu();
    // aria-label은 로케일마다 달라지므로 고정 클래스로 런치 버튼을 찾는다.
    const launchButton = rootRef.current?.querySelector<HTMLButtonElement>(
      ".side-bar-theater-section--active .side-bar-theater-launch-btn",
    );
    const rect = launchButton?.getBoundingClientRect();
    setActiveContextMenu(null);
    setNewMenu({
      anchor: rect ? { x: rect.right + 8, y: rect.top } : { x: 16, y: 64 },
      viewportBounds: { width: window.innerWidth, height: window.innerHeight },
    });
  }, [launchMenuRequest]);


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
    if (statusAxis) return;
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
    orderedTheaterIdsRef.current = theaters.map((theater) => theater.id);
    onSetGroupIdRef.current = onSetGroupId;
    onReorderGroupsRef.current = onReorderGroups;
    onReorderTheatersRef.current = onReorderTheaters;
  });

  const updateDrag = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  useEffect(() => {
    if (statusAxis && dragRef.current?.kind === "chip") updateDrag(null);
  }, [statusAxis]);

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
      if (current.kind === "theater") {
        const dropIndex = theaterDropIndexFromPoint(event.clientY, orderedTheaterIdsRef.current, chipsRef.current, current.sourceTheaterId);
        updateDrag({ ...current, currentY: event.clientY, dragging: true, dropIndex });
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

      if (snap.kind === "theater") {
        const nextTheaterIds = reorderTheaterIds(orderedTheaterIdsRef.current, snap.sourceTheaterId, snap.dropIndex);
        if (nextTheaterIds.join("\0") === orderedTheaterIdsRef.current.join("\0")) return;
        onReorderTheatersRef.current(nextTheaterIds);
        return;
      }

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
    if (statusAxis) return;
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

  const beginTheaterPointerDrag = (event: ReactPointerEvent<HTMLDivElement>, theaterId: string) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    const orderedTheaterIds = theaters.map((theater) => theater.id);
    if (!orderedTheaterIds.includes(theaterId)) return;
    setActiveContextMenu(null);
    disarmClose();
    updateDrag({
      kind: "theater",
      sourceTheaterId: theaterId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentY: event.clientY,
      dragging: false,
      dropIndex: orderedTheaterIds.indexOf(theaterId),
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
    // 캔버스(Map) 쪽에 이미 열린 캔버스 제어 메뉴는 사이드바 <aside> 안에 있지 않아
    // 포털의 mousedown 외부-클릭 닫기가 안 잡는다 — 포털이 구독하는 닫기 신호를 함께 본다.
    window.dispatchEvent(new Event("canvas-context-menu-close"));
    setNewMenu({
      anchor: { x: event.clientX, y: event.clientY },
      viewportBounds: { width: window.innerWidth, height: window.innerHeight },
    });
  };

  const closeActiveContextMenu = useCallback(() => {
    const returnFocus = activeContextMenu?.returnFocus ?? null;
    setActiveContextMenu(null);
    returnFocus?.focus();
  }, [activeContextMenu]);
  contextMenuReturnFocusRef.current = activeContextMenu?.returnFocus ?? null;
  useContextMenuKeyboard({
    open: activeContextMenu !== null,
    menuSelector: activeContextMenu?.kind === "theater"
      ? '.side-bar-theater-menu[role="menu"]'
      : '.group-context-menu-card[role="menu"]',
    returnFocusRef: contextMenuReturnFocusRef,
    requestedAction: activeContextMenu?.kind === "chip" ? activeContextMenu.requestedAction : undefined,
    onEscape: closeActiveContextMenu,
  });

  const openTheaterLaunchMenuAt = (anchor: DOMRect, theaterId: string) => {
    if (theaterId !== activeTheaterId) onSelectTheater(theaterId);
    setActiveContextMenu(null);
    setNewMenu({
      anchor: { x: anchor.right + 8, y: anchor.top },
      viewportBounds: { width: window.innerWidth, height: window.innerHeight },
    });
  };

  const openTheaterLaunchMenu = (event: MouseEvent<HTMLButtonElement>, theaterId: string) => {
    event.stopPropagation();
    openTheaterLaunchMenuAt(event.currentTarget.getBoundingClientRect(), theaterId);
  };

  // 커맨드 밴드 "Add Theater…" 요청 소비 — 접힘을 풀고 Theater 브라우저를 연다.
  useEffect(() => {
    if (!pendingSideBarAddTheater) return;
    consumeSideBarAddTheater();
    if (collapsed) setSideBarCollapsed(false);
    openTheaterBrowser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSideBarAddTheater]);

  // 커맨드 밴드 "New Operation in X…" 요청 소비 — 해당 Theater의 New Operation 버튼을 앵커로 launch 메뉴를 연다.
  useEffect(() => {
    const theaterId = pendingSideBarTheaterLaunch;
    if (theaterId === null) return;
    if (collapsed) {
      // 신호는 유지한다 — 펼침 재렌더 후 이 effect가 다시 돌며 앵커를 실측한다.
      setSideBarCollapsed(false);
      return;
    }
    if (!theaters.some((theater) => theater.id === theaterId)) {
      consumeSideBarTheaterLaunch();
      return;
    }
    // consume은 실측 시점에 한다 — 여기서 먼저 소비하면 deps 변경 cleanup이 아래 타이머를 즉시 취소한다.
    const openAtLaunchButton = () => {
      consumeSideBarTheaterLaunch();
      const section = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-theater-id]") ?? [])
        .find((candidate) => candidate.dataset.theaterId === theaterId);
      const button = section?.querySelector<HTMLButtonElement>(".side-bar-theater-launch-btn");
      if (!button) return;
      openTheaterLaunchMenuAt(button.getBoundingClientRect(), theaterId);
    };
    // 접힘 해제 직후에는 width 200ms 전환이 진행 중이라 즉시 실측하면 앵커가 왼쪽으로 틀어진다 — 전환 종료 후 실측.
    const settled = rootRef.current !== null && Math.abs(rootRef.current.getBoundingClientRect().width - width) <= 1;
    if (settled) {
      openAtLaunchButton();
      return;
    }
    const timer = window.setTimeout(openAtLaunchButton, 220);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSideBarTheaterLaunch, collapsed]);

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
      {!collapsed && theaterError ? <p className="side-bar-theater-error">{theaterError}</p> : null}

      <ol className="operations-side-bar-chips" ref={chipsRef} aria-label={t("sidebar.list.aria")}>
        {theaters.map((theater, theaterIndex) => {
          const isActiveTheater = theater.id === activeTheaterId;
          const theaterOperations = operations.filter((operation) => operation.theaterId === theater.id);
          const showStatusLiveTick = !statusAxis && hasAwaitingOperation(theaterOperations, operationStatus);
          const statusActionsOpen = activeContextMenu?.kind === "theater" && activeContextMenu.theaterId === theater.id;
          const theaterCollapsed = collapsedTheaters.includes(theater.id);
          const isTheaterDragging = drag?.kind === "theater" && drag.sourceTheaterId === theater.id && drag.dragging;
          const theaterDragOffsetY = isTheaterDragging && drag?.kind === "theater" ? drag.currentY - drag.startY : 0;
          const theaterDropBefore = drag?.kind === "theater"
            && drag.dragging
            && drag.sourceTheaterId !== theater.id
            && drag.dropIndex === theaterIndex;
          const theaterDropAfter = drag?.kind === "theater"
            && drag.dragging
            && drag.sourceTheaterId !== theater.id
            && theaterIndex === theaters.length - 1
            && drag.dropIndex === theaters.length;
          if (!isActiveTheater) {
            const theaterCanvas = getTheaterCanvasSnapshot(theater.id);
            const inactiveEntries = buildTheaterEntries({
              theaterId: theater.id,
              operations,
              operationOrder: theaterCanvas.operationOrder,
              minimizedSet: new Set(theaterCanvas.minimized),
              // 비활성 Theater의 칩은 캔버스에 없으므로 활성(brass/aria-current) 표시 대상이 아니다(Codex P3).
              activeOperationId: null,
              operationNotifications,
              operationStatus,
              catalog,
              renderKindIcon,
            });
            return (
              <TheaterInactiveSection
                key={theater.id}
                theater={theater}
                entries={theaterCollapsed ? [] : inactiveEntries}
                groups={groups.filter((group) => group.theaterId === theater.id)}
                collapsedGroups={new Set(theaterCanvas.collapsedGroups)}
                operationAccent={theaterCanvas.operationAccent}
                collapsed={theaterCollapsed}
                statusAxis={statusAxis}
                statusActionsOpen={statusActionsOpen}
                showStatusLiveTick={showStatusLiveTick}
                statusLandingIds={statusLandingIds}
                dragging={isTheaterDragging}
                dropBefore={theaterDropBefore}
                dropAfter={theaterDropAfter}
                dragOffsetY={theaterDragOffsetY}
                onSelectTheater={onSelectTheater}
                onFocus={onFocus}
                onToggleCollapsed={toggleTheaterSectionCollapsed}
                onToggleStatusAxis={toggleSideBarStatusAxis}
                onOpenActions={(anchor, returnFocus) => {
                  setNewMenu(null);
                  setActiveContextMenu({ kind: "theater", theaterId: theater.id, anchor, returnFocus });
                }}
                onOpenLaunch={openTheaterLaunchMenu}
                onContextMenu={(anchor, returnFocus) => {
                  setNewMenu(null);
                  setActiveContextMenu({ kind: "theater", theaterId: theater.id, anchor, returnFocus });
                }}
                onPointerDragStart={beginTheaterPointerDrag}
              />
            );
          }
          return (
            <li
              key={theater.id}
              className={[
                "side-bar-theater-section side-bar-theater-section--active",
                theaterDropBefore ? "side-bar-theater-section--drop-before" : "",
                theaterDropAfter ? "side-bar-theater-section--drop-after" : "",
              ].filter(Boolean).join(" ")}
              data-theater-id={theater.id}
            >
              <TheaterSectionHeader
                theater={theater}
                active
                collapsed={theaterCollapsed}
                statusAxis={statusAxis}
                statusActionsOpen={statusActionsOpen}
                showStatusLiveTick={showStatusLiveTick}
                dragging={isTheaterDragging}
                dropTarget={theaterDropBefore}
                dragOffsetY={theaterDragOffsetY}
                onSelectTheater={onSelectTheater}
                onToggleCollapsed={toggleTheaterSectionCollapsed}
                onToggleStatusAxis={toggleSideBarStatusAxis}
                onOpenActions={(anchor, returnFocus) => {
                  setNewMenu(null);
                  setActiveContextMenu({ kind: "theater", theaterId: theater.id, anchor, returnFocus });
                }}
                onOpenLaunch={openTheaterLaunchMenu}
                onContextMenu={(anchor, returnFocus) => {
                  setNewMenu(null);
                  setActiveContextMenu({ kind: "theater", theaterId: theater.id, anchor, returnFocus });
                }}
                onPointerDragStart={beginTheaterPointerDrag}
              />
              {!theaterCollapsed ? (
              <ol className="side-bar-theater-groups" aria-label={t("sidebar.theater.operationsAria", { theater: theater.label })}>
                {statusAxis ? statusSections.map((section) => (
                  <StatusSectionSlot
                    key={section.status}
                    theaterId={theater.id}
                    section={section}
                    unseenCount={section.entries.filter((entry) => isIdleUnseen(entry.operation.id)).length}
                  >
                    {section.entries.map((entry) => {
                      const globalIndex = entryIndexById.get(entry.operation.id) ?? 0;
                      const accentKey = canvas.operationAccent[entry.operation.id] ?? operationAccentFromNode(entry.operation);
                      const accentValue = accentKey ? resolveAccentColor(accentKey) : null;
                      const groupMark = entry.operation.groupId ? groupMarkByGroupId.get(entry.operation.groupId) ?? null : null;
                      return (
                        <OperationsSideBarChip
                          key={entry.operation.id}
                          entry={entry}
                          index={globalIndex}
                          isCloseArmed={armedCloseId === entry.operation.id}
                          accentValue={accentValue}
                          groupMark={groupMark}
                          statusAxis
                          idleUnseen={isIdleUnseen(entry.operation.id)}
                          statusLanded={statusLandingIds.has(entry.operation.id)}
                          reorderEnabled={false}
                          dragging={false}
                          dragOffsetY={0}
                          dropTarget={false}
                          onArmClose={armClose}
                          onDisarmClose={disarmClose}
                          onClose={onClose}
                          onMinimize={onMinimize}
                          onFocus={onFocus}
                          onKeyboardMove={keyboardMove}
                          onPointerDragStart={beginPointerDrag}
                          onOpenAccent={(operationId, anchor, returnFocus, requestedAction) => {
                            setActiveContextMenu({ kind: "chip", operationId, anchor, returnFocus, requestedAction });
                          }}
                          onRename={onRename}
                        />
                      );
                    })}
                  </StatusSectionSlot>
                )) : groupedSections.map((section) => {
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
                <div className="side-bar-ungrouped-label" aria-label={t("sidebar.ungrouped.aria")}>
                  <span>{t("sidebar.ungrouped.label")}</span>
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
                  aria-label={section.group ? section.group.name : t("sidebar.ungrouped.label")}
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
                        idleUnseen={isIdleUnseen(entry.operation.id)}
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
                        onMinimize={onMinimize}
                        onFocus={onFocus}
                        onKeyboardMove={keyboardMove}
                        onPointerDragStart={beginPointerDrag}
                        onOpenAccent={(operationId, anchor, returnFocus, requestedAction) => {
                          setActiveContextMenu({ kind: "chip", operationId, anchor, returnFocus, requestedAction });
                        }}
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
        <li>
          <button type="button" className="side-bar-ghost-theater-row" onClick={openTheaterBrowser} disabled={addingTheater}>
            <span className="side-bar-ghost-theater-anchor" aria-hidden="true"><PlusIcon /></span>
            <span className="side-bar-ghost-theater-label">{t("sidebar.theater.newTheater")}</span>
          </button>
        </li>
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
          catalog={catalog}
          canLaunch={canLaunch}
          renderKindIcon={renderKindIcon}
          onLaunchKind={(pluginId, kind) => { setNewMenu(null); onLaunchKind(pluginId, kind); }}
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
          onClose={closeActiveContextMenu}
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
          onClose={closeActiveContextMenu}
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

export function groupOperationsByStatus(
  entries: readonly SideBarEntry[],
  getTick?: (id: string) => number | undefined,
  t: Translate<CoreMessageKey> = getT("en"),
): StatusSection[] {
  const idleArrivalIds = getIdleArrivalIds();
  return buildStatusSectionOrder(t).map(({ status, label }) => ({
    status,
    label,
    // entry.status는 엔트리 생성 시점에 resolveOperationActivity로 이미 해소된다.
    // 미해소(undefined) 엔트리의 idle 폭백은 직접 구성된 입력에 대한 방어 계약이다.
    entries: entries
      .filter((entry) =>
        resolveSideBarStatusSection(entry.status ?? "idle", entry.operation.id, idleArrivalIds) === status)
      .sort((left, right) => {
        const leftTick = getTick?.(left.operation.id);
        const rightTick = getTick?.(right.operation.id);
        if (leftTick === undefined && rightTick === undefined) return 0;
        if (leftTick === undefined) return 1;
        if (rightTick === undefined) return -1;
        return rightTick - leftTick;
      }),
  }));
}

export function resolveSideBarStatusSection(
  entryStatus: SideBarStatus,
  operationId: string,
  idleArrivalIds: ReadonlySet<string>,
): SideBarStatus {
  return entryStatus === "idle" && idleArrivalIds.has(operationId) ? "awaiting" : entryStatus;
}

export function hasAwaitingOperation(
  operations: readonly OperationNode[],
  operationStatus: Readonly<Record<string, OperationActivity>>,
): boolean {
  const idleArrivalIds = getIdleArrivalIds();
  return operations.some((operation) =>
    resolveSideBarStatusSection(
      resolveOperationActivity(operation, operationStatus),
      operation.id,
      idleArrivalIds,
    ) === "awaiting");
}

function resolveEntryGroupMark(
  entry: SideBarEntry,
  groups: readonly OperationGroup[],
): { readonly name: string; readonly color: string } | null {
  const groupId = entry.operation.groupId;
  if (!groupId) return null;
  const group = groups.find((candidate) => candidate.id === groupId);
  if (!group) return null;
  const color = resolveAccentColor(group.color);
  return color ? { name: group.name, color } : null;
}

export function buildTheaterEntries({
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
      status: resolveOperationActivity(operation, operationStatus),
      icon,
    };
  });
}

function TheaterSectionHeader({
  theater,
  active,
  collapsed,
  statusAxis,
  statusActionsOpen,
  showStatusLiveTick,
  dragging,
  dropTarget,
  dragOffsetY,
  onSelectTheater,
  onToggleCollapsed,
  onToggleStatusAxis,
  onOpenActions,
  onOpenLaunch,
  onContextMenu,
  onPointerDragStart,
}: TheaterSectionHeaderProps) {
  const t = useT();
  const suppressClickRef = useRef(false);
  const headerClassName = [
    "side-bar-theater-header",
    active ? "is-active" : "",
    dragging ? "side-bar-theater-header--dragging" : "",
    dropTarget ? "side-bar-theater-header--drop-target" : "",
  ].filter(Boolean).join(" ");
  const headerStyle = dragging ? ({ "--drag-dy": `${Math.round(dragOffsetY)}px` } as CSSProperties) : undefined;

  const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    onContextMenu(event.currentTarget.getBoundingClientRect());
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // 중첩 행 컨트롤(status/+ /caret)에서 버블된 Enter/Space를 가로채면 버튼 키보드 활성화가 죽는다.
    if (event.target !== event.currentTarget) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      onContextMenu(event.currentTarget.getBoundingClientRect(), event.currentTarget);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    activateOrToggle();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("button")) return;
    onPointerDragStart(event, theater.id);
  };

  const handlePointerUp = () => {
    if (dragging) suppressClickRef.current = true;
  };

  // 행 클릭은 ▾ 버튼을 흡수한 단일 제스처다. 비활성 Theater는 선택만 하고(영속 접힘 선호를
  // 건드리지 않는다), 이미 활성인 Theater에서만 접기/펼치기를 토글한다.
  // 행 title도 이 결과와 일치시킨다: 비활성 행은 "Switch to …", 활성 행만 Expand/Collapse를 광고한다.
  const activateOrToggle = () => {
    if (!active) {
      onSelectTheater(theater.id);
      return;
    }
    onToggleCollapsed(theater.id);
  };

  const select = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    activateOrToggle();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-haspopup="menu"
      className={headerClassName}
      style={headerStyle}
      onClick={select}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      aria-current={active ? "true" : undefined}
      aria-expanded={!collapsed}
      title={active ? (collapsed ? t("sidebar.theater.expand", { theater: theater.label }) : t("sidebar.theater.collapse", { theater: theater.label })) : t("sidebar.theater.switchTo", { theater: theater.label })}
    >
      <span className="side-bar-theater-anchor" aria-hidden="true">{theaterInitials(theater.label)}</span>
      <span className="side-bar-theater-name">{theater.label}</span>
      <ChevronIcon collapsed={collapsed} />
      <span className="side-bar-theater-row-controls" role="group" aria-label={t("sidebar.theater.controlsAria", { theater: theater.label })}>
        <button
          type="button"
          className="side-bar-status-axis-toggle"
          aria-label={t("sidebar.theater.sortByStatus")}
          aria-pressed={statusAxis}
          title={t("sidebar.theater.sortByStatusTitle")}
          onClick={(event) => {
            event.stopPropagation();
            onToggleStatusAxis();
          }}
        >
          <StatusListIcon />
          {showStatusLiveTick ? <span className="side-bar-status-axis-live-tick" aria-hidden="true" /> : null}
        </button>
        <span className="side-bar-theater-split-control" role="group" aria-label={t("sidebar.theater.operationControlsAria", { theater: theater.label })}>
          <button
            type="button"
            className="side-bar-theater-row-btn side-bar-theater-launch-btn side-bar-theater-split-plus"
            aria-label={t("sidebar.theater.newOperation", { theater: theater.label })}
            title={t("sidebar.theater.newOperation", { theater: theater.label })}
            onClick={(event) => onOpenLaunch(event, theater.id)}
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            className="side-bar-theater-row-btn side-bar-theater-split-caret"
            aria-label={t("sidebar.theater.actions")}
            aria-haspopup="menu"
            aria-expanded={statusActionsOpen}
            title={t("sidebar.theater.actions")}
            onClick={(event) => {
              event.stopPropagation();
              onOpenActions(event.currentTarget.getBoundingClientRect(), event.currentTarget);
            }}
          >
            <TheaterActionsIcon />
          </button>
        </span>
      </span>
    </div>
  );
}

function TheaterInactiveSection({
  theater,
  entries,
  groups,
  collapsedGroups,
  operationAccent,
  collapsed,
  statusAxis,
  statusActionsOpen,
  showStatusLiveTick,
  statusLandingIds,
  dragging,
  dropBefore,
  dropAfter,
  dragOffsetY,
  onSelectTheater,
  onFocus,
  onToggleCollapsed,
  onToggleStatusAxis,
  onOpenActions,
  onOpenLaunch,
  onContextMenu,
  onPointerDragStart,
}: TheaterInactiveSectionProps) {
  const t = useT();
  const sections = groupOperations(entries, groups, []);
  const statusSections = groupOperationsByStatus(entries, getStatusTransitionTick, t);
  const idleUnseenIds = getIdleArrivalIds();
  const hasCustomGroups = sections.some((section) => section.group !== null);
  return (
    <li
      className={[
        "side-bar-theater-section",
        dropBefore ? "side-bar-theater-section--drop-before" : "",
        dropAfter ? "side-bar-theater-section--drop-after" : "",
      ].filter(Boolean).join(" ")}
      data-theater-id={theater.id}
    >
      <TheaterSectionHeader
        theater={theater}
        active={false}
        collapsed={collapsed}
        statusAxis={statusAxis}
        statusActionsOpen={statusActionsOpen}
        showStatusLiveTick={showStatusLiveTick}
        dragging={dragging}
        dropTarget={dropBefore}
        dragOffsetY={dragOffsetY}
        onSelectTheater={onSelectTheater}
        onToggleCollapsed={onToggleCollapsed}
        onToggleStatusAxis={onToggleStatusAxis}
        onOpenActions={onOpenActions}
        onOpenLaunch={onOpenLaunch}
        onContextMenu={onContextMenu}
        onPointerDragStart={onPointerDragStart}
      />
      {!collapsed && (statusAxis ? statusSections.length : sections.length) > 0 ? (
        <ol className="side-bar-theater-groups" aria-label={t("sidebar.theater.operationsAria", { theater: theater.label })}>
          {statusAxis ? statusSections.map((section) => (
            <StatusSectionSlot
              key={section.status}
              theaterId={theater.id}
              section={section}
              unseenCount={section.entries.filter((entry) => idleUnseenIds.has(entry.operation.id)).length}
            >
              {section.entries.map((entry, index) => {
                const accentKey = operationAccent[entry.operation.id] ?? operationAccentFromNode(entry.operation);
                const accentValue = accentKey ? resolveAccentColor(accentKey) : null;
                return (
                  <OperationsSideBarChip
                    key={entry.operation.id}
                    entry={entry}
                    index={index}
                    isCloseArmed={false}
                    accentValue={accentValue}
                    groupMark={resolveEntryGroupMark(entry, groups)}
                    statusAxis
                    idleUnseen={idleUnseenIds.has(entry.operation.id)}
                    statusLanded={statusLandingIds.has(entry.operation.id)}
                    reorderEnabled={false}
                    dragging={false}
                    dragOffsetY={0}
                    dropTarget={false}
                    preview
                    onArmClose={() => {}}
                    onDisarmClose={() => {}}
                    onClose={() => {}}
                    onMinimize={() => {}}
                    onFocus={onFocus}
                    onKeyboardMove={() => {}}
                    onPointerDragStart={() => {}}
                    onOpenAccent={() => {}}
                    onRename={() => {}}
                  />
                );
              })}
            </StatusSectionSlot>
          )) : sections.map((section) => {
            const isCollapsed = section.groupId !== null && collapsedGroups.has(section.groupId);
            const grpColor = section.group ? resolveAccentColor(section.group.color) : null;
            return (
              <li
                key={section.groupId ?? "__ungrouped__"}
                className={section.groupId ? "side-bar-group-section" : "side-bar-ungrouped-section"}
                style={grpColor ? ({ "--grp-color": grpColor } as CSSProperties) : undefined}
              >
                {section.group ? (
                  <OperationsSideBarGroupHeader
                    group={section.group}
                    count={section.entries.length}
                    collapsed={isCollapsed}
                    dragging={false}
                    dragOffsetY={0}
                    dropTarget={false}
                    onToggle={(groupId) => toggleTheaterGroupCollapsed(theater.id, groupId)}
                    onContextMenu={() => {}}
                    onPointerDragStart={() => {}}
                  />
                ) : hasCustomGroups && section.entries.length > 0 ? (
                  <div className="side-bar-ungrouped-label" aria-label={t("sidebar.ungrouped.aria")}>
                    <span>{t("sidebar.ungrouped.label")}</span>
                  </div>
                ) : null}
                {!isCollapsed ? (
                  <ol className="side-bar-group-chips" aria-label={section.group ? section.group.name : t("sidebar.ungrouped.label")}>
                    {section.entries.map((entry, index) => {
                      const accentKey = operationAccent[entry.operation.id] ?? operationAccentFromNode(entry.operation);
                      const accentValue = accentKey ? resolveAccentColor(accentKey) : null;
                      return (
                        <OperationsSideBarChip
                          key={entry.operation.id}
                          entry={entry}
                          index={index}
                          isCloseArmed={false}
                          accentValue={accentValue}
                          idleUnseen={idleUnseenIds.has(entry.operation.id)}
                          dragging={false}
                          dragOffsetY={0}
                          dropTarget={false}
                          preview
                          onArmClose={() => {}}
                          onDisarmClose={() => {}}
                          onClose={() => {}}
                          onMinimize={() => {}}
                          onFocus={onFocus}
                          onKeyboardMove={() => {}}
                          onPointerDragStart={() => {}}
                          onOpenAccent={() => {}}
                          onRename={() => {}}
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
}

function TheaterActionsMenu({ theater, groupCount, anchor, onCreateGroup, onForgetTheater, onClose }: TheaterActionsMenuProps) {
  const t = useT();
  const [showNewInput, setShowNewInput] = useState(false);
  const [newName, setNewName] = useState(() => t("sidebar.theater.defaultGroupName", { n: groupCount + 1 }));
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
        aria-label={t("sidebar.theater.actionsMenuAria", { theater: theater.label })}
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
            aria-label={t("sidebar.theater.newGroupNameAria")}
            placeholder={t("sidebar.theater.groupNamePlaceholder")}
          />
        ) : (
          <button
            type="button"
            role="menuitem"
            className="theater-menu-item theater-menu-new-group"
            onClick={() => setShowNewInput(true)}
          >
            <span className="theater-menu-check" aria-hidden="true"><PlusIcon /></span>
            <span className="theater-menu-label">{t("sidebar.theater.newGroup")}</span>
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
          <span className="theater-menu-label">{t("sidebar.theater.forget")}</span>
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
    <svg className={`side-bar-theater-chevron${collapsed ? " is-collapsed" : ""}`} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.8 6 8 10.2 12.2 6" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatusListIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4" cy="4" r="1.5" fill="currentColor" />
      <path d="M8 4h5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="4" cy="8" r="1.5" fill="currentColor" />
      <path d="M8 8h5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="4" cy="12" r="1.5" fill="currentColor" />
      <path d="M8 12h5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function TheaterActionsIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="3.2" cy="8" r="1.35" fill="currentColor" />
      <circle cx="8" cy="8" r="1.35" fill="currentColor" />
      <circle cx="12.8" cy="8" r="1.35" fill="currentColor" />
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
