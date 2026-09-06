import type { OperationActivityVisual } from "../operation-activity.js";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { Translate } from "@fleet-console/sdk/i18n";
import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { getT, useT, type CoreMessageKey } from "../i18n/index.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../operation-marks.js";
import type { OperationGroup, OperationNode, OperationNotification, TheaterInfo } from "../types.js";
import { CanvasContextMenu } from "../canvas/canvas-context-menu.js";
import { OperationStatusIcon } from "../components/operation-status-icon.js";
import { focusEdgeDockWhenPanelContainsActiveElement } from "../shortcuts.js";
import { DirectoryBrowserModal } from "../components/directory-browser-modal.js";
import { useConsoleState } from "../hooks/use-store.js";
import { GroupContextMenu } from "../canvas/group-context-menu.js";
import { operationAccentFromNode, resolveAccentColor } from "../canvas/operation-accent.js";
import { getTheaterCanvasSnapshot, setOperationOrder, toggleGroupCollapsed, toggleTheaterGroupCollapsed, useCanvasState, useCollapsedGroups } from "../canvas/canvas-store.js";
import { consumeOperationLaunchMenu, consumeSideBarAddTheater, consumeSideBarTheaterLaunch, sortOperationsByOrder } from "../store.js";
import { resolveOperationActivity, resolveOperationDisplayActivity, resolveOperationMarkVisual } from "../operation-activity.js";
import { applyVisibleReorder, groupDropIndexFromPoint, dropTargetFromPoint, insertIntoSegment, moveByTargetIndex, reorderGroupIds, reorderTheaterIds, reorderWithinSegment, theaterDropIndexFromPoint, type DropSectionInfo } from "./operations-side-bar-hit-test.js";
import { useContextMenuKeyboard } from "./context-menu-keyboard.js";
import {
  subscribeSideBarOperationAction,
  type SideBarOperationMenuAction,
} from "./interaction.js";
import { OperationsSideBarChip, type SideBarEntry } from "./operations-side-bar-chip.js";
import { OperationsSideBarGroupHeader } from "./operations-side-bar-group-header.js";
import { SideBarCollapseControl, SideBarNarrowToggle, SideBarStatusViewToggle } from "./side-bar-collapse-control.js";
import {
  consumeStatusLandings,
  setSideBarCollapsed,
  setSideBarPeeking,
  setTheaterCollapsed,
  getStatusTransitionTick,
  getSideBarStatusSectionCollapsed,
  trackOperationActivityTransitions,
  toggleSideBarStatusSectionCollapsed,
  useCollapsedTheaters,
  setSideBarMapNarrow,
  useSideBarMapNarrow,
  useSideBarState,
  useSideBarStatusAxis,
  useSideBarStatusSectionCollapsed,
  type SideBarStatus,
} from "./operations-side-bar-store.js";
import { SideBarResizeHandle, useSideBarResize } from "./side-bar-resize.js";

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
  readonly onLaunchKind: (pluginId: string, kind: OperationLaunchKind, variantLaunch?: Readonly<Record<string, string>>) => void;
  readonly onClose: (operationId: string) => void;
  readonly onMinimize: (operationId: string) => void;
  readonly onFocus: (operationId: string) => void;
  readonly onResume: (operationId: string) => void;
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
  readonly operationRuntime: Readonly<Record<string, OperationRuntimeState>>;
}

interface TheaterSectionHeaderProps {
  readonly theater: TheaterInfo;
  readonly active: boolean;
  readonly collapsed: boolean;
  readonly statusActionsOpen: boolean;
  readonly showStatusLiveTick: boolean;
  readonly dragging: boolean;
  readonly dropTarget: boolean;
  readonly dragOffsetY: number;
  readonly onSelectTheater: (theaterId: string) => void;
  readonly onToggleCollapsed: (theaterId: string) => void;
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
  readonly onResume: (operationId: string) => void;
  readonly onToggleCollapsed: (theaterId: string) => void;
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
    { status: "idle", label: t("sidebar.status.idle") },
    { status: "ended", label: t("sidebar.status.ended") },
  ];
}

// 사이드바 STATUS 칸은 활동을 네 칸으로만 읽는다. background는 실행 중과 같은 칸에 앉히되,
// 행 마크는 그대로 background다 — 칸 키로 활동을 덮으면 헤더와 비콘이 다른 상태를 말한다.
function statusSectionBucket(status: OperationActivityVisual | SideBarStatus): SideBarStatus {
  return status === "background" ? "running" : status;
}

export function StatusSectionSlot({
  theaterId,
  section,
  defaultCollapsed = false,
  children,
}: {
  readonly theaterId: string;
  readonly section: StatusSection;
  readonly defaultCollapsed?: boolean;
  readonly children: ReactNode;
}) {
  const t = useT();
  const empty = section.entries.length === 0;
  const collapsed = useSideBarStatusSectionCollapsed(theaterId, section.status, empty || defaultCollapsed);
  return (
    <li
      className={[
        "side-bar-status-section",
        `side-bar-status-section--${section.status}`,
        empty ? "side-bar-status-section--empty" : "",
      ].filter(Boolean).join(" ")}
    >
      <button
        type="button"
        className={`side-bar-status-header side-bar-status-header--${section.status} side-bar-status-header__toggle`}
        onClick={() => toggleSideBarStatusSectionCollapsed(theaterId, section.status, empty || defaultCollapsed)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t("sidebar.status.expandSection", { label: section.label }) : t("sidebar.status.collapseSection", { label: section.label })}
        title={collapsed ? t("sidebar.status.expand") : t("sidebar.status.collapse")}
      >
        <StatusSectionCollapseArrow collapsed={collapsed} />
        <span className="side-bar-status-header__label">{section.label}</span>
        <span className="side-bar-status-header__count">{section.entries.length}</span>
      </button>
      {!collapsed ? (
        <ol className="side-bar-group-chips" aria-label={t("sidebar.status.sectionOperations", { label: section.label })}>
          {empty ? <li className="side-bar-status-empty-hint">{t("sidebar.status.noOperations")}</li> : children}
        </ol>
      ) : null}
    </li>
  );
}

function StatusRecoveryShelves({
  theaterId,
  minimizedSection,
  dormantSection,
  renderEntry,
}: {
  readonly theaterId: string;
  readonly minimizedSection: StatusSection;
  readonly dormantSection: StatusSection;
  readonly renderEntry: (entry: SideBarEntry, index: number, recovery: "minimized" | "ended") => ReactNode;
}) {
  // 0건 선반은 서지 않는다 — 빈 칸이 축을 설명하던 자리는 퇴역했다.
  if (minimizedSection.entries.length === 0 && dormantSection.entries.length === 0) return null;
  return (
    <li className="side-bar-status-recovery-shelves">
      {minimizedSection.entries.length > 0 ? (
        <section className="triage-side-bar-minimized-shelf side-bar-status-recovery-shelf" onContextMenu={(event) => event.preventDefault()}>
          <ol className="triage-side-bar-minimized-list" aria-label={minimizedSection.label}>
            <StatusSectionSlot theaterId={theaterId} section={minimizedSection}>
              {minimizedSection.entries.map((entry, index) => renderEntry(entry, index, "minimized"))}
            </StatusSectionSlot>
          </ol>
        </section>
      ) : null}
      {dormantSection.entries.length > 0 ? (
        <footer className="triage-side-bar-dormant-shelf side-bar-status-recovery-shelf" onContextMenu={(event) => event.preventDefault()}>
          <ol className="triage-side-bar-dormant-list" aria-label={dormantSection.label}>
            <StatusSectionSlot theaterId={theaterId} section={dormantSection}>
              {dormantSection.entries.map((entry, index) => renderEntry(entry, index, "ended"))}
            </StatusSectionSlot>
          </ol>
        </footer>
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
  onResume,
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
  const mapNarrow = useSideBarMapNarrow();
  const narrow = sideBar.narrow;
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
  // 우클릭 가드는 다음 우클릭에서만 돈다. 마지막 Theater를 잊는 동안 이미 열린 상자는
  // 목록이 비워져도 그대로 남으므로, 그 전환에서 걷는다.
  useEffect(() => {
    if (theaters.length === 0) setNewMenu(null);
  }, [theaters.length]);
  const { resizing, onPointerDown: onResizePointerDown, onDoubleClick: onResizeDoubleClick } = useSideBarResize();
  const collapsedGroups = useCollapsedGroups();
  const collapsedTheaters = useCollapsedTheaters();
  const {
    operationRuntime,
    activeOperationAcknowledged,
    pendingSideBarAddTheater,
    pendingSideBarTheaterLaunch,
    launchMenuRequest,
  } = useConsoleState();
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);

  useLayoutEffect(() => {
    if (!previousCollapsedRef.current && collapsed) focusEdgeDockWhenPanelContainsActiveElement(rootRef.current, ".side-bar-edge-dock");
    previousCollapsedRef.current = collapsed;
  }, [collapsed]);

  const activeOperations = operations.filter((operation) => operation.theaterId === activeTheaterId);
  const activeGroups = groups.filter((group) => group.theaterId === activeTheaterId);
  const minimizedSet = new Set(minimized);
  const collapsedGroupSet = new Set(collapsedGroups);
  // 엔트리는 raw 활동과 마크 축을 싣는다. 섹션 승격은 groupOperationsByStatus가 혼자 소유한다 —
  // 여기서 미리 승격해 두면 그 함수가 같은 계산을 다시 해 값이 겹치고, 겹친 값은 어느 표면에도
  // 드러나지 않아 틀려도 아무 테스트가 죽지 않는다. 그리는 값은 언제나 mark다.
  const allEntries: SideBarEntry[] = sortOperationsByOrder(activeOperations, canvas.operationOrder).map((operation) => {
    const activity = resolveOperationActivity(operation, operationRuntime);
    return {
      operation,
      active: activeOperationId === operation.id,
      minimized: minimizedSet.has(operation.id),
      notificationCount: operationNotifications[operation.id] ? 1 : 0,
      status: activity,
      mark: resolveOperationMarkVisual({ activity, operationId: operation.id, idleArrivalIds }),
    };
  });
  const groupedSections = groupOperations(allEntries, activeGroups, canvas.operationOrder);
  const { living: statusSections, minimized: minimizedSection, dormant: dormantSection } = groupTheaterStatusEntries(
    allEntries,
    minimizedSet,
    getStatusTransitionTick,
    t,
  );
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
  // 재정렬 기준 순서는 인라인 필터와 무관한 활성 Theater 전체 목록이다 — 필터된 표시 목록으로
  // 순서를 커밋하면 숨은 Operation이 operationOrder에서 통째로 탈락해 필터 해제 후 정렬이
  // 영구 유실된다(적대 리뷰 확정 결함). 세그먼트 재배치 헬퍼들은 전체 순서를 전제로
  // hidden 보존을 수행하므로, 표시(allEntries)와 기준(currentOrder)의 원천을 분리한다.
  const currentOrder = sortOperationsByOrder(
    operations.filter((operation) => operation.theaterId === activeTheaterId),
    canvas.operationOrder,
  ).map((operation) => operation.id);
  const statusSignature = operations
    .map((operation) => `${operation.id}:${resolveOperationActivity(operation, operationRuntime)}`)
    .join("\0");
  const renderActiveStatusEntry = (
    entry: SideBarEntry,
    index: number,
    recovery?: "minimized" | "ended",
  ) => {
    const globalIndex = entryIndexById.get(entry.operation.id) ?? index;
    const accentKey = canvas.operationAccent[entry.operation.id] ?? operationAccentFromNode(entry.operation);
    const accentValue = accentKey ? resolveAccentColor(accentKey) : null;
    const groupMark = entry.operation.groupId ? groupMarkByGroupId.get(entry.operation.groupId) ?? null : null;
    const ended = recovery === "ended";
    return (
      <OperationsSideBarChip
        key={entry.operation.id}
        entry={entry}
        index={globalIndex}
        isCloseArmed={armedCloseId === entry.operation.id}
        accentValue={accentValue}
        groupMark={groupMark}
        statusAxis
        statusLanded={recovery !== "ended" && statusLandingIds.has(entry.operation.id)}
        reorderEnabled={false}
        minimizeEnabled={!recovery}
        menuEnabled={!recovery}
        resumeOnActivate={ended}
        dragging={false}
        dragOffsetY={0}
        dropTarget={false}
        onArmClose={armClose}
        onDisarmClose={disarmClose}
        onClose={onClose}
        onMinimize={onMinimize}
        onFocus={ended ? onResume : onFocus}
        onKeyboardMove={keyboardMove}
        onPointerDragStart={beginPointerDrag}
        onOpenAccent={(operationId, anchor, returnFocus, requestedAction) => {
          setActiveContextMenu({ kind: "chip", operationId, anchor, returnFocus, requestedAction });
        }}
        onRename={onRename}
      />
    );
  };

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
      const status = statusSectionBucket(resolveOperationDisplayActivity({
        activity: resolveOperationActivity(operation, operationRuntime),
        operationId: operation.id,
        idleArrivalIds,
      }));
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
  }), [activeTheaterId, collapsed, collapsedGroupSet, collapsedTheaters, idleArrivalIds, operationRuntime, operations, statusAxis]);

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
      operationRuntime,
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


  // 메뉴 주인 조회는 표시 목록이 아니라 전체 목록에서 한다 — 메뉴가 열린 채 필터가 바뀌어
  // 칩이 목록에서 빠져도 메뉴가 close 콜백 없이 즉사하지 않는다.
  const contextMenuOperation = activeContextMenu?.kind === "chip"
    ? operations.find((operation) => operation.id === activeContextMenu.operationId) ?? null
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
  // 등록된 Theater가 없으면 실행할 대상이 없다 — 브라우저 메뉴만 막고 상자는 열지 않는다.
  const openNewMenuAtCursor = (event: React.MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    setActiveContextMenu(null);
    // 캔버스(Map) 쪽에 이미 열린 캔버스 제어 메뉴는 사이드바 <aside> 안에 있지 않아
    // 포털의 mousedown 외부-클릭 닫기가 안 잡는다 — 포털이 구독하는 닫기 신호를 함께 본다.
    window.dispatchEvent(new Event("canvas-context-menu-close"));
    if (theaters.length === 0) {
      setNewMenu(null);
      return;
    }
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
      className={`operations-side-bar ${collapsed ? "is-closed" : "is-expanded"}${sideBar.peeking ? " is-peeking" : ""}${narrow ? " is-narrow" : ""}`}
      ref={rootRef}
      data-sidebar-state={collapsed ? "closed" : "expanded"}
      data-sidebar-axis={statusAxis ? "status" : "group"}
      data-resizing={resizing ? "true" : undefined}
      data-canvas-blocker
      style={{ "--side-bar-width": `${width}px` } as CSSProperties}
      inert={collapsed && !sideBar.peeking}
      onContextMenu={openNewMenuAtCursor}
      onPointerLeave={(event) => {
        // 픽은 포인터가 머무는 동안의 상태다 — 카드를 떠나면 끝난다. 엣지 독으로 되돌아가는
        // 이동만 픽의 연속으로 본다(독 쪽 이탈은 독이 대칭으로 판정한다).
        if (!collapsed || !sideBar.peeking) return;
        const next = event.relatedTarget;
        if (next instanceof Element && next.closest(".panel-edge-dock") !== null) return;
        setSideBarPeeking(false);
      }}
    >
      {!collapsed && theaterError ? <p className="side-bar-theater-error">{theaterError}</p> : null}

      {/* 스트립은 목록의 제목줄이다 — 왼쪽 낱말이 지금 목록을 어떻게 읽는지(Theater 묶음 · 상태별)
          말하고, 오른쪽의 두 토글이 상태별 보기와 레일로 좁히기를 뒤집는다. 상태별 보기는 목록
          전체를 다시 쓰는 하나짜리 세션 스위치라 Theater 행이 아니라 여기 한 번만 선다. Theater가
          없으면 정리할 목록도 없으므로 낱말과 토글도 서지 않는다. 스트립 우단은 패널 자신의 접기
          컨트롤이 맡는다(Periscope — 밴드 토글 퇴역). 레일 상태에서는 낱말이 접히고 토글만 남는다. */}
      <div className="side-bar-top-strip">
        {theaters.length > 0 ? (
          <>
            <span className="side-bar-top-strip-eyebrow">{t(statusAxis ? "sidebar.view.byStatusEyebrow" : "sidebar.view.theaters")}</span>
            <SideBarStatusViewToggle active={statusAxis} />
            <SideBarNarrowToggle narrow={mapNarrow} onToggle={() => setSideBarMapNarrow(!mapNarrow)} />
          </>
        ) : <span className="side-bar-top-strip-spacer" aria-hidden="true" />}
        <SideBarCollapseControl />
      </div>

      {/* 좁힌 레일 — Theater 이니셜 타일이 묶음의 머리에 서고, 그 아래 Operation 타일이 제목 이니셜과
          비콘으로 선다(묶음이 이미 말하는 Theater는 타일이 되풀이하지 않는다). 순서는 펼친 목록과
          같다. 호버로 펼친 목록이 오버레이로 서고, 토글로 다시 넓힌다. */}
      {narrow ? (
        <ol className="side-bar-rail-sections" aria-label={t("sidebar.view.railAria")}>
          {theaters.map((theater) => {
            const theaterCanvas = theater.id === activeTheaterId ? canvas : getTheaterCanvasSnapshot(theater.id);
            const railEntries = theater.id === activeTheaterId ? allEntries : buildTheaterEntries({
              theaterId: theater.id,
              operations,
              operationOrder: theaterCanvas.operationOrder,
              minimizedSet: new Set(theaterCanvas.minimized),
              activeOperationId: null,
              operationNotifications,
              operationRuntime,
            });
            const isActiveTheater = theater.id === activeTheaterId;
            return (
              <li key={theater.id} className={`side-bar-rail-section side-bar-rail-section--theater${isActiveTheater ? " is-active" : ""}`}>
                <button
                  type="button"
                  className="side-bar-rail-theater"
                  aria-label={isActiveTheater ? theater.label : t("sidebar.theater.switchTo", { theater: theater.label })}
                  title={theater.label}
                  aria-current={isActiveTheater ? "true" : undefined}
                  onClick={() => onSelectTheater(theater.id)}
                >
                  <span className="side-bar-theater-anchor" aria-hidden="true">{theaterInitials(theater.label)}</span>
                </button>
                <ol className="side-bar-rail-tiles">
                  {railEntries.map((entry) => (
                    <li key={entry.operation.id}>
                      <button
                        type="button"
                        className={`side-bar-rail-tile${entry.active ? " is-active" : ""}${entry.minimized ? " is-minimized" : ""}`}
                        aria-label={entry.operation.title}
                        title={entry.operation.title}
                        aria-current={entry.active ? "true" : undefined}
                        onClick={() => onFocus(entry.operation.id)}
                      >
                        <span className="side-bar-rail-tile-initials" aria-hidden="true">{theaterInitials(entry.operation.title)}</span>
                        <OperationStatusIcon status={entry.mark ?? entry.status} decorative className="side-bar-rail-tile-beacon" />
                      </button>
                    </li>
                  ))}
                </ol>
              </li>
            );
          })}
        </ol>
      ) : null}

      <div className="side-bar-wide">
      <ol className="operations-side-bar-chips" ref={chipsRef} aria-label={t("sidebar.list.aria")}>
        {theaters.map((theater, theaterIndex) => {
          const isActiveTheater = theater.id === activeTheaterId;
          const theaterOperations = operations.filter((operation) => operation.theaterId === theater.id);
          const showStatusLiveTick = !statusAxis && hasAwaitingOperation(theaterOperations, operationRuntime);
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
              operationRuntime,
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
                onResume={onResume}
                onToggleCollapsed={toggleTheaterSectionCollapsed}
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
                statusActionsOpen={statusActionsOpen}
                showStatusLiveTick={showStatusLiveTick}
                dragging={isTheaterDragging}
                dropTarget={theaterDropBefore}
                dragOffsetY={theaterDragOffsetY}
                onSelectTheater={onSelectTheater}
                onToggleCollapsed={toggleTheaterSectionCollapsed}
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
                {statusAxis ? statusSections.filter((section) => section.entries.length > 0).map((section) => (
                  <StatusSectionSlot
                    key={section.status}
                    theaterId={theater.id}
                    section={section}
                  >
                    {section.entries.map((entry, index) => renderActiveStatusEntry(entry, index))}
                  </StatusSectionSlot>
                )).concat([
                  <StatusRecoveryShelves
                    key="__recovery__"
                    theaterId={theater.id}
                    minimizedSection={minimizedSection}
                    dormantSection={dormantSection}
                    renderEntry={renderActiveStatusEntry}
                  />,
                ]) : groupedSections.map((section) => {
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
      </div>

      {narrow ? null : <SideBarResizeHandle onPointerDown={onResizePointerDown} onDoubleClick={onResizeDoubleClick} />}

      {newMenu ? createPortal(
        <CanvasContextMenu
          key={`${newMenu.anchor.x}:${newMenu.anchor.y}`}
          anchor={newMenu.anchor}
          viewportBounds={newMenu.viewportBounds}
          placement="cursor"
          catalog={catalog}
          canLaunch={canLaunch}
          renderKindIcon={renderKindIcon}
          onLaunchKind={(pluginId, kind, variantLaunch) => { setNewMenu(null); onLaunchKind(pluginId, kind, variantLaunch); }}
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

export function groupTheaterStatusEntries(
  entries: readonly SideBarEntry[],
  minimizedIds: ReadonlySet<string>,
  getTick?: (id: string) => number | undefined,
  t: Translate<CoreMessageKey> = getT("en"),
): {
  readonly living: StatusSection[];
  readonly minimized: StatusSection;
  readonly dormant: StatusSection;
} {
  const dormantEntries = entries
    .filter((entry) => entry.status === "ended")
    .map((entry) => entry.minimized ? { ...entry, minimized: false } : entry);
  const dormantIds = new Set(dormantEntries.map((entry) => entry.operation.id));
  const minimizedEntries = entries.filter((entry) =>
    minimizedIds.has(entry.operation.id) && !dormantIds.has(entry.operation.id));
  const recoveryIds = new Set([
    ...dormantEntries.map((entry) => entry.operation.id),
    ...minimizedEntries.map((entry) => entry.operation.id),
  ]);
  const sections = groupOperationsByStatus(
    entries.filter((entry) => !recoveryIds.has(entry.operation.id)),
    getTick,
    t,
  );
  return {
    living: sections.filter((section) => section.status !== "ended"),
    minimized: {
      status: "minimized",
      label: t("sidebar.status.minimizedShelf"),
      entries: minimizedEntries,
    },
    dormant: {
      status: "ended",
      label: t("sidebar.status.dormantShelf"),
      entries: dormantEntries,
    },
  };
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
    // 섹션 승격은 이 함수 하나가 소유한다 — 도착한 행을 AWAITING 칸에 세워 놓치지 않게 하는 것은
    // 배치의 결정이고, 그 행을 무슨 색으로 그릴지는 마크 축(entry.mark)의 결정이다. 둘을 한 값으로
    // 합치면 색이 칸을 따라가 "사람을 기다리는 중"과 "안 본 채 끝난 것"이 같은 파랑이 된다.
    // background는 실행 중 칸에 앉히되 status는 승격된 활동(background)을 유지한다. 칸 키로
    // 덮으면 마크가 없는 입력에서 행이 채운 running으로 그려진다.
    // 미해소(undefined) 엔트리의 idle 폭백은 직접 구성된 입력에 대한 방어 계약이다.
    entries: entries
      .flatMap((entry) => {
        const display = resolveOperationDisplayActivity({
          activity: entry.status ?? "idle",
          operationId: entry.operation.id,
          idleArrivalIds,
        });
        if (statusSectionBucket(display) !== status) return [];
        return [entry.status === display ? entry : { ...entry, status: display }];
      })
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

export function hasAwaitingOperation(
  operations: readonly OperationNode[],
  operationRuntime: Readonly<Record<string, OperationRuntimeState>>,
): boolean {
  const idleArrivalIds = getIdleArrivalIds();
  return operations.some((operation) =>
    resolveOperationDisplayActivity({
      activity: resolveOperationActivity(operation, operationRuntime),
      operationId: operation.id,
      idleArrivalIds,
    }) === "awaiting");
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
  operationRuntime,
}: TheaterEntryBuildInput): SideBarEntry[] {
  const idleArrivalIds = getIdleArrivalIds();
  return sortOperationsByOrder(
    operations.filter((operation) => operation.theaterId === theaterId),
    operationOrder,
  ).map((operation) => {
    const activity = resolveOperationActivity(operation, operationRuntime);
    return {
      operation,
      active: activeOperationId === operation.id,
      minimized: minimizedSet.has(operation.id),
      notificationCount: operationNotifications[operation.id] ? 1 : 0,
      status: activity,
      mark: resolveOperationMarkVisual({ activity, operationId: operation.id, idleArrivalIds }),
    };
  });
}

function TheaterSectionHeader({
  theater,
  active,
  collapsed,
  statusActionsOpen,
  showStatusLiveTick,
  dragging,
  dropTarget,
  dragOffsetY,
  onSelectTheater,
  onToggleCollapsed,
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

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Enter/Space는 버튼의 기본 동작이 onClick으로 흘려보낸다 — 여기서 다시 처리하면 두 번 발화한다.
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    onContextMenu(event.currentTarget.getBoundingClientRect(), event.currentTarget);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 행 컨트롤(정렬·새 Operation·액션)에서 시작한 포인터는 드래그가 아니다. 활성화 버튼은
    // 행의 본문이므로 배제하지 않는다 — 배제하면 행을 잡아 옮길 수 없다.
    if (event.target instanceof Element && event.target.closest(".side-bar-theater-row-controls")) return;
    onPointerDragStart(event, theater.id);
  };

  const handlePointerUp = () => {
    if (dragging) suppressClickRef.current = true;
  };

  // Theater 선택과 아코디언은 서로 다른 동작이다. 이름은 Theater를 마운트하고 chevron은
  // 활성 여부와 무관하게 이 섹션만 접는다. 둘을 한 버튼에 합치면 같은 위치의 동작이
  // 활성 상태에 따라 바뀌고, 비활성 Theater는 접으려 해도 먼저 마운트해야 한다.
  const select = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (!active) onSelectTheater(theater.id);
  };
  const collapseLabel = collapsed
    ? t("sidebar.theater.expand", { theater: theater.label })
    : t("sidebar.theater.collapse", { theater: theater.label });

  return (
    // 행 자체가 role="button"이면서 상태 정렬·새 Operation·액션 버튼을 품고 있어, 활성화
    // 대상이 둘로 갈리는 중첩 인터랙션이었다(버블된 Enter/Space를 손으로 걸러내던 자리가 그
    // 증거다). 활성화를 형제 버튼으로 꺼내면 행은 컨테이너가 되고 키보드 처리는 버튼이 맡는다.
    <div
      className={headerClassName}
      style={headerStyle}
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
    >
      <button
        type="button"
        className="side-bar-theater-activate"
        aria-haspopup="menu"
        aria-disabled={active ? true : undefined}
        onClick={select}
        onKeyDown={handleKeyDown}
        aria-current={active ? "true" : undefined}
        title={active ? theater.label : t("sidebar.theater.switchTo", { theater: theater.label })}
      >
        <span className="side-bar-theater-anchor" aria-hidden="true">
          {theaterInitials(theater.label)}
          {/* "여기 대기 중"은 Theater 하나의 사실이므로 정체성 표식이 진다. 전역 축 스위치에
              얹으면 어느 Theater인지가 지워진다. */}
          {showStatusLiveTick ? <span className="side-bar-status-axis-live-tick" aria-hidden="true" /> : null}
        </span>
        <span className="side-bar-theater-name">{theater.label}</span>
      </button>
      <span className="side-bar-theater-row-controls" role="group" aria-label={t("sidebar.theater.controlsAria", { theater: theater.label })}>
        <button
          type="button"
          className="side-bar-theater-row-btn side-bar-theater-collapse-btn"
          aria-expanded={!collapsed}
          aria-label={collapseLabel}
          title={collapseLabel}
          onClick={() => onToggleCollapsed(theater.id)}
        >
          <ChevronIcon collapsed={collapsed} />
        </button>
        {/* 축 토글이 빠지면서 이 묶음과 바깥 행 컨트롤이 같은 범위가 됐다. 겹친 두 group을
            그대로 두면 보조기술이 분할 버튼 하나를 두 겹으로 읽으므로, 바깥 하나만 남긴다
            (플러스는 Operation, 케밥은 Theater 동작이라 바깥 라벨이 둘을 함께 덮는다). */}
        <span className="side-bar-theater-split-control">
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
  onResume,
  onToggleCollapsed,
  onOpenActions,
  onOpenLaunch,
  onContextMenu,
  onPointerDragStart,
}: TheaterInactiveSectionProps) {
  const t = useT();
  const sections = groupOperations(entries, groups, []);
  const minimizedSet = new Set(entries.filter((entry) => entry.minimized).map((entry) => entry.operation.id));
  const { living: statusSections, minimized: minimizedSection, dormant: dormantSection } = groupTheaterStatusEntries(
    entries,
    minimizedSet,
    getStatusTransitionTick,
    t,
  );
  const hasCustomGroups = sections.some((section) => section.group !== null);
  const renderInactiveStatusEntry = (
    entry: SideBarEntry,
    index: number,
    recovery?: "minimized" | "ended",
  ) => {
    const accentKey = operationAccent[entry.operation.id] ?? operationAccentFromNode(entry.operation);
    const accentValue = accentKey ? resolveAccentColor(accentKey) : null;
    const ended = recovery === "ended";
    return (
      <OperationsSideBarChip
        key={entry.operation.id}
        entry={entry}
        index={index}
        isCloseArmed={false}
        accentValue={accentValue}
        groupMark={resolveEntryGroupMark(entry, groups)}
        statusAxis
        statusLanded={recovery !== "ended" && statusLandingIds.has(entry.operation.id)}
        reorderEnabled={false}
        minimizeEnabled={false}
        menuEnabled={false}
        resumeOnActivate={ended}
        dragging={false}
        dragOffsetY={0}
        dropTarget={false}
        preview
        onArmClose={() => {}}
        onDisarmClose={() => {}}
        onClose={() => {}}
        onMinimize={() => {}}
        onFocus={ended ? onResume : onFocus}
        onKeyboardMove={() => {}}
        onPointerDragStart={() => {}}
        onOpenAccent={() => {}}
        onRename={() => {}}
      />
    );
  };
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
        statusActionsOpen={statusActionsOpen}
        showStatusLiveTick={showStatusLiveTick}
        dragging={dragging}
        dropTarget={dropBefore}
        dragOffsetY={dragOffsetY}
        onSelectTheater={onSelectTheater}
        onToggleCollapsed={onToggleCollapsed}
        onOpenActions={onOpenActions}
        onOpenLaunch={onOpenLaunch}
        onContextMenu={onContextMenu}
        onPointerDragStart={onPointerDragStart}
      />
      {!collapsed && (statusAxis ? statusSections.length : sections.length) > 0 ? (
        <ol className="side-bar-theater-groups" aria-label={t("sidebar.theater.operationsAria", { theater: theater.label })}>
          {statusAxis ? statusSections.filter((section) => section.entries.length > 0).map((section) => (
            <StatusSectionSlot
              key={section.status}
              theaterId={theater.id}
              section={section}
            >
              {section.entries.map((entry, index) => renderInactiveStatusEntry(entry, index))}
            </StatusSectionSlot>
          )).concat([
            <StatusRecoveryShelves
              key="__recovery__"
              theaterId={theater.id}
              minimizedSection={minimizedSection}
              dormantSection={dormantSection}
              renderEntry={renderInactiveStatusEntry}
            />,
          ]) : sections.map((section) => {
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
