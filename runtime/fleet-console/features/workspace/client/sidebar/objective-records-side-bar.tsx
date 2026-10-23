import { getViewedTheaterId, useViewedTheaterId } from "../../../../core/client/src/integration/viewed-theater.js";
import { ConsoleSectionSlot } from "../../../remote-access/client/console-section-slot.js";
import { openTheaterSystemPrompt, subscribeTheaterSystemPromptChange } from "../../../settings/client/theater-system-prompt-sheet.js";
export { theaterInitials } from "./theater-initials.js";
import { fetchTheaterSystemPrompt, type TheaterSystemPrompt } from "../../../settings/client/execution-settings.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { consoleUseWrapClassName, gestureCallerLabel, getAnyClusterListWrap, getClusterListWrap, getFirstClusterWrap, getTheaterWrap, subscribeConsoleUseGestures } from "../../../console-use/client/gestures.js";
import { createPortal } from "react-dom";

import type { Translate } from "@fleet-console/i18n";
import type { ObjectiveRuntimeState } from "../../../execution/shared/client-contract.js";

import { getT, useT, type CoreMessageKey } from "../../../../core/client/src/i18n/index.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../../../execution/client/objective-marks.js";
import type { ObjectiveGroup, ObjectiveRecord, ObjectiveNotification, TheaterInfo } from "../../../../core/client/src/integration/types.js";
import { useSearchShortcutLabel } from "../../../../core/client/src/integration/shortcuts.js";
import { DirectoryBrowserModal } from "../../../../core/client/src/chrome/components/directory-browser-modal.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { GroupContextMenu } from "./group-context-menu.js";
import { openDefaultNewSession } from "../conversation/new-session-entry.js";
import { objectiveRecordAccentFromNode, resolveAccentColor } from "../objective-accent.js";
import { getTheaterGroupCollapse, toggleTheaterGroupCollapsed, useStoredTheaterRevision } from "./group-collapse-store.js";
import { consumeSideBarAddTheater, openOnboarding, objectiveRecordOrderFromNodes, selectObjective, setObjectiveOrder, sortObjectiveRecordsByOrder } from "../../../../core/client/src/integration/store.js";
import { useFeatureRegistry } from "../../../../core/client/src/integration/feature-registry.js";
import { resolveTheaterInboxLanding, TheaterContributionMenuItems, TheaterContributionRows, useTheaterContributionMark, useTheaterHeaderLive } from "../theater-contributions.js";
import { openTheaterInbox } from "../theater-inbox/store.js";
import { useGlobalSettingsStore } from "../../../settings/client/global-settings-store.js";
import { resolveObjectiveActivity, resolveObjectiveDisplayActivity, resolveObjectiveMarkVisual } from "../../../execution/client/objective-activity.js";
import { applyVisibleReorder, groupDropIndexFromPoint, dropTargetFromPoint, insertIntoSegment, moveByTargetIndex, reorderGroupIds, reorderTheaterIds, reorderWithinSegment, theaterDropIndexFromPoint, type DropSectionInfo } from "./objective-records-side-bar-hit-test.js";
import { useContextMenuKeyboard } from "./context-menu-keyboard.js";
import {
  requestSideBarObjectiveAction,
  subscribeSideBarObjectiveAction,
  type SideBarObjectiveMenuAction,
} from "./interaction.js";
import { ObjectiveRecordsSideBarChip, type SideBarEntry } from "./objective-records-side-bar-chip.js";
import { useAvatarClaims } from "../avatars.js";
import { TheaterAvatar } from "../theater-avatar.js";
import { useLongPress } from "../long-press.js";
import { clampTheaterAlias } from "../theater.js";
import { clusterChipPropsFor } from "./cluster-rows.js";
import { groupClusterHead, planSideBarRows, SideBarClusterRow, SideBarRowFold, SideBarRowZone, theaterClusterHead, type SideBarRowItem } from "./side-bar-cluster-row.js";
import { useClusterIndex } from "../objective-clusters.js";
import { ObjectiveRecordsSideBarGroupHeader, SideBarUngroupedLabel } from "./objective-records-side-bar-group-header.js";
import { SideBarStatusViewToggle, SideBarViewMenu } from "./side-bar-view-controls.js";
import { anchorElementAt, scrollMovesAnchor } from "../anchored-scroll-dismissal.js";
import {
  consumeStatusLandings,
  rowFoldKey,
  setSideBarRowFoldExpanded,
  setTheaterCollapsed,
  getStatusTransitionTick,
  getSideBarStatusSectionCollapsed,
  trackObjectiveActivityTransitions,
  toggleSideBarStatusSectionCollapsed,
  useCollapsedTheaters,
  useSideBarRowFolds,
  useSideBarState,
  useSideBarStatusSectionCollapsed,
  type SideBarStatus,
} from "./objective-records-side-bar-store.js";
import { SideBarResizeHandle, useSideBarResize } from "./side-bar-resize.js";

interface ObjectiveRecordsSideBarProps {
  /** 대화 화면이 그리는 폭 상한(px). 저장된 폭 선호는 그대로 두고 그리는 폭만 깎는다. */
  readonly widthCap?: number;
  /** 맨 위 줄 오른쪽, 접기 컨트롤 앞에 끼우는 단추들(대화 중심 화면의 검색·새로 만들기). */
  readonly topStripTrailing?: ReactNode;
  /**
   * "compact" 는 대화 중심 화면의 맨 위 줄이다 — 낱말·모드 스위치·상태별 보기·접기를 줄에 세우지 않는다. 줄에는 끼운 단추만
   * 서고, 상태별 보기는 각 Theater 머리에서 고른다. 한 번 클릭이 곧바로 연다 — 대화
   * 중심 화면에는 「더블클릭으로 열기」 선호가 없다(누르면 그 대화로 간다).
   */
  readonly topStripVariant?: "compact";
  /** compact 맨 위 줄 가운데에 떠 있는 셸의 기여(대화 중심 화면의 출근한 부관 머리). 자리는 기여가 스스로 잰다. */
  readonly topStripCenter?: ReactNode;
  /** 사이드바 맨 아래에 서는 셸의 기여(호스트 아바타·플러그인 요약 줄). */
  readonly bottomAccessory?: ReactNode;
  readonly theaters: readonly TheaterInfo[];
  readonly objectiveRecords: readonly ObjectiveRecord[];
  readonly groups: readonly ObjectiveGroup[];
  readonly activeObjectiveId: string | null;
  readonly objectiveRecordNotifications: Readonly<Record<string, ObjectiveNotification>>;
  readonly addingTheater: boolean;
  readonly theaterError: string | null;
  readonly onClose: (objectiveId: string) => void;
  readonly onFocus: (objectiveId: string) => void;
  readonly onResume: (objectiveId: string) => void;
  readonly onSetAccent: (objectiveId: string, accentKey: string | null) => void;
  readonly onRename: (objectiveId: string, title: string) => void;
  readonly onSetGroupId: (objectiveId: string, groupId: string | null) => void;
  readonly onCreateGroup: (theaterId: string, name: string, objectiveId?: string) => void;
  readonly onSetGroupColor: (groupId: string, color: string | null) => void;
  readonly onRenameGroup: (groupId: string, name: string) => void;
  readonly onReorderGroups: (orderedGroupIds: readonly string[]) => void;
  readonly onReorderTheaters: (orderedTheaterIds: readonly string[]) => void;
  /** 사령관 별칭 지정 — null 은 해제다. */
  readonly onSetTheaterAlias: (theaterId: string, alias: string | null) => void;
  readonly onUngroupAll: (groupId: string) => void;
  readonly onAddTheater: (path: string) => void;
  readonly onCancelAddTheater: () => void;
  readonly onForgetTheater: (theaterId: string) => void;
}

type ActiveContextMenu =
  | {
      readonly kind: "chip";
      readonly objectiveId: string;
      readonly anchor: DOMRect;
      readonly returnFocus?: HTMLElement | null;
      readonly requestedAction?: SideBarObjectiveMenuAction;
      /** 목표 줄에서 연 메뉴 — 줄 제목은 목표의 것이라 플러그인이 이름 변경을 선언한 줄만 이름 바꾸기를 싣고, 열기는 줄과 같이 선택 알림을 함께 보낸다. */
      readonly fromRow?: boolean;
      /** 목표 줄의 플러그인이 이름 변경을 맡는다고 선언했다 — 줄에서 연 메뉴도 「이름 변경」을 싣는다. */
      readonly renamable?: boolean;
    }
  /** Objective 이 아직 없는 목표 줄(시작 전) — 줄이 선언한 이름 변경·보관만 싣는다. 줄의 동작은 연 순간의 것을 쥔다. */
  | { readonly kind: "row"; readonly clusterId: string; readonly anchor: DOMRect; readonly returnFocus?: HTMLElement | null; readonly renamable: boolean; readonly archive: () => void }
  | { readonly kind: "group"; readonly groupId: string; readonly anchor: DOMRect; readonly returnFocus?: HTMLElement | null }
  /** atCursor — 우클릭으로 열었으면 앵커는 커서 한 점이고 메뉴는 그 자리에 선다. 아니면(키·길게 누르기·「+」) 앵커 아래에 선다. */
  | { readonly kind: "theater"; readonly theaterId: string; readonly anchor: DOMRect; readonly returnFocus?: HTMLElement | null; readonly newGroup?: boolean; readonly atCursor?: boolean };


interface ChipDragState {
  readonly theaterId: string;
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
  /** 뿌리 Objective 이 없는 묶음 줄(시작 전 목표) — 순서 대신 그룹만 옮긴다. */
  readonly moveRow?: (groupId: string | null) => void;
}

interface GroupDragState {
  readonly theaterId: string;
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
  readonly objectiveRecords: readonly ObjectiveRecord[];
  readonly objectiveRecordOrder: readonly string[];
  readonly activeObjectiveId: string | null;
  readonly selectedObjectiveId?: string | null;
  readonly objectiveRecordNotifications: Readonly<Record<string, ObjectiveNotification>>;
  readonly objectiveRecordRuntime: Readonly<Record<string, ObjectiveRuntimeState>>;
}

/** 사령관 카드 둘째 줄의 요약 — 그 Theater 의 지휘관(Objective) 수와 답을 기다리는 수. */
interface TheaterSummary {
  readonly commanders: number;
  readonly waiting: number;
}

/** 머리의 별칭 편집 — 한 번에 한 머리만 그 자리에서 편집한다. 끝낼 때 undefined 는 취소, null 은 해제다. */
interface TheaterAliasEditing {
  readonly editingAlias: boolean;
  readonly onStartAliasEdit: (theaterId: string) => void;
  readonly onFinishAliasEdit: (theaterId: string, alias: string | null | undefined) => void;
}

interface TheaterSectionHeaderProps extends TheaterAliasEditing {
  readonly theater: TheaterInfo;
  readonly active: boolean;
  readonly collapsed: boolean;
  readonly summary: TheaterSummary;
  readonly statusAxis: boolean;
  readonly showStatusLiveTick: boolean;
  readonly dragging: boolean;
  readonly dropTarget: boolean;
  readonly dragOffsetY: number;
  /** 활성 Theater 머리를 눌렀을 때 — 그 Theater 의 Inbox 를 연다(비활성 머리는 전환만 한다). */
  readonly onOpenInbox: (theater: TheaterInfo, returnFocus: HTMLElement | null) => void;
  readonly onToggleCollapsed: (theaterId: string) => void;
  /** 이 머리의 Theater 메뉴를 연다 — 우클릭은 커서 자리(atCursor), 키·길게 누르기는 앵커 아래. */
  readonly onContextMenu: (anchor: DOMRect, returnFocus: HTMLElement | null, atCursor: boolean) => void;
  /** 열린 Theater 메뉴가 이 머리를 대상으로 한다 — 활성이 아닌 Theater 에서도 열리므로 머리가 대상을 말한다. */
  readonly menuTarget: boolean;
  readonly onPointerDragStart: (event: ReactPointerEvent<HTMLDivElement>, theaterId: string) => void;
  /** 이 Theater 가 목표 줄의 묶음 머리일 때 — `theaterClusterHead`. */
  readonly clusterHead?: { readonly hiddenClusterIds: readonly string[]; readonly anyList: boolean } | undefined;
}

interface TheaterActionsMenuProps {
  readonly theater: TheaterInfo;
  readonly active: boolean;
  readonly groupCount: number;
  readonly anchor: DOMRect;
  /** 앵커가 커서 한 점이다 — 메뉴 윗변을 커서에 두고, 아래가 모자라면 커서 위로 뒤집는다. */
  readonly atCursor?: boolean;
  readonly onCreateGroup: (name: string) => void;
  readonly onForgetTheater: () => void;
  readonly onOpenSystemPrompt: () => void;
  readonly onEditAlias: () => void;
  readonly onClose: () => void;
  /** 「+」 메뉴의 「새 그룹…」에서 열었으면 이름 입력부터 연다. */
  readonly startWithNewGroup?: boolean;
}

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
        <ol className="side-bar-group-chips" aria-label={t("sidebar.status.sectionObjectiveRecords", { label: section.label })}>
          {empty ? <li className="side-bar-status-empty-hint">{t("sidebar.status.noObjectiveRecords")}</li> : children}
        </ol>
      ) : null}
    </li>
  );
}

function StatusRecoveryShelves({
  theaterId,
  dormantSection,
  renderEntry,
}: {
  readonly theaterId: string;
  readonly dormantSection: StatusSection;
  readonly renderEntry: (entry: SideBarEntry, index: number, recovery: "ended") => ReactNode;
}) {
  // 0건 선반은 서지 않는다 — 빈 칸이 축을 설명하던 자리는 퇴역했다.
  if (dormantSection.entries.length === 0) return null;
  return (
    <li className="side-bar-status-recovery-shelves">
      <footer className="side-bar-recovery-dormant-shelf side-bar-status-recovery-shelf" onContextMenu={(event) => event.preventDefault()}>
        <ol className="side-bar-recovery-dormant-list" aria-label={dormantSection.label}>
          <StatusSectionSlot theaterId={theaterId} section={dormantSection}>
            {dormantSection.entries.map((entry, index) => renderEntry(entry, index, "ended"))}
          </StatusSectionSlot>
        </ol>
      </footer>
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
export function ObjectiveRecordsSideBar({
  theaters,
  objectiveRecords,
  groups,
  activeObjectiveId,
  objectiveRecordNotifications,
  addingTheater,
  theaterError,
  onClose,
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
  onSetTheaterAlias,
  onUngroupAll,
  onAddTheater,
  onCancelAddTheater,
  onForgetTheater,
  widthCap,
  topStripTrailing,
  topStripVariant,
  topStripCenter,
  bottomAccessory,
}: ObjectiveRecordsSideBarProps) {
  const t = useT();
  const searchShortcut = useSearchShortcutLabel();
  const rootRef = useRef<HTMLElement | null>(null);
  const chipsRef = useRef<HTMLOListElement | null>(null);
  const sideBar = useSideBarState();
  // 좁은 창(대화 화면)에서는 아바타만 남은 열로 물러난다 — 사람이 정한 폭은 그대로 기억된다.
  const compact = sideBar.compact && topStripVariant === "compact";
  const width = compact ? sideBar.compactWidth : widthCap === undefined ? sideBar.width : Math.min(sideBar.width, widthCap);
  const rowFolds = useSideBarRowFolds();
  const viewedTheaterId = useViewedTheaterId();
  const objectiveRecordAccent = Object.assign({}, ...theaters.map((theater) => getTheaterGroupCollapse(theater.id).objectiveRecordAccent)) as Readonly<Record<string, string>>;
  // 비활성 Theater 묶음은 렌더 중 저장값(접힘·액센트)을 읽는다 — 그 값이 바뀔 때 다시 그린다.
  useStoredTheaterRevision();
  const statusTheaterIds = new Set(theaters.filter((theater) => getTheaterGroupCollapse(theater.id).statusAxis).map((theater) => theater.id));
  const statusAxisKey = [...statusTheaterIds].join("\0");
  const statusLandingTimeoutsRef = useRef<Set<number>>(new Set());
  const didMountStatusLandingRef = useRef(false);
  const [statusLandingIds, setStatusLandingIds] = useState<ReadonlySet<string>>(new Set());
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const entriesRef = useRef<SideBarEntry[]>([]);
  const groupsRef = useRef(groups);
  const currentOrderRef = useRef<string[]>([]);
  const dropSectionsRef = useRef<DropSectionInfo[]>([]);
  const orderedGroupIdsRef = useRef<string[]>([]);
  const orderedTheaterIdsRef = useRef<string[]>([]);
  const onSetGroupIdRef = useRef(onSetGroupId);
  const onReorderGroupsRef = useRef(onReorderGroups);
  const onReorderTheatersRef = useRef(onReorderTheaters);
  const contextMenuReturnFocusRef = useRef<HTMLElement | null>(null);
  const [activeContextMenu, setActiveContextMenu] = useState<ActiveContextMenu | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [aliasEditingTheaterId, setAliasEditingTheaterId] = useState<string | null>(null);
  const { resizing, onPointerDown: onResizePointerDown } = useSideBarResize();
  const collapsedGroups = theaters.flatMap((theater) => getTheaterGroupCollapse(theater.id).collapsedGroups);
  const collapsedTheaters = useCollapsedTheaters();
  const {
    objectiveRecordRuntime,
    activeObjectiveAcknowledged,
    selectedObjectiveId,
    pendingSideBarAddTheater,
  } = useConsoleState();
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  // 묶음 띠(임무 점)는 지휘관 행의 셋째 줄에 선다. 구성원 행은 스토어의 기본 목록에 없어 여기서 거를 것이 없다.
  const clusterIndex = useClusterIndex();
  // 몽글 아바타 처음 배정 — 사이드바 한 곳이 Theater·Objective 이 처음 보일 때 묶음째 뽑아 저장한다.
  useAvatarClaims();
  const registry = useFeatureRegistry();
  // 「더블클릭으로 열기」 — 켜면 칩·목표 줄의 한 번 클릭은 열지 않고 고른다. 무대는 그대로 두고 문맥(목표 등)만 옮긴다:
  // 코어의 선택 상태가 바뀌고, 열린 레일이 곧바로 따라오도록 지도 선택 알림도 함께 보낸다. 사이드바 밖의 경로는 그대로 연다.
  const doubleClickOpenSetting = useGlobalSettingsStore().state?.sideBarDoubleClickOpen === true;
  const doubleClickOpen = topStripVariant !== "compact" && doubleClickOpenSetting;
  const selectFromSideBar = useCallback((objectiveId: string) => {
    selectObjective(objectiveId);
    registry.objectives.objectiveRecordSelected(objectiveId);
  }, [registry.providers]);
  const onSelect = doubleClickOpen ? selectFromSideBar : undefined;
  // 끄면 남은 선택도 함께 거둔다 — 보이지 않는 선택이 문맥을 붙들고 있으면 안 된다.
  useEffect(() => {
    if (!doubleClickOpen && selectedObjectiveId !== null) selectObjective(null);
  }, [doubleClickOpen, selectedObjectiveId]);


  const activeObjectiveRecords = objectiveRecords;
  const activeObjectiveOrder = objectiveRecordOrderFromNodes(activeObjectiveRecords);
  const activeGroups = groups;
  const collapsedGroupSet = new Set(collapsedGroups);
  // 엔트리는 raw 활동과 마크 축을 싣는다. 섹션 승격은 groupObjectiveRecordsByStatus가 혼자 소유한다 —
  // 여기서 미리 승격해 두면 그 함수가 같은 계산을 다시 해 값이 겹치고, 겹친 값은 어느 표면에도
  // 드러나지 않아 틀려도 아무 테스트가 죽지 않는다. 그리는 값은 언제나 mark다.
  const allEntries: SideBarEntry[] = sortObjectiveRecordsByOrder(activeObjectiveRecords, activeObjectiveOrder).map((objectiveRecord) => {
    const activity = resolveObjectiveActivity(objectiveRecord, objectiveRecordRuntime);
    return {
      objectiveRecord,
      active: activeObjectiveId === objectiveRecord.id,
      selected: doubleClickOpen && selectedObjectiveId === objectiveRecord.id,
      notificationCount: objectiveRecordNotifications[objectiveRecord.id] ? 1 : 0,
      status: activity,
      mark: resolveObjectiveMarkVisual({ activity, objectiveId: objectiveRecord.id, idleArrivalIds }),
    };
  });
  const groupedSections = groupObjectiveRecords(allEntries, activeGroups, activeObjectiveOrder);
  // 그룹 축에서는 묶음 줄(목표)이 뿌리·구성원 칩을 접고 제자리에 선다. 결정 요청·오늘은 맨 위 구역으로 올라간다.
  const theaterPlans = theaters.map((theater) => ({ theaterId: theater.id, plan: planSideBarRows(groupObjectiveRecords(allEntries.filter((entry) => entry.objectiveRecord.theaterId === theater.id), groups.filter((group) => group.theaterId === theater.id), []), clusterIndex, theater.id) }));
  // 고른 목표나 활성 Objective 을 품은 줄이 「시작 전」·「완료」 접기 안에 있으면(팔레트·캡션·전환 목록·reveal·직접 활성화) 그 접기를
  // 펼치고 줄이 보이게 스크롤한다. 그 줄이나 그 줄이 든 접기(그룹 이동)가 바뀔 때 한 번만 — 그 뒤 사람이 접기를 닫으면 그대로 둔다.
  const selectedFolded = theaterPlans.flatMap(({ theaterId, plan }) => ([["fresh", plan.folds], ["done", plan.doneFolds]] as const).flatMap(([kind, folds]) => [...folds].flatMap(([groupId, items]) => items.filter((item) => item.row.selected || item.anchor?.active || item.fold.some((entry) => entry.active)).map((item) => ({ kind, theaterId, groupId, id: item.layout.cluster.id })))))[0] ?? null;
  const selectedFoldedKey = selectedFolded ? `${selectedFolded.kind}\u0000${selectedFolded.theaterId}\u0000${selectedFolded.groupId ?? ""}\u0000${selectedFolded.id}` : null;
  // 「완료」 접기에 든 뿌리 Objective — 칩 자리가 비었으므로 키보드 이동의 보이는 순서에서도 뺀다(안 보이는 엔트리를 건너느라 이동이 멈춰 보이지 않게).
  const doneFoldedAnchorIds = new Set(theaterPlans.flatMap(({ plan }) => [...plan.doneFolds.values()].flat().flatMap((item) => (item.anchor ? [item.anchor.objectiveRecord.id] : []))));
  const { living: statusSections, dormant: dormantSection } = groupTheaterStatusEntries(allEntries, getStatusTransitionTick, t);
  const clusterPropsFor = (entry: SideBarEntry) => clusterChipPropsFor(entry, clusterIndex);
  // STATUS 축 렌더는 entry/그룹 조회가 칩마다 반복되므로 O(n²)를 피해 Map으로 한 번만 인덱싱한다.
  const entryIndexById = new Map(allEntries.map((entry, index) => [entry.objectiveRecord.id, index] as const));
  const groupMarkByGroupId = new Map(activeGroups.map((group) => {
    const color = resolveAccentColor(group.color);
    return [group.id, color ? { name: group.name, color } : null] as const;
  }));
  const hasCustomGroups = groupedSections.some((section) => section.group !== null);
  const orderedGroupIds = groupedSections.flatMap((section) => section.groupId ? [section.groupId] : []);
  const visibleEntries = groupedSections.flatMap((section) =>
    collapsedGroupSet.has(section.groupId ?? "") ? [] : section.entries.filter((entry) => !doneFoldedAnchorIds.has(entry.objectiveRecord.id)),
  );
  // 재정렬 기준 순서는 인라인 필터와 무관한 활성 Theater 전체 목록이다 — 필터된 표시 목록으로
  // 순서를 커밋하면 숨은 Objective이 objectiveRecordOrder에서 통째로 탈락해 필터 해제 후 정렬이
  // 영구 유실된다(적대 리뷰 확정 결함). 세그먼트 재배치 헬퍼들은 전체 순서를 전제로
  // hidden 보존을 수행하므로, 표시(allEntries)와 기준(currentOrder)의 원천을 분리한다.
  const currentOrder = sortObjectiveRecordsByOrder(
    objectiveRecords,
    activeObjectiveOrder,
  ).map((objectiveRecord) => objectiveRecord.id);
  const statusSignature = objectiveRecords
    .map((objectiveRecord) => `${objectiveRecord.id}:${resolveObjectiveActivity(objectiveRecord, objectiveRecordRuntime)}`)
    .join("\0");
  const renderActiveStatusEntry = (
    entry: SideBarEntry,
    index: number,
    recovery?: "ended",
  ) => {
    const globalIndex = entryIndexById.get(entry.objectiveRecord.id) ?? index;
    const accentKey = objectiveRecordAccent[entry.objectiveRecord.id] ?? objectiveRecordAccentFromNode(entry.objectiveRecord);
    const accentValue = accentKey ? resolveAccentColor(accentKey) : null;
    const groupMark = entry.objectiveRecord.groupId ? groupMarkByGroupId.get(entry.objectiveRecord.groupId) ?? null : null;
    const ended = recovery === "ended";
    // 종료 선반은 다시 시작하는 자리라 결정 요청 표식·검토 대기 얼굴은 싣지 않는다(묶음 장식을 통째로 빼던 자리).
    // 단계 수만 살린다 — 집계는 다른 칩과 같은 clusterChipPropsFor.
    const cluster = clusterPropsFor(entry);
    const recoveryCluster = cluster?.progressLabel ? { strip: cluster.strip, progressLabel: cluster.progressLabel } : null;
    return (
      <ObjectiveRecordsSideBarChip
        key={entry.objectiveRecord.id}
        entry={entry}
        cluster={recovery ? recoveryCluster : cluster}
        index={globalIndex}
        accentValue={accentValue}
        groupMark={groupMark}
        statusAxis
        statusLanded={recovery !== "ended" && statusLandingIds.has(entry.objectiveRecord.id)}
        reorderEnabled={false}
        menuEnabled={!recovery}
        resumeOnActivate={ended}
        {...(onSelect ? { onSelect } : {})}
        dragging={false}
        dragOffsetY={0}
        dropTarget={false}
        onClose={onClose}
        onFocus={ended ? onResume : onFocus}
        onKeyboardMove={keyboardMove}
        onPointerDragStart={beginPointerDrag}
        onOpenAccent={(objectiveId, anchor, returnFocus, requestedAction) => {
          setActiveContextMenu({ kind: "chip", objectiveId, anchor, returnFocus, requestedAction });
        }}
        onRename={onRename}
      />
    );
  };


  useEffect(() => {
    if (!selectedFolded || statusTheaterIds.has(selectedFolded.theaterId)) return;
    setSideBarRowFoldExpanded(selectedFolded.kind, selectedFolded.theaterId, selectedFolded.groupId, true);
    if (selectedFolded.groupId && collapsedGroupSet.has(selectedFolded.groupId)) toggleTheaterGroupCollapsed(selectedFolded.theaterId, selectedFolded.groupId);
    const frame = window.requestAnimationFrame(() => {
      chipsRef.current?.querySelector<HTMLElement>(`[data-cluster-row-id="${CSS.escape(selectedFolded.id)}"]`)?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedFoldedKey, statusAxisKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 목표를 고른 입구(팔레트·빈 상태 바로가기·다른 Theater 줄)는 고르는 순간 사라져 포커스가 BODY 로 빠진다.
  // 그때만 사이드바에 보이는 그 목표 줄이 받는다.
  const selectedRowId = clusterIndex.rows.find((layout) => layout.cluster.row?.selected)?.cluster.id ?? null;
  useEffect(() => {
    if (!selectedRowId) return;
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active !== null && active !== document.body && active.isConnected) return;
      chipsRef.current?.querySelector<HTMLElement>(`[data-cluster-row-id="${CSS.escape(selectedRowId)}"] .side-bar-cluster-row-main`)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedRowId]);

  useEffect(() => subscribeSideBarObjectiveAction((request) => {
    const objectiveRecord = objectiveRecords.find((candidate) => candidate.id === request.objectiveId);
    if (!objectiveRecord) return false;
    if (collapsedTheaters.includes(objectiveRecord.theaterId)) {
      setTheaterCollapsed(objectiveRecord.theaterId, false);
      return false;
    }
    // 상태축에서는 그룹 접힘이 배치에 영향을 주지 않는다 — 여기서 펼치면 사용자의 그룹축 설정만 조용히 바뀐다.
    if (getTheaterGroupCollapse(objectiveRecord.theaterId).statusAxis) {
      const status = resolveObjectiveDisplayActivity({
        activity: resolveObjectiveActivity(objectiveRecord, objectiveRecordRuntime),
        objectiveId: objectiveRecord.id,
        idleArrivalIds,
      });
      if (getSideBarStatusSectionCollapsed(objectiveRecord.theaterId, status, false)) {
        toggleSideBarStatusSectionCollapsed(objectiveRecord.theaterId, status, false);
      }
      return false;
    }
    if (objectiveRecord.groupId && collapsedGroupSet.has(objectiveRecord.groupId)) {
      toggleTheaterGroupCollapsed(objectiveRecord.theaterId, objectiveRecord.groupId);
      return false;
    }
    return false;
  }), [collapsedGroupSet, collapsedTheaters, idleArrivalIds, objectiveRecordRuntime, objectiveRecords, statusAxisKey]);


  // App의 동기 store 구독이 렌더 배칭 전의 각 전이를 기록한다. 아래 백업 호출은 App 없는
  // jsdom 경로를 자기완결적으로 유지하고, pending landing만 사이드바 표시 수명주기로 소비한다.
  useEffect(() => {
    trackObjectiveActivityTransitions({
      objectiveRecords,
      objectiveRecordRuntime,
          activeObjectiveId,
      activeObjectiveAcknowledged,
    });
    const sortedObjectiveIds = new Set(objectiveRecords.filter((objectiveRecord) => statusTheaterIds.has(objectiveRecord.theaterId)).map((objectiveRecord) => objectiveRecord.id));
    const landedIds = consumeStatusLandings().filter((id) => sortedObjectiveIds.has(id));
    if (!didMountStatusLandingRef.current) {
      didMountStatusLandingRef.current = true;
      return;
    }
    if (statusTheaterIds.size === 0) {
      for (const timeoutId of statusLandingTimeoutsRef.current) window.clearTimeout(timeoutId);
      statusLandingTimeoutsRef.current.clear();
      setStatusLandingIds((current) => current.size === 0 ? current : new Set());
      return;
    }
    // 꺼진 Theater 의 지난 도착 표식은 다른 Theater 의 활성 정렬에 붙들려 남지 않는다.
    setStatusLandingIds((current) => {
      const next = new Set([...current].filter((id) => sortedObjectiveIds.has(id)));
      return next.size === current.size ? current : next;
    });
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
  // statusSignature is the stable primitive dependency for the objectiveRecord/status map assembled above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusAxisKey, statusSignature, activeObjectiveId, activeObjectiveAcknowledged]);

  useEffect(() => () => {
    for (const timeoutId of statusLandingTimeoutsRef.current) window.clearTimeout(timeoutId);
    statusLandingTimeoutsRef.current.clear();
  }, []);



  // 메뉴 주인 조회는 표시 목록이 아니라 전체 목록에서 한다 — 메뉴가 열린 채 필터가 바뀌어
  // 칩이 목록에서 빠져도 메뉴가 close 콜백 없이 즉사하지 않는다.
  const contextMenuObjective = activeContextMenu?.kind === "chip"
    ? objectiveRecords.find((objectiveRecord) => objectiveRecord.id === activeContextMenu.objectiveId) ?? null
    : null;
  const contextMenuGroup = activeContextMenu?.kind === "group"
    ? groups.find((g) => g.id === activeContextMenu.groupId) ?? null
    : null;
  const theaterMenuTargetId = activeContextMenu?.kind === "theater" ? activeContextMenu.theaterId : null;
  const contextMenuTheater = activeContextMenu?.kind === "theater"
    ? theaters.find((theater) => theater.id === activeContextMenu.theaterId) ?? null
    : null;

  const keyboardMove = (objectiveId: string, direction: -1 | 1) => {
    const objectiveRecord = objectiveRecords.find((candidate) => candidate.id === objectiveId);
    if (!objectiveRecord || getTheaterGroupCollapse(objectiveRecord.theaterId).statusAxis) return;
    const entries = visibleEntries.filter((entry) => entry.objectiveRecord.theaterId === objectiveRecord.theaterId);
    const index = entries.findIndex((entry) => entry.objectiveRecord.id === objectiveId);
    if (index < 0) return;
    const targetIndex = Math.max(0, Math.min(entries.length - 1, index + direction));
    if (targetIndex === index) return;
    const order = currentOrder.filter((id) => objectiveRecords.some((candidate) => candidate.id === id && candidate.theaterId === objectiveRecord.theaterId));
    const visibleOrder = entries.map((entry) => entry.objectiveRecord.id);
    setObjectiveOrder(objectiveRecord.theaterId, applyVisibleReorder(order, visibleOrder, moveByTargetIndex(visibleOrder, objectiveId, targetIndex)));
  };

  // entryIds는 collapsed 그룹도 실제 멤버를 담는다. dropTargetFromPoint는 DOM 기반이라 collapsed에서
  // index 0을 early-return하며 entryIds를 쓰지 않고, insertIntoSegment는 멤버 순서가 있어야 드롭 위치를
  // 올바르게 계산한다(빈 배열이면 멤버를 가진 collapsed 그룹에 드롭한 chip이 그룹 끝으로 밀린다).
  const dropSections: DropSectionInfo[] = groupedSections.map((section) => ({
    groupId: section.groupId,
    entryIds: section.entries.map((e) => e.objectiveRecord.id),
  }));

  // window 이벤트 핸들러에서 commit 시점 최신값을 읽기 위해 매 렌더 ref를 동기화한다.
  useEffect(() => {
    entriesRef.current = allEntries;
    groupsRef.current = groups;
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
    const current = dragRef.current;
    if (current?.kind === "chip" && getTheaterGroupCollapse(current.theaterId).statusAxis) updateDrag(null);
  }, [statusAxisKey]);

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
        const dropTarget = dropTargetFromPoint(event.clientY, groupObjectiveRecords(entriesRef.current.filter((entry) => entry.objectiveRecord.theaterId === current.theaterId), groupsRef.current.filter((group) => group.theaterId === current.theaterId), []).map((section) => ({ groupId: section.groupId, entryIds: section.entries.map((entry) => entry.objectiveRecord.id) })), chipsRef.current?.querySelector<HTMLOListElement>(`[data-theater-id="${CSS.escape(current.theaterId)}"] > .side-bar-theater-groups`) ?? null, current.sourceId);
        updateDrag({ ...current, currentY: event.clientY, dragging: true, dropIndex: dropTarget.index, dropGroupId: dropTarget.groupId });
        return;
      }
      if (current.kind === "theater") {
        const dropIndex = theaterDropIndexFromPoint(event.clientY, orderedTheaterIdsRef.current, chipsRef.current, current.sourceTheaterId);
        updateDrag({ ...current, currentY: event.clientY, dragging: true, dropIndex });
        return;
      }
      const dropIndex = groupDropIndexFromPoint(event.clientY, orderedGroupIdsRef.current.filter((id) => groupsRef.current.some((group) => group.id === id && group.theaterId === current.theaterId)), chipsRef.current?.querySelector<HTMLOListElement>(`[data-theater-id="${CSS.escape(current.theaterId)}"] > .side-bar-theater-groups`) ?? null, current.sourceGroupId);
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
        const groupIds = orderedGroupIdsRef.current.filter((id) => groupsRef.current.some((group) => group.id === id && group.theaterId === snap.theaterId));
        const nextGroupIds = reorderGroupIds(groupIds, snap.sourceGroupId, snap.dropIndex);
        if (nextGroupIds.join("\0") === groupIds.join("\0")) return;
        onReorderGroupsRef.current(nextGroupIds);
        return;
      }

      const { sourceId, sourceGroupId, dropIndex, dropGroupId } = snap;
      if (snap.moveRow) {
        if (dropGroupId !== sourceGroupId) snap.moveRow(dropGroupId);
        return;
      }
      const sections = groupObjectiveRecords(entriesRef.current.filter((entry) => entry.objectiveRecord.theaterId === snap.theaterId), groupsRef.current.filter((group) => group.theaterId === snap.theaterId), []).map((section) => ({ groupId: section.groupId, entryIds: section.entries.map((entry) => entry.objectiveRecord.id) }));
      const allIds = currentOrderRef.current.filter((id) => entriesRef.current.some((entry) => entry.objectiveRecord.id === id && entry.objectiveRecord.theaterId === snap.theaterId));

      if (dropGroupId !== sourceGroupId) {
        const dropSection = sections.find((s) => s.groupId === dropGroupId);
        const dropSegmentIds = dropSection?.entryIds ?? [];
        setObjectiveOrder(snap.theaterId, insertIntoSegment(allIds, sourceId, dropIndex, dropSegmentIds));
        onSetGroupIdRef.current(sourceId, dropGroupId);
        return;
      }

      const sourceSection = sections.find((s) => s.groupId === sourceGroupId);
      const segmentIds = sourceSection?.entryIds ?? [];
      const currentLocalIndex = segmentIds.indexOf(sourceId);
      if (currentLocalIndex === -1 || dropIndex === currentLocalIndex) return;
      const nextOrder = reorderWithinSegment(allIds, sourceId, dropIndex, segmentIds);
      setObjectiveOrder(snap.theaterId, nextOrder);
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

  // interactive: 누르면 끌기 대신 제 동작을 하는 자손. 칩은 안의 버튼(보관)이 그렇다.
  const beginPointerDrag = (event: ReactPointerEvent<HTMLLIElement>, objectiveId: string, interactive = "button") => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(interactive)) return;
    setActiveContextMenu(null);
    const sourceEntry = allEntries.find((e) => e.objectiveRecord.id === objectiveId);
    if (!sourceEntry || getTheaterGroupCollapse(sourceEntry.objectiveRecord.theaterId).statusAxis) return;
    const sourceGroupId = sourceEntry.objectiveRecord.groupId ?? null;
    updateDrag({
      kind: "chip",
      theaterId: sourceEntry!.objectiveRecord.theaterId,
      sourceId: objectiveId,
      sourceGroupId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentY: event.clientY,
      dragging: false,
      dropIndex: currentOrder.indexOf(objectiveId),
      dropGroupId: sourceGroupId,
    });
  };

  const beginRowPointerDrag = (event: ReactPointerEvent<HTMLLIElement>, item: SideBarRowItem) => {
    // 줄은 본문 전체가 여는 버튼이다 — 칩처럼 줄 어디를 잡아도 끌리고, 버튼이 되는 검토 글리프만 뺀다.
    if (item.anchor) {
      beginPointerDrag(event, item.anchor.objectiveRecord.id, ".status-glyph.is-actionable");
      return;
    }
    const moveRow = item.row.moveToGroup;
    if (getTheaterGroupCollapse(item.layout.cluster.theaterId).statusAxis || !moveRow || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(".status-glyph.is-actionable")) return;
    setActiveContextMenu(null);
    updateDrag({
      kind: "chip",
      theaterId: item.layout.cluster.theaterId,
      sourceId: `row:${item.layout.cluster.id}`,
      sourceGroupId: item.row.groupId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentY: event.clientY,
      dragging: false,
      dropIndex: 0,
      dropGroupId: item.row.groupId,
      moveRow,
    });
  };
  const openRowContextMenu = (item: SideBarRowItem, anchor: DOMRect, returnFocus: HTMLElement | null) => {
    if (!item.anchor) {
      // 뿌리가 없는 줄은 플러그인이 보관을 선언했을 때만 메뉴가 선다 — 뿌리 있는 줄 메뉴의 이름 바꾸기·보관 칸과 같은 모양이다.
      const archive = item.row.archive;
      if (!archive) return;
      setActiveContextMenu({ kind: "row", clusterId: item.layout.cluster.id, anchor, returnFocus, renamable: item.row.rename !== undefined, archive });
      return;
    }
    setActiveContextMenu({ kind: "chip", objectiveId: item.anchor.objectiveRecord.id, anchor, returnFocus, fromRow: true, renamable: item.row.rename !== undefined });
  };
  const renderRow = (item: SideBarRowItem, promoted: boolean) => {
    const sourceId = item.anchor?.objectiveRecord?.id ?? `row:${item.layout.cluster.id}`;
    const rowDragging = drag?.kind === "chip" && drag.sourceId === sourceId && drag.dragging;
    const accentKey = item.anchor ? objectiveRecordAccent[item.anchor.objectiveRecord.id] ?? objectiveRecordAccentFromNode(item.anchor.objectiveRecord) : null;
    return (
      <SideBarClusterRow
        key={item.layout.cluster.id}
        item={item}
        groupDot={promoted && item.row.groupId ? groupMarkByGroupId.get(item.row.groupId) ?? null : null}
        accentValue={accentKey ? resolveAccentColor(accentKey) : null}
        dragging={rowDragging}
        dragOffsetY={rowDragging ? drag.currentY - drag.startY : 0}
        onFocus={onFocus}
        {...(onSelect ? { onSelect } : {})}
        onPointerDragStart={promoted ? undefined : beginRowPointerDrag}
        onContextMenu={openRowContextMenu}
      />
    );
  };

  const beginGroupPointerDrag = (event: ReactPointerEvent<HTMLDivElement>, groupId: string) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    if (!orderedGroupIds.includes(groupId)) return;
    setActiveContextMenu(null);
    updateDrag({
      kind: "group",
      theaterId: groups.find((group) => group.id === groupId)!.theaterId,
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
    const orderedTheaterIds = theaters.map((theater) => theater.id);
    if (!orderedTheaterIds.includes(theaterId)) return;
    setActiveContextMenu(null);
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

  // Theater 메뉴는 누른 그 Theater 를 대상으로 한다(전환하지 않는다). 길게 누르기는 손가락이 아직 머리 위에 있을 때 열리므로,
  // 그 누름이 세워 둔 끌기 대기를 거둔다 — 메뉴가 열린 뒤 손가락이 미끄러져도 Theater 가 옮겨지지 않는다.
  const openTheaterMenu = (theaterId: string, anchor: DOMRect, returnFocus: HTMLElement | null, atCursor: boolean) => {
    if (dragRef.current && !dragRef.current.dragging) updateDrag(null);
    setActiveContextMenu({ kind: "theater", theaterId, anchor, returnFocus, atCursor });
  };

  const openTheaterBrowser = () => {
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

  // 사이드바 빈 영역 우클릭 = 맨 위 「+」와 같은 새 세션 화면. chip/그룹 헤더는 자체 우클릭 핸들러가 preventDefault()를
  // 호출하므로(버블로 도달 시 defaultPrevented=true) 그쪽 메뉴를 지키고 여기서는 무시한다.
  const openNewSessionAtCursor = (event: React.MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    setActiveContextMenu(null);
    openDefaultNewSession();
  };

  const closeActiveContextMenu = useCallback(() => {
    const returnFocus = activeContextMenu?.returnFocus ?? null;
    setActiveContextMenu(null);
    if (document.hasFocus()) returnFocus?.focus();
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

  // 활성 Theater 머리 — 그 Theater 의 Inbox. 첫 칸은 기여가 정한다(예: 자율 운영이 켜졌으면 사령관 기록). 아무도 정하지 않으면
  // 호스트의 시스템 프롬프트 칸이다(「시스템 프롬프트…」 항목과 같은 길이라 폰·대화 중심 화면도 그 경로를 그대로 탄다).
  const openTheaterHeaderInbox = (theater: TheaterInfo, returnFocus: HTMLElement | null) => {
    setActiveContextMenu(null);
    const landing = resolveTheaterInboxLanding(registry.theaterContributions, theater.id);
    if (landing) openTheaterInbox({ theaterId: theater.id, ...landing, returnFocus });
    else openTheaterSystemPrompt(theater, returnFocus);
  };

  // "Theater 추가" 요청 소비(팔레트) — Theater 브라우저를 연다.
  useEffect(() => {
    if (!pendingSideBarAddTheater) return;
    consumeSideBarAddTheater();
    openTheaterBrowser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSideBarAddTheater]);

  const toggleTheaterSectionCollapsed = (theaterId: string) => {
    setTheaterCollapsed(theaterId, !collapsedTheaters.includes(theaterId));
  };

  const startAliasEdit = (theaterId: string) => {
    setActiveContextMenu(null);
    setAliasEditingTheaterId(theaterId);
  };
  const finishAliasEdit = (theaterId: string, alias: string | null | undefined) => {
    setAliasEditingTheaterId((current) => (current === theaterId ? null : current));
    if (alias !== undefined) onSetTheaterAlias(theaterId, alias);
  };
  const aliasEditingFor = (theaterId: string): TheaterAliasEditing => ({
    editingAlias: aliasEditingTheaterId === theaterId,
    onStartAliasEdit: startAliasEdit,
    onFinishAliasEdit: finishAliasEdit,
  });

  return (
    <aside
      className={`objective-records-side-bar${compact ? " is-compact" : ""}`}
      ref={rootRef}
      data-resizing={resizing ? "true" : undefined}
      style={{ "--side-bar-width": `${width}px` } as CSSProperties}
      onContextMenu={openNewSessionAtCursor}
    >
      {theaterError ? <p className="side-bar-theater-error">{theaterError}</p> : null}

      {/* 상태별 보기는 목록 전체의 세션 스위치다. 대화 화면은 컴팩트 줄을 쓴다. */}
      {topStripVariant === "compact" ? (
        <div className="side-bar-top-strip is-compact">
          <span className="side-bar-top-strip-spacer" aria-hidden="true" />
          {topStripCenter}
          {topStripTrailing}
        </div>
      ) : (
      <div className="side-bar-top-strip">
        {theaters.length > 0 ? (
          <>
            <span className="side-bar-top-strip-eyebrow">{t("sidebar.view.theaters")}</span>
            <SideBarViewMenu />
          </>
        ) : <span className="side-bar-top-strip-spacer" aria-hidden="true" />}
        {topStripTrailing}
      </div>
      )}

      {!compact ? <ConsoleSectionSlot compact={false} /> : null}
      <div className="side-bar-wide">
      <ol className="objective-records-side-bar-chips" ref={chipsRef} aria-label={t("sidebar.list.aria")}>
        {theaters.map((theater, theaterIndex) => {
          const isViewedTheater = theater.id === viewedTheaterId;
          const statusAxis = statusTheaterIds.has(theater.id);
          const theaterObjectiveRecords = objectiveRecords.filter((objectiveRecord) => objectiveRecord.theaterId === theater.id);
          const waitingCount = countAwaitingObjectiveRecords(theaterObjectiveRecords, objectiveRecordRuntime);
          const showStatusLiveTick = !statusAxis && waitingCount > 0;
          const summary: TheaterSummary = { commanders: theaterObjectiveRecords.length, waiting: waitingCount };
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
          const allEntries = buildTheaterEntries({ theaterId: theater.id, objectiveRecords, objectiveRecordOrder: objectiveRecordOrderFromNodes(theaterObjectiveRecords), activeObjectiveId, selectedObjectiveId: doubleClickOpen ? selectedObjectiveId : null, objectiveRecordNotifications, objectiveRecordRuntime });
          const theaterGroups = groups.filter((group) => group.theaterId === theater.id);
          const groupedSections = groupObjectiveRecords(allEntries, theaterGroups, objectiveRecordOrderFromNodes(theaterObjectiveRecords));
          const rowPlan = planSideBarRows(groupedSections, clusterIndex, theater.id);
          const collapsedGroupSet = new Set(getTheaterGroupCollapse(theater.id).collapsedGroups);
          const objectiveRecordAccent = getTheaterGroupCollapse(theater.id).objectiveRecordAccent;
          const orderedGroupIds = groupedSections.flatMap((section) => section.groupId ? [section.groupId] : []);
          const hasCustomGroups = theaterGroups.length > 0;
          const { living: statusSections, dormant: dormantSection } = groupTheaterStatusEntries(allEntries, getStatusTransitionTick, t);
          return (
            <li
              key={theater.id}
              className={[
                "side-bar-theater-section",
                isViewedTheater ? "side-bar-theater-section--active" : "",
                theaterDropBefore ? "side-bar-theater-section--drop-before" : "",
                theaterDropAfter ? "side-bar-theater-section--drop-after" : "",
              ].filter(Boolean).join(" ")}
              data-theater-id={theater.id}
              data-sidebar-axis={statusAxis ? "status" : "group"}
            >
              <TheaterSectionHeader
                theater={theater}
                active={isViewedTheater}
                collapsed={theaterCollapsed}
                summary={summary}
                statusAxis={statusAxis}
                {...aliasEditingFor(theater.id)}
                clusterHead={theaterClusterHead(rowPlan, theaterCollapsed || statusAxis)}
                showStatusLiveTick={showStatusLiveTick}
                dragging={isTheaterDragging}
                dropTarget={theaterDropBefore}
                dragOffsetY={theaterDragOffsetY}
                onToggleCollapsed={toggleTheaterSectionCollapsed}
                onOpenInbox={openTheaterHeaderInbox}
                onContextMenu={(anchor, returnFocus, atCursor) => openTheaterMenu(theater.id, anchor, returnFocus, atCursor)}
                menuTarget={theaterMenuTargetId === theater.id}
                onPointerDragStart={beginTheaterPointerDrag}
              />
              {!theaterCollapsed ? <TheaterContributionRows theater={theater} /> : null}
              {!theaterCollapsed ? (
              <ol className="side-bar-theater-groups" aria-label={t("sidebar.theater.objectiveRecordsAria", { theater: theater.label })}>
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
                    dormantSection={dormantSection}
                    renderEntry={renderActiveStatusEntry}
                  />,
                ]) : [
                  ...(rowPlan.decisions.length > 0 ? [
                    <SideBarRowZone key="__decisions__" theaterId={theater.id} zone="decisions" count={rowPlan.decisions.length}>
                      {rowPlan.decisions.map((item) => renderRow(item, true))}
                    </SideBarRowZone>,
                  ] : []),
                  ...(rowPlan.today.length > 0 ? [
                    <SideBarRowZone key="__today__" theaterId={theater.id} zone="today" count={rowPlan.today.length}>
                      {rowPlan.today.map((item) => renderRow(item, true))}
                    </SideBarRowZone>,
                  ] : []),
                ].concat(groupedSections.map((section) => {
          const sectionItems = rowPlan.sections.get(section.groupId) ?? [];
          const freshItems = rowPlan.folds.get(section.groupId) ?? [];
          const doneItems = rowPlan.doneFolds.get(section.groupId) ?? [];
          // 그룹 머리의 수·미분류 라벨·접힌 그룹의 표식 대신 두르기는 두 접기에 든 줄을 함께 친다.
          const foldItems = [...freshItems, ...doneItems];
          const isCollapsed = section.groupId !== null && collapsedGroupSet.has(section.groupId);
          const grpColor = section.group ? resolveAccentColor(section.group.color) : null;
          const sectionStyle = grpColor ? ({ "--grp-color": grpColor } as CSSProperties) : undefined;
          const groupIndex = section.groupId ? orderedGroupIds.indexOf(section.groupId) : -1;
          const isGroupDragging = drag?.kind === "group" && drag.sourceGroupId === section.groupId && drag.dragging;
          const groupDropBefore = drag?.kind === "group"
            && drag.theaterId === theater.id
            && drag.dragging
            && section.groupId !== null
            && drag.sourceGroupId !== section.groupId
            && drag.dropIndex === groupIndex;
          const groupDropAfter = drag?.kind === "group"
            && drag.theaterId === theater.id
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
                <ObjectiveRecordsSideBarGroupHeader
                  group={section.group}
                  count={sectionItems.length + foldItems.length}
                  collapsed={isCollapsed}
                  dragging={isGroupDragging}
                  dragOffsetY={isGroupDragging ? drag.currentY - drag.startY : 0}
                  dropTarget={groupDropBefore}
                  onToggle={(groupId) => toggleTheaterGroupCollapsed(theater.id, groupId)}
                  onContextMenu={(groupId, anchor) => setActiveContextMenu({ kind: "group", groupId, anchor })}
                  onPointerDragStart={beginGroupPointerDrag}
                  clusterHead={groupClusterHead(theater.id, sectionItems, foldItems, isCollapsed)}
                />
              ) : hasCustomGroups && sectionItems.length + foldItems.length > 0 ? (
                <SideBarUngroupedLabel count={sectionItems.length + foldItems.length} />
              ) : null}
              {!isCollapsed ? (
                <ol
                  className={[
                    "side-bar-group-chips",
                    drag?.kind === "chip" && drag.theaterId === theater.id && drag.dragging && drag.dropGroupId === section.groupId && drag.dropGroupId !== drag.sourceGroupId
                      ? "side-bar-section--drop-target"
                      : "",
                  ].filter(Boolean).join(" ")}
                  data-group-section-id={section.groupId ?? "__ungrouped__"}
                  aria-label={section.group ? section.group.name : t("sidebar.ungrouped.label")}
                >
                  {sectionItems.map((sectionItem) => {
                    if (sectionItem.kind === "row") return renderRow(sectionItem.item, false);
                    const entry = sectionItem.entry;
                    const globalIndex = allEntries.indexOf(entry);
                    const sectionLocalIndex = section.entries.indexOf(entry);
                    const accentKey = objectiveRecordAccent[entry.objectiveRecord.id] ?? objectiveRecordAccentFromNode(entry.objectiveRecord);
                    const accentValue = accentKey ? resolveAccentColor(accentKey) : null;
                    return (
                      <ObjectiveRecordsSideBarChip
                        key={entry.objectiveRecord.id}
                        entry={entry}
                        cluster={clusterPropsFor(entry)}
                        index={globalIndex}
                        accentValue={accentValue}
                        dragging={drag?.kind === "chip" && drag.sourceId === entry.objectiveRecord.id && drag.dragging}
                        dragOffsetY={drag?.kind === "chip" && drag.sourceId === entry.objectiveRecord.id && drag.dragging ? drag.currentY - drag.startY : 0}
                        dropTarget={
                          drag?.kind === "chip"
                          && drag.theaterId === theater.id
                          && drag.dragging === true
                          && drag.dropGroupId === section.groupId
                          && drag.dropGroupId === drag.sourceGroupId
                          && drag.dropIndex === sectionLocalIndex
                          && drag.sourceId !== entry.objectiveRecord.id
                        }
                        {...(onSelect ? { onSelect } : {})}
                        onClose={onClose}
                        onFocus={onFocus}
                        onKeyboardMove={keyboardMove}
                        onPointerDragStart={beginPointerDrag}
                        onOpenAccent={(objectiveId, anchor, returnFocus, requestedAction) => {
                          setActiveContextMenu({ kind: "chip", objectiveId, anchor, returnFocus, requestedAction });
                        }}
                        onRename={onRename}
                      />
                    );
                  })}
                  {freshItems.length > 0 ? (
                    <SideBarRowFold kind="fresh" theaterId={theater.id} groupId={section.groupId} items={freshItems} expanded={rowFolds.has(rowFoldKey("fresh", theater.id, section.groupId))} renderRow={(item) => renderRow(item, false)} />
                  ) : null}
                  {doneItems.length > 0 ? (
                    <SideBarRowFold kind="done" theaterId={theater.id} groupId={section.groupId} items={doneItems} expanded={rowFolds.has(rowFoldKey("done", theater.id, section.groupId))} renderRow={(item) => renderRow(item, false)} />
                  ) : null}
                </ol>
              ) : null}
            </li>
          );
        }))}
              </ol>
              ) : null}
            </li>
          );
        })}
        {theaters.length === 0 ? (
          // Theater가 없는 사이드바는 목록이 아니라 시작 화면이다 — 유령 행 하나로 빈 높이를 남기지 않고,
          // 첫 행동(폴더 선택)을 이 자리에서 바로 연다. 취역 가이드는 한 번 닫히면 사라지므로
          // 되돌아가는 길도 여기 둔다.
          <li className="side-bar-starter" data-testid="side-bar-starter">
            <span className="side-bar-starter-eyebrow">{t("sidebar.starter.eyebrow")}</span>
            <h2 className="side-bar-starter-title">{t("sidebar.starter.title")}</h2>
            <p className="side-bar-starter-body">{t("sidebar.starter.body")}</p>
            <button
              type="button"
              className="side-bar-starter-primary"
              onClick={openTheaterBrowser}
              disabled={addingTheater}
            >
              {addingTheater ? t("sidebar.starter.addingTheater") : t("sidebar.starter.chooseFolder")}
            </button>
            <button type="button" className="side-bar-starter-secondary" onClick={openOnboarding}>
              {t("sidebar.starter.reopenGuide")}
            </button>
            <p className="side-bar-starter-hints">
              <kbd>{searchShortcut}</kbd> {t("sidebar.starter.hintSearch")}
            </p>
          </li>
        ) : topStripVariant === "compact" ? null : (
          // 대화 중심 화면은 맨 위 줄 「+」가 Theater 를 더한다 — 목록 끝의 유령 행은 이전(캔버스) 배치에만 남는다.
          <li>
            <button type="button" className="side-bar-ghost-theater-row" onClick={openTheaterBrowser} disabled={addingTheater}>
              <span className="side-bar-ghost-theater-anchor" aria-hidden="true"><PlusIcon /></span>
              <span className="side-bar-ghost-theater-label">{t("sidebar.theater.newTheater")}</span>
            </button>
          </li>
        )}
      </ol>
      </div>

      {compact ? <ConsoleSectionSlot compact /> : null}
      {bottomAccessory}

      <SideBarResizeHandle onPointerDown={onResizePointerDown} />

      {activeContextMenu?.kind === "chip" && contextMenuObjective ? (
        <GroupContextMenu
          kind="chip"
          objectiveRecord={contextMenuObjective}
          groups={groups.filter((group) => group.theaterId === contextMenuObjective.theaterId)}
          accentKey={objectiveRecordAccent[contextMenuObjective.id] ?? objectiveRecordAccentFromNode(contextMenuObjective)}
          anchor={activeContextMenu.anchor}
          actions={{
            onSetAccent: (key) => onSetAccent(contextMenuObjective.id, key),
            onSetGroupId: (groupId) => onSetGroupId(contextMenuObjective.id, groupId),
            onCreateGroup: (name) => onCreateGroup(contextMenuObjective.theaterId, name, contextMenuObjective.id),
            onCloseObjective: () => onClose(contextMenuObjective.id),
            ...(doubleClickOpen ? {
              onOpen: () => {
                onFocus(contextMenuObjective.id);
                if (activeContextMenu.fromRow) registry.objectives.objectiveRecordSelected(contextMenuObjective.id);
              },
            } : {}),
            ...(activeContextMenu.fromRow && !activeContextMenu.renamable ? {} : { onRename: () => requestSideBarObjectiveAction(contextMenuObjective.id, "rename") }),
          }}
          onClose={closeActiveContextMenu}
        />
      ) : activeContextMenu?.kind === "row" ? (
        <GroupContextMenu
          kind="row"
          anchor={activeContextMenu.anchor}
          actions={{
            onArchive: activeContextMenu.archive,
            // 뿌리 없는 줄의 인라인 편집은 줄 id 로 연다 — 뿌리 있는 줄의 Objective id 자리와 같은 통로다.
            ...(activeContextMenu.renamable ? { onRename: () => requestSideBarObjectiveAction(activeContextMenu.clusterId, "rename") } : {}),
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
          active={contextMenuTheater.id === viewedTheaterId}
          groupCount={groups.filter((group) => group.theaterId === contextMenuTheater.id).length}
          anchor={activeContextMenu.anchor}
          atCursor={activeContextMenu.atCursor === true}
          startWithNewGroup={activeContextMenu.newGroup === true}
          onCreateGroup={(name) => {
            onCreateGroup(contextMenuTheater.id, name);
            closeActiveContextMenu();
          }}
          onForgetTheater={() => {
            onForgetTheater(contextMenuTheater.id);
            closeActiveContextMenu();
          }}
          onOpenSystemPrompt={() => {
            openTheaterSystemPrompt(contextMenuTheater, activeContextMenu.returnFocus ?? null, activeContextMenu.anchor);
            setActiveContextMenu(null);
          }}
          onEditAlias={() => startAliasEdit(contextMenuTheater.id)}
          onClose={closeActiveContextMenu}
        />
      ) : null}
      <DirectoryBrowserModal open={browserOpen} onCancel={cancelTheaterBrowser} onConfirm={confirmTheaterBrowser} />
    </aside>
  );
}

interface GroupSection {
  readonly groupId: string | null;
  readonly group: ObjectiveGroup | null;
  readonly entries: SideBarEntry[];
}

export function groupObjectiveRecords(
  entries: readonly SideBarEntry[],
  groups: readonly ObjectiveGroup[],
  objectiveRecordOrder: readonly string[],
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
    const gid = entry.objectiveRecord.groupId ?? null;
    if (gid !== null && groupById.has(gid)) {
      const section = sections.find((s) => s.groupId === gid);
      section?.entries.push(entry);
    } else {
      ungrouped.entries.push(entry);
    }
  }

  void objectiveRecordOrder;
  return [...sections, ungrouped];
}

export function groupTheaterStatusEntries(
  entries: readonly SideBarEntry[],
  getTick?: (id: string) => number | undefined,
  t: Translate<CoreMessageKey> = getT("en"),
): {
  readonly living: StatusSection[];
  readonly dormant: StatusSection;
} {
  const dormantEntries = entries.filter((entry) => entry.status === "ended");
  const sections = groupObjectiveRecordsByStatus(
    entries.filter((entry) => entry.status !== "ended"),
    getTick,
    t,
  );
  return {
    living: sections.filter((section) => section.status !== "ended"),
    dormant: {
      status: "ended",
      label: t("sidebar.status.dormantShelf"),
      entries: dormantEntries,
    },
  };
}

export function groupObjectiveRecordsByStatus(
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
        const display = resolveObjectiveDisplayActivity({
          activity: entry.status ?? "idle",
          objectiveId: entry.objectiveRecord.id,
          idleArrivalIds,
        });
        if (display !== status) return [];
        return [entry.status === display ? entry : { ...entry, status: display }];
      })
      .sort((left, right) => {
        const leftTick = getTick?.(left.objectiveRecord.id);
        const rightTick = getTick?.(right.objectiveRecord.id);
        if (leftTick === undefined && rightTick === undefined) return 0;
        if (leftTick === undefined) return 1;
        if (rightTick === undefined) return -1;
        return rightTick - leftTick;
      }),
  }));
}

/** 그 Theater 에서 사람의 답을 기다리는 Objective 수 — 사령관 카드 요약과 대기 틱은 미확인 도착의 섹션 승격을 세지 않는다. */
function countAwaitingObjectiveRecords(
  objectiveRecords: readonly ObjectiveRecord[],
  objectiveRecordRuntime: Readonly<Record<string, ObjectiveRuntimeState>>,
): number {
  return objectiveRecords.filter((objectiveRecord) =>
    resolveObjectiveActivity(objectiveRecord, objectiveRecordRuntime) === "awaiting").length;
}

function resolveEntryGroupMark(
  entry: SideBarEntry,
  groups: readonly ObjectiveGroup[],
): { readonly name: string; readonly color: string } | null {
  const groupId = entry.objectiveRecord.groupId;
  if (!groupId) return null;
  const group = groups.find((candidate) => candidate.id === groupId);
  if (!group) return null;
  const color = resolveAccentColor(group.color);
  return color ? { name: group.name, color } : null;
}

export function buildTheaterEntries({
  theaterId,
  objectiveRecords,
  objectiveRecordOrder,
  activeObjectiveId,
  selectedObjectiveId = null,
  objectiveRecordNotifications,
  objectiveRecordRuntime,
}: TheaterEntryBuildInput): SideBarEntry[] {
  const idleArrivalIds = getIdleArrivalIds();
  return sortObjectiveRecordsByOrder(
    objectiveRecords.filter((objectiveRecord) => objectiveRecord.theaterId === theaterId),
    objectiveRecordOrder,
  ).map((objectiveRecord) => {
    const activity = resolveObjectiveActivity(objectiveRecord, objectiveRecordRuntime);
    return {
      objectiveRecord,
      active: activeObjectiveId === objectiveRecord.id,
      selected: selectedObjectiveId === objectiveRecord.id,
      notificationCount: objectiveRecordNotifications[objectiveRecord.id] ? 1 : 0,
      status: activity,
      mark: resolveObjectiveMarkVisual({ activity, objectiveId: objectiveRecord.id, idleArrivalIds }),
    };
  });
}

function TheaterSectionHeader({
  theater,
  active,
  collapsed,
  summary,
  statusAxis,
  editingAlias,
  showStatusLiveTick,
  dragging,
  dropTarget,
  dragOffsetY,
  onOpenInbox,
  onToggleCollapsed,
  onContextMenu,
  menuTarget,
  onStartAliasEdit,
  onFinishAliasEdit,
  onPointerDragStart,
  clusterHead,
}: TheaterSectionHeaderProps) {
  const t = useT();
  // 대화 중심 화면의 머리는 사령관 카드다 — 큰 아바타, 둘째 줄 요약. 머리 제어(접기·「+」)는 머무를 때·활성일 때 선다(CSS).
  const suppressClickRef = useRef(false);
  const activateRef = useRef<HTMLButtonElement | null>(null);
  // Console Use — 에이전트가 이 Theater 의 목록·그룹을 읽으면 헤더 행 전체가 감싸인다. Theater 바로 아래 선 목표 줄의 묶음 머리이기도 하다.
  const wrap = useSyncExternalStore(
    subscribeConsoleUseGestures,
    () => getTheaterWrap(theater.id) ?? (clusterHead
      ? getFirstClusterWrap(clusterHead.hiddenClusterIds) ?? (clusterHead.anyList ? getAnyClusterListWrap(theater.id) : getClusterListWrap(theater.id, null))
      : null),
    () => null,
  );
  // 플러그인 표식(자율 운영의 사령관 글리프)이 있으면 이니셜 칩 자리에 선다. 운영자가 일하는 동안 이름에 라이브 물결이 흐른다.
  const contributionSummary = useMemo(() => ({ id: theater.id, label: theater.label }), [theater.id, theater.label]);
  const mark = useTheaterContributionMark(contributionSummary);
  const live = useTheaterHeaderLive(theater.id);
  // 별칭 편집을 키(Enter·Esc)로 마치면 포커스가 머리로 돌아온다. 다른 곳을 눌러 끝냈으면(blur) 그 자리의 포커스를 빼앗지 않는다.
  const wasEditingRef = useRef(editingAlias);
  const keyFinishRef = useRef(false);
  useEffect(() => {
    if (wasEditingRef.current && !editingAlias && keyFinishRef.current) activateRef.current?.focus({ preventScroll: true });
    if (!editingAlias) keyFinishRef.current = false;
    wasEditingRef.current = editingAlias;
  }, [editingAlias]);
  const displayName = theater.alias ?? theater.label;
  const summaryText = summary.commanders === 0
    ? t("sidebar.theater.summary.none")
    : [
        t(summary.commanders === 1 ? "sidebar.theater.summary.commanders_one" : "sidebar.theater.summary.commanders_other", { count: summary.commanders }),
        ...(summary.waiting > 0 ? [t("sidebar.theater.summary.waiting", { count: summary.waiting })] : []),
      ].join(" · ");
  // 둘째 줄 — 별칭이 있으면 원래 Theater 이름이 먼저 선다(어느 폴더인지 늘 보인다). 사령관 카드는 그 뒤에 요약을 잇는다.
  const subline = [...(theater.alias ? [theater.label] : []), summaryText].join(" · ");
  const headerClassName = [
    "side-bar-theater-header",
    consoleUseWrapClassName(wrap),
    active ? "is-active" : "",
    "is-card",
    menuTarget ? "is-menu-target" : "",
    dragging ? "side-bar-theater-header--dragging" : "",
    dropTarget ? "side-bar-theater-header--drop-target" : "",
  ].filter(Boolean).join(" ");
  const headerStyle = dragging ? ({ "--drag-dy": `${Math.round(dragOffsetY)}px` } as CSSProperties) : undefined;

  // Theater 동작(별칭·시스템 프롬프트·플러그인 항목·새 그룹·Theater 잊기)은 머리에서 연다 — 우클릭은 커서 자리에, 키(ContextMenu·
  // Shift+F10)와 터치·펜 길게 누르기는 머리 아래에. 두 배치(기존·대화 중심) 모두 같다. 별도 「⋯」 단추는 두지 않는다.
  const longPress = useLongPress<HTMLDivElement>((header) => {
    onContextMenu(header.getBoundingClientRect(), activateRef.current, false);
  });

  const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    // 별칭 입력 안의 우클릭은 입력의 것(붙여넣기 등)이다 — 브라우저 메뉴를 남기고, 사이드바 빈 자리 메뉴로도 번지지 않게 한다.
    if (event.target instanceof Element && event.target.closest(".side-bar-theater-alias-input")) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    if (longPress.claimContextMenu(event)) return;
    onContextMenu(new DOMRect(event.clientX, event.clientY, 0, 0), activateRef.current, true);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Enter/Space는 버튼의 기본 동작이 onClick으로 흘려보낸다 — 여기서 다시 처리하면 두 번 발화한다.
    if (event.key === "F2" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      onStartAliasEdit(theater.id);
      return;
    }
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    onContextMenu(event.currentTarget.getBoundingClientRect(), event.currentTarget, false);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 행 컨트롤(접기·새 Objective)과 표식 안의 단추(자율 운영 끄기), 별칭 입력에서 시작한 포인터는 드래그가 아니다. 활성화 버튼은
    // 행의 본문이므로 배제하지 않는다 — 배제하면 행을 잡아 옮길 수 없다.
    // 길게 누르기도 같은 자리만 받는다 — 단추 위 길게 누르기는 그 단추의 것이다.
    if (event.target instanceof Element && (event.target.closest(".side-bar-theater-row-controls") || event.target.closest(".side-bar-theater-mark button") || event.target.closest(".side-bar-theater-alias-input"))) return;
    longPress.onPointerDown(event);
    onPointerDragStart(event, theater.id);
  };

  const handlePointerUp = () => {
    longPress.onPointerUp();
    if (dragging) suppressClickRef.current = true;
  };

  // 이름은 Theater 를 전환하고 그 Theater 의 대화를 연다. chevron 은 활성 여부와 무관하게 이 섹션만 접는다.
  const select = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onOpenInbox(theater, activateRef.current);
  };
  const collapseLabel = collapsed
    ? t("sidebar.theater.expand", { theater: displayName })
    : t("sidebar.theater.collapse", { theater: displayName });
  const avatarAnchor = (tick: boolean) => (
    <span className="side-bar-theater-anchor is-avatar" aria-hidden="true">
      {/* 플러그인 표식이 없을 때도 Theater 는 사령관 아바타로 선다 — 기여가 주는 얼굴이 없으니 쉼이다. */}
      <TheaterAvatar theaterId={theater.id} size={32} label="" decorative />
      {/* "여기 대기 중"은 Theater 하나의 사실이므로 정체성 표식이 진다. 전역 축 스위치에
          얹으면 어느 Theater인지가 지워진다. */}
      {tick && showStatusLiveTick ? <span className="side-bar-status-axis-live-tick" aria-hidden="true" /> : null}
    </span>
  );

  return (
    // 행 자체가 role="button"이면서 상태 정렬·새 Objective·액션 버튼을 품고 있어, 활성화
    // 대상이 둘로 갈리는 중첩 인터랙션이었다(버블된 Enter/Space를 손으로 걸러내던 자리가 그
    // 증거다). 활성화를 형제 버튼으로 꺼내면 행은 컨테이너가 되고 키보드 처리는 버튼이 맡는다.
    <div
      className={headerClassName}
      style={headerStyle}
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={longPress.onPointerCancel}
    >
      {mark !== null ? (
        // 플러그인 표식은 활성화 버튼 밖에 선다 — 표식이 자기 단추(자율 운영 끄기)를 품을 수 있게. 단추가 아닌 자리를 누르면
        // 머리를 누른 것과 같다.
        <span
          className="side-bar-theater-anchor side-bar-theater-mark"
          onClick={(event) => { if (!(event.target instanceof Element && event.target.closest("button"))) select(); }}
        >
          {mark}
          {showStatusLiveTick ? <span className="side-bar-status-axis-live-tick" aria-hidden="true" /> : null}
        </span>
      ) : null}
      {editingAlias ? (
        <>
          {mark === null ? avatarAnchor(false) : null}
          <span className="side-bar-theater-text">
            <TheaterAliasInput theater={theater} onDone={(alias, viaKey) => { keyFinishRef.current = viaKey; onFinishAliasEdit(theater.id, alias); }} />
            <span className="side-bar-theater-sub">{[theater.label, summaryText].join(" · ")}</span>
          </span>
        </>
      ) : (
        <button
          ref={activateRef}
          type="button"
          className="side-bar-theater-activate"
          aria-haspopup="dialog"
          onClick={select}
          onKeyDown={handleKeyDown}
          aria-current={active ? "true" : undefined}
          title={wrap ? t("sidebar.theater.scan", { caller: gestureCallerLabel(wrap.gesture.caller), summary: wrap.gesture.summary }) : `${active ? t("sidebar.theater.openInbox", { theater: displayName }) : t("sidebar.theater.switchTo", { theater: displayName })} · ${t("sidebar.theater.actionsHint")}`}
        >
          {mark === null ? avatarAnchor(true) : null}
          <span className="side-bar-theater-text">
            <span className={`side-bar-theater-name${live ? " is-live" : ""}`} onDoubleClick={() => onStartAliasEdit(theater.id)}>{displayName}</span>
            {subline ? <span className="side-bar-theater-sub">{subline}</span> : null}
          </span>
        </button>
      )}
      <span className="side-bar-theater-row-controls" role="group" aria-label={t("sidebar.theater.controlsAria", { theater: displayName })}>
        <SideBarStatusViewToggle active={statusAxis} theaterId={theater.id} theaterName={displayName} />
        {/* Theater 동작은 머리의 우클릭·키·길게 누르기 메뉴에 있다(handleContextMenu). 「새 그룹…」은 「+」 메뉴 맨 아래에도 선다. */}
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
      </span>
    </div>
  );
}

/**
 * 머리 자리의 별칭 입력 — Enter 는 저장, Esc 나 다른 곳을 누르면 취소, 비우고 저장하면 해제다. 바뀐 것이 없으면 저장하지 않는다.
 * IME 조합 중의 Enter·Esc 는 조합의 것이라 편집을 끝내지 않는다.
 */
function TheaterAliasInput({ theater, onDone }: { readonly theater: TheaterInfo; readonly onDone: (alias: string | null | undefined, viaKey: boolean) => void }) {
  const t = useT();
  const [value, setValue] = useState(theater.alias ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const doneRef = useRef(false);
  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, []);
  const finish = (alias: string | null | undefined, viaKey: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(alias, viaKey);
  };
  const commit = () => {
    const next = clampTheaterAlias(value).trim();
    finish(next === (theater.alias ?? "") ? undefined : next.length > 0 ? next : null, true);
  };
  return (
    <input
      ref={inputRef}
      className="side-bar-theater-alias-input"
      type="text"
      value={value}
      placeholder={theater.label}
      aria-label={t("sidebar.theater.alias.inputAria", { theater: theater.label })}
      onChange={(event) => setValue(composingRef.current ? event.target.value : clampTheaterAlias(event.target.value))}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={(event) => { composingRef.current = false; setValue(clampTheaterAlias(event.currentTarget.value)); }}
      onKeyDown={(event) => {
        if (composingRef.current || event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(undefined, true);
        }
      }}
      onBlur={() => finish(undefined, false)}
    />
  );
}

function TheaterActionsMenu({ theater, active, groupCount, anchor, atCursor = false, onCreateGroup, onForgetTheater, onOpenSystemPrompt, onEditAlias, onClose, startWithNewGroup = false }: TheaterActionsMenuProps) {
  const t = useT();
  const [showNewInput, setShowNewInput] = useState(startWithNewGroup);
  const [prompt, setPrompt] = useState<TheaterSystemPrompt | null>(null);
  const [promptLoaded, setPromptLoaded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setPromptLoaded(false);
    void fetchTheaterSystemPrompt(theater.id, controller.signal).then((state) => {
      if (controller.signal.aborted) return;
      setPrompt(state.prompt);
      setPromptLoaded(true);
    }).catch(() => undefined);
    const unsubscribe = subscribeTheaterSystemPromptChange((id, value) => { if (id === theater.id) { setPrompt(value); setPromptLoaded(true); } });
    return () => { controller.abort(); unsubscribe(); };
  }, [theater.id]);
  const [newName, setNewName] = useState(() => t("sidebar.theater.defaultGroupName", { n: groupCount + 1 }));
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // 사이드바 하단 행에서 anchor.bottom+6 고정 배치가 뷰포트 아래로 밀리면 스크롤로 닫혀
  // Forget/New group에 도달할 수 없다(Codex P2) — 실측 크기로 상단을 클램프한다. 커서 자리 메뉴는 아래가 모자라면
  // 커서 위로 뒤집고, 좁은 창의 오른쪽 끝 우클릭이 메뉴를 창 밖으로 밀지 않게 왼쪽도 클램프한다.
  const [menuPosition, setMenuPosition] = useState(() => ({ left: anchor.left, top: atCursor ? anchor.top : anchor.bottom + 6 }));

  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    const height = rect?.height ?? 0;
    const width = rect?.width ?? 0;
    const maxTop = window.innerHeight - height - 8;
    const below = atCursor ? anchor.top : anchor.bottom + 6;
    const top = atCursor && below > maxTop ? anchor.top - height : below;
    setMenuPosition({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(top, maxTop)),
    });
  }, [anchor, atCursor, showNewInput]);

  useEffect(() => {
    if (showNewInput) inputRef.current?.select();
  }, [showNewInput]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    // 앵커 자리의 주인은 열린 뒤 한 번만 짚는다 — 오버레이가 덮은 뒤라 오버레이는 건너뛴다.
    const anchorElement = anchorElementAt(anchor, menuRef.current?.parentElement);
    const onScroll = (event: Event) => {
      if (scrollMovesAnchor(event, anchor, anchorElement)) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onClose]);

  const confirmNewGroup = () => {
    const name = newName.trim();
    if (!name) return;
    onCreateGroup(name);
  };

  return createPortal(
    <div className="group-context-menu-overlay" data-native-browser-transparent role="presentation" onPointerDown={onClose}>
      <div
        ref={menuRef}
        className="theater-menu side-bar-theater-menu"
        role="menu"
        aria-label={t("sidebar.theater.actionsMenuAria", { theater: theater.alias ?? theater.label })}
        style={{
          position: "fixed",
          left: menuPosition.left,
          top: menuPosition.top,
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {/* 대상 Theater — 활성이 아닌 Theater 에서도 열리므로 무엇을 다루는지 먼저 말한다. 메뉴의 aria-label 이 같은 이름을 읽는다. */}
        <div className="theater-menu-title" aria-hidden="true">
          <TheaterAvatar theaterId={theater.id} size={22} label="" decorative />
          <span className="theater-menu-title-text">
            <strong>{theater.alias ?? theater.label}</strong>
            {theater.alias ? <span>{theater.label}</span> : null}
          </span>
        </div>
        {/* 사령관 별칭 — 머리 자리에서 바로 편집한다(F2·이름 더블클릭도 같다). 원래 이름은 머리 둘째 줄에 남는다. */}
        <button type="button" role="menuitem" className="theater-menu-item theater-menu-alias" onClick={onEditAlias}>
          <span className="theater-menu-check" aria-hidden="true"><PencilIcon /></span>
          <span className="theater-menu-label">{t("sidebar.theater.alias.edit")}</span>
        </button>
        <div className="theater-menu-divider" aria-hidden="true" />
        <button type="button" role="menuitem" className="theater-menu-item" onClick={onOpenSystemPrompt}>
          <span className="theater-menu-check" aria-hidden="true">✦</span>
          <span className="theater-menu-label">{t("sidebar.theater.prompt.menu")}</span>
          <span className="theater-prompt-menu-state">{promptLoaded ? (prompt ? t(`sidebar.theater.prompt.mode${prompt.mode === "on" ? "On" : prompt.mode === "append" ? "Append" : "Off"}`) : t("sidebar.theater.prompt.unset")) : null}</span>
        </button>
        <TheaterContributionMenuItems theater={theater} onClose={onClose} />
        <div className="theater-menu-divider" aria-hidden="true" />
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

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.4v9.2M3.4 8h9.2" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.6 3.2 12.8 5.4 6.2 12H4v-2.2z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.2 5.8v6.1M8 5.8v6.1M10.8 5.8v6.1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M3.7 4.1h8.6M6.4 4.1l.4-1h2.4l.4 1M4.6 4.1l.5 9.1h5.8l.5-9.1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Console Use 시선 — 에이전트가 이 Theater 의 목록을 훑거나 그룹을 만지면 헤더에 점이 두 번 맥동한다. */
