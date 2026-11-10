import { FolderIcon, PencilIcon, PlusIcon, TaskforceIcon, TrashIcon } from "./sidebar-menu-icons.js";
import { ConsoleSectionSlot } from "../../../remote-access/client/console-section-slot.js";

/**
 * 사이드바 머리 한 줄 — 사령관 section 이 `TheaterInfo` 모양으로 선다. `id` 와 `commodore.id` 는 그 사령관 UUID 이고,
 * 별칭은 사령관 목록의 값이다. Theater 목록에서 주인을 찾지 않는다. 사령관이 없는 Theater 행이면 `commodore` 가 없다.
 */
type SideBarHead = TheaterInfo & { readonly commodore?: { readonly id: string; readonly alias?: string } };
/** 사령관·TF 한 줄 — 서버가 내린 전체 순서(order)로 섞어 세운다. 행 id는 두 종류의 UUID를 함께 든다. */
type SideBarFace =
  | { readonly kind: "commodore"; readonly id: string; readonly section: SidebarCommodore }
  | { readonly kind: "taskforce"; readonly id: string; readonly row: TaskforceSummary };
const EMPTY_TASKFORCE_SUMMARIES: readonly TaskforceSummary[] = [];
export { theaterInitials } from "./theater-initials.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { ObjectiveRuntimeState } from "../../../execution/shared/client-contract.js";

import { useT, useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import { requestTaskforceCreate, TASKFORCE_SURFACE_ID, TaskforceRowMenu, TaskforceStack, openTaskforce } from "../../../commodore/client/taskforce/taskforce.js";
import { loadTaskforce, readTaskforce, useTaskforceExperiment, useTaskforces } from "../../../commodore/client/taskforce/state.js";
import type { TaskforceSummary } from "../../../commodore/shared/contracts/taskforce.js";
import { taskforceT } from "../../../commodore/client/taskforce/i18n.js";
import type { ObjectiveRecord, TheaterInfo } from "../../../../core/client/src/integration/types.js";
import { useSearchShortcutLabel } from "../../../../core/client/src/integration/shortcuts.js";
import { DirectoryBrowserModal } from "../../../../core/client/src/chrome/components/directory-browser-modal.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { openCommodoreNewSession, openDefaultNewSession } from "../conversation/new-session-entry.js";
import { isCommodoreConversationActive, isCommodoreConversationOpen, openCommodoreConversation } from "../../../commodore/client/commodore-conversation.js";
import { requestCommodoreDelete } from "../../../commodore/client/commodore-delete-modal.js";
import { requestCommodoreCreate } from "../../../commodore/client/commodore-create-modal.js";
import { refreshCommodoreList, replaceCommodoreList, replaceSidebarOrder, setZoneCommodore, useCommodoreListLoaded, useSidebarCommodores, useSidebarOrder, type SidebarCommodore } from "../../../commodore/client/commodore-list.js";
import { saveCommodoreOrder } from "../../../commodore/client/theaters-api.js";
import { commodoreSidebarBuckets } from "../../../commodore/client/sidebar-sections.js";
import { setCommodoreAlias } from "../../../../core/client/src/integration/api.js";
import { commodoreAvatarKey } from "../../shared/avatars.js";
import { KeyedAvatar } from "../avatars.js";
import { consumeSideBarAddTheater, openOnboarding } from "../../../../core/client/src/integration/store.js";
import { useFeatureRegistry } from "../../../../core/client/src/integration/feature-registry.js";
import { resolveTheaterInboxLanding, TheaterContributionMenuItems, useTheaterContributionMark, useTheaterHeaderLive, useTheaterHeaderSelected } from "../theater-contributions.js";
import { openTheaterInbox } from "../theater-inbox/store.js";
import { resolveObjectiveActivity } from "../../../execution/client/objective-activity.js";
import { commodoreSectionDropFromPoint, type CommodoreSectionDrop, reorderTheaterIds, theaterDropIndexFromPoint } from "./objective-records-side-bar-hit-test.js";
import { CommodoreSidebarSection, CommodoreSectionMoveMenu, useCommodoreSidebarSections, type SidebarSectionsController } from "./commodore-sidebar-sections.js";
import { useContextMenuKeyboard } from "./context-menu-keyboard.js";
import { useAvatarClaims } from "../avatars.js";
import { useLongPress } from "../long-press.js";
import { anchorElementAt, scrollMovesAnchor } from "../anchored-scroll-dismissal.js";
import { useConversationSubject } from "../conversation/conversation-slots.js";
import { useConversationSurface } from "../conversation/conversation-surface-store.js";
import { SidebarCommanderList } from "../commander-tab/commander-sidebar-list.js";
import { clusterHasPersonDecision } from "../../../objectives/shared/objective-clusters.js";
import { useClusterIndex } from "../objective-clusters.js";
import { ensureCommanderExpanded, noteCommanderNavigated, readCommanderKeepExpanded, reselectCommander, useCommanderExpanded, useCommanderShowSettled } from "./commander-expansion.js";
import { CommodoreHoverDock } from "./commodore-hover-dock.js";
import { RowToolUse } from "./side-bar-cluster-row.js";
import { useCommodoreBrowserUse } from "../../../computer-use/client/computer-screen-share.js";
import { useSideBarState } from "./objective-records-side-bar-store.js";
import { SideBarResizeHandle, useSideBarResize } from "./side-bar-resize.js";

/*
 * 왼쪽 사이드바 — 사령관 목록이다. 사령관마다 머리(아바타·이름·마지막 응답) 하나가 선다.
 * 왼쪽 배치일 때만 펼친 사령관 밑에 지휘관 목록이 선다. 펼침은 사령관을 옮길 때 정해지고(commander-expansion.ts),
 * 새 목표·정렬·목록 위치는 머리의 호버 독이 맡는다. 오른쪽 배치이면 머리만 남고 목록은 오른쪽 사이드바(작업 탭)가 맡는다.
 */

interface ObjectiveRecordsSideBarProps {
  /** 대화 화면이 그리는 폭 상한(px). 저장된 폭 선호는 그대로 두고 그리는 폭만 깎는다. */
  readonly widthCap?: number;
  /** 맨 위 줄 오른쪽에 끼우는 단추들(대화 중심 화면의 검색·새로 만들기). */
  readonly topStripTrailing?: ReactNode;
  /** 사이드바 맨 아래에 서는 셸의 기여(호스트 아바타·플러그인 요약 줄). */
  readonly bottomAccessory?: ReactNode;
  readonly objectiveRecords: readonly ObjectiveRecord[];
  /** 사령관 별칭 지정 — null 은 해제다. */
  readonly clampAlias: (value: string) => string;
  readonly onAddTheater: (commodoreId: string, path: string) => Promise<void>;
}

/** atCursor — 우클릭으로 열었으면 앵커는 커서 한 점이고 메뉴는 그 자리에 선다. 아니면(키·길게 누르기) 앵커 아래에 선다. */
interface ActiveContextMenu {
  readonly theaterId: string;
  readonly anchor: DOMRect;
  readonly returnFocus?: HTMLElement | null;
  readonly atCursor?: boolean;
  readonly focusFirst?: boolean;
}

interface TheaterDragState {
  readonly sourceTheaterId: string;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly currentY: number;
  readonly dragging: boolean;
  readonly dropIndex: number;
  readonly sectionDrop?: CommodoreSectionDrop | null;
}

/** 머리의 별칭 편집 — 한 번에 한 머리만 그 자리에서 편집한다. 끝낼 때 undefined 는 취소, null 은 해제다. */
interface TheaterAliasEditing {
  readonly clampAlias: (value: string) => string;
  readonly editingAlias: boolean;
  readonly onStartAliasEdit: (theaterId: string) => void;
  readonly onFinishAliasEdit: (theaterId: string, alias: string | null | undefined) => void;
}

interface TheaterSectionHeaderProps extends TheaterAliasEditing {
  readonly theater: SideBarHead;
  readonly active: boolean;
  readonly lastResponse: string | undefined;
  /** 사령관 머리에 호버 독(⋯ → 새 목표·정렬·목록 위치·펼침 유지)이 선다. TaskForce 행에는 서지 않는다. */
  readonly dock: boolean;
  /** 표식(아바타) 단추가 직접 대화를 열 때도 「활성 사령관을 다시 골랐다」를 알린다 — 이름 쪽 활성화는 `onOpenInbox` 가 알린다. */
  readonly onReselect?: () => void;
  readonly showStatusLiveTick: boolean;
  /**
   * 사람이 답할 차례인 결정 요청이 이 사령관에 있다 — 접힌 머리라도 아바타에 결정 상태를 남긴다.
   * 펼친 목록의 줄과 같은 묶음 판정이라, 답하기 전까지 열람으로 지워지지 않는다. TF 행에는 쓰지 않는다.
   */
  readonly hasPersonDecision?: boolean;
  readonly liveOverride?: boolean;
  /** TF 행은 TF 화면 열림으로 `is-current` 를 안다 — 사령관 기여(사령관 대화만 응답)는 TF id 에 늘 false 다. */
  readonly selectedOverride?: boolean;
  readonly dragging: boolean;
  readonly dropTarget: boolean;
  readonly dragOffsetY: number;
  /** 머리를 눌렀을 때 — 그 사령관의 대화를 연다. */
  readonly onOpenInbox: (theater: SideBarHead, returnFocus: HTMLElement | null) => void;
  /** 이 머리의 사령관 메뉴를 연다 — 우클릭은 커서 자리(atCursor), 키·길게 누르기는 앵커 아래. */
  readonly onContextMenu: (anchor: DOMRect, returnFocus: HTMLElement | null, atCursor: boolean, focusFirst?: boolean) => void;
  /** 열린 사령관 메뉴가 이 머리를 대상으로 한다 — 활성이 아닌 사령관에서도 열리므로 머리가 대상을 말한다. */
  readonly menuTarget: boolean;
  readonly onPointerDragStart: (event: ReactPointerEvent<HTMLDivElement>, theaterId: string) => void;
  /** 사령관 아바타 자리 대체 — TF 행은 멤버 아바타 묶음을 세운다. 없으면 사령관 아바타다. */
  readonly avatarOverride?: ReactNode;
}

interface TheaterActionsMenuProps {
  readonly sections: SidebarSectionsController;
  readonly theater: SideBarHead;
  readonly anchor: DOMRect;
  /** 앵커가 커서 한 점이다 — 메뉴 윗변을 커서에 두고, 아래가 모자라면 커서 위로 뒤집는다. */
  readonly atCursor?: boolean;
  readonly focusFirst?: boolean;
  readonly onDeleteCommodore?: (() => void) | undefined;
  readonly onAddTheater: () => void;
  readonly onNewSession: () => void;
  readonly onEditAlias: () => void;
  readonly onClose: () => void;
}

const DRAG_THRESHOLD_PX = 6;
const AUTO_SCROLL_EDGE_PX = 34;
const AUTO_SCROLL_STEP_PX = 18;

export function ObjectiveRecordsSideBar({
  objectiveRecords,
  clampAlias,
  onAddTheater,
  widthCap,
  topStripTrailing,
  bottomAccessory,
}: ObjectiveRecordsSideBarProps) {
  const t = useT();
  const showSettled = useCommanderShowSettled();
  const searchShortcut = useSearchShortcutLabel();
  const rootRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const sideBar = useSideBarState();
  // 좁은 창(대화 화면)에서는 아바타만 남은 열로 물러난다 — 사람이 정한 폭은 그대로 기억된다.
  const compact = sideBar.compact;
  const width = compact ? sideBar.compactWidth : widthCap === undefined ? sideBar.width : Math.min(sideBar.width, widthCap);
  const surface = useConversationSurface();
  const expandedCommanders = useCommanderExpanded();
  const sidebarSections = useCommodoreSidebarSections();
  const sidebarSectionsRef = useRef(sidebarSections);
  const { objectiveRecordRuntime, pendingSideBarAddTheater, groups, activeObjectiveId, newSession } = useConsoleState();
  const [drag, setDrag] = useState<TheaterDragState | null>(null);
  const dragRef = useRef<TheaterDragState | null>(null);
  const orderedTheaterIdsRef = useRef<string[]>([]);
  const contextMenuReturnFocusRef = useRef<HTMLElement | null>(null);
  const [activeContextMenu, setActiveContextMenu] = useState<ActiveContextMenu | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserCommodoreId, setBrowserCommodoreId] = useState<string | null>(null);
  const [addFailure, setAddFailure] = useState<string | null>(null);
  const [aliasEditingTheaterId, setAliasEditingTheaterId] = useState<string | null>(null);
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [pendingOrder, setPendingOrder] = useState<readonly string[] | null>(null);
  const { resizing, snapping, onPointerDown: onResizePointerDown } = useSideBarResize();
  const surfaceOwner = typeof surface?.params.commodoreId === "string" ? surface.params.commodoreId : null;
  const selectedTaskforceId = surface?.surfaceId === TASKFORCE_SURFACE_ID && typeof surface.params.taskforceId === "string" ? surface.params.taskforceId : null;
  const subjectOwner = useConversationSubject()?.commodoreId ?? null;
  const objectiveOwner = objectiveRecords.find((record) => record.id === activeObjectiveId)?.commodoreId ?? null;
  // 활성 Objective 만으로 목록을 매달면, 목록을 누르는 pointerdown 이 그 활성을 푸는 순간 목록이 사라졌다가 되살아난다.
  const owningCommodoreId = newSession !== null ? newSession.commodoreId ?? null
    : surface ? surfaceOwner ?? subjectOwner : subjectOwner ?? objectiveOwner;
  // 사령관을 옮길 때마다(활성 소유자가 바뀔 때마다) 펼침 묶음이 정해진다 — 헤더를 누른 이동뿐 아니라 팔레트·링크 이동도 같다.
  // 그리기 전에 반영해 옮긴 사령관의 목록이 접힌 채 한 프레임 비치지 않게 한다.
  useLayoutEffect(() => {
    if (owningCommodoreId !== null) noteCommanderNavigated(owningCommodoreId, readCommanderKeepExpanded());
  }, [owningCommodoreId]);
  // 몽글 아바타 처음 배정 — 사이드바 한 곳이 사령관·Objective 이 처음 보일 때 묶음째 뽑아 저장한다.
  useAvatarClaims();
  const registry = useFeatureRegistry();

  // 사이드바 행은 사령관과 TF 한 목록이다 — 서버가 내린 전체 순서(order)로 섞어 세운다.
  // 순위에 없는 행(저장 전 새 행)은 뒤에 붙는다. TF 미리보기가 비었으면 원장을 읽어 채운다.
  const commodoreSections = useSidebarCommodores(objectiveRecords, groups, t("sidebar.commodore.fallback"));
  const commodoresLoaded = useCommodoreListLoaded();
  const taskforceExperiment = useTaskforceExperiment();
  const allTaskforces = useTaskforces();
  // 실험이 꺼져 있으면 TF 행을 그리지 않는다 — 순서·소속 저장은 그대로 두어 다시 켜면 돌아온다.
  const tfSummaries = taskforceExperiment.enabled ? allTaskforces : EMPTY_TASKFORCE_SUMMARIES;
  const sidebarOrder = useSidebarOrder();
  useEffect(() => {
    for (const row of tfSummaries) {
      const snapshot = readTaskforce(row.id);
      if (!snapshot.loaded && !snapshot.error && row.preview && (!row.preview.text.trim() || row.preview.speaker.kind === "system" && row.preview.speaker.code !== "created")) void loadTaskforce(row.id);
    }
  }, [tfSummaries]);
  const faces = useMemo((): readonly SideBarFace[] => {
    const order = pendingOrder ?? sidebarOrder;
    const rank = (id: string) => { const index = order.indexOf(id); return index === -1 ? order.length : index; };
    return [
      ...commodoreSections.map((section): SideBarFace => ({ kind: "commodore", id: section.commodoreId, section })),
      ...tfSummaries.map((row): SideBarFace => ({ kind: "taskforce", id: row.id, row })),
    ].sort((left, right) => rank(left.id) - rank(right.id));
  }, [commodoreSections, tfSummaries, pendingOrder, sidebarOrder]);
  const hasSections = sidebarSections.layout.sections.length > 0;
  const sidebarBuckets = commodoreSidebarBuckets(sidebarSections.layout, faces, (face) => face.id);
  // 접힌 머리에도 남는 결정 대기 — 사람이 답할 차례인 결정 요청이 있는 사령관 UUID. 펼친 목록의 줄과 같은
  // 묶음 판정(`clusterHasPersonDecision`)이라, 채팅을 열어 보고 답 없이 떠나도 머리의 아바타 상태가 유지된다.
  const clusterIndex = useClusterIndex();
  const personDecisionOwners = useMemo(() => {
    const owners = new Set<string>();
    for (const cluster of clusterIndex.clusters) {
      if (cluster.commodoreId !== undefined && clusterHasPersonDecision(cluster)) owners.add(cluster.commodoreId);
    }
    return owners;
  }, [clusterIndex]);
  const contextMenuFace: SideBarFace | null = activeContextMenu
    ? faces.find((face) => face.id === activeContextMenu.theaterId) ?? null
    : null;

  // window 이벤트 핸들러에서 commit 시점 최신값을 읽기 위해 매 렌더 ref를 동기화한다.
  useEffect(() => {
    orderedTheaterIdsRef.current = faces.map((face) => face.id);
    sidebarSectionsRef.current = sidebarSections;
  });

  const updateDrag = (next: TheaterDragState | null) => {
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
      autoScrollSideBar(event.clientY, listRef.current);
      const dropIndex = theaterDropIndexFromPoint(event.clientY, orderedTheaterIdsRef.current, listRef.current, current.sourceTheaterId);
      const sectionDrop = sidebarSectionsRef.current.layout.sections.length
        ? commodoreSectionDropFromPoint(event.clientX, event.clientY, listRef.current, current.sourceTheaterId) : undefined;
      updateDrag({ ...current, currentY: event.clientY, dragging: true, dropIndex, sectionDrop });
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== dragPointerId) return;
      const snap = dragRef.current;
      updateDrag(null);
      if (!snap?.dragging) return;
      if (sidebarSectionsRef.current.layout.sections.length) {
        if (snap.sectionDrop) void sidebarSectionsRef.current.run({ op: "move", rowId: snap.sourceTheaterId, ...snap.sectionDrop });
        return;
      }
      const nextTheaterIds = reorderTheaterIds(orderedTheaterIdsRef.current, snap.sourceTheaterId, snap.dropIndex);
      if (nextTheaterIds.join("\0") === orderedTheaterIdsRef.current.join("\0")) return;
      setOrderError(null);
      setPendingOrder(nextTheaterIds);
      void saveCommodoreOrder({ commodoreIds: nextTheaterIds }).then((result) => {
        replaceCommodoreList(result.commodores);
        replaceSidebarOrder(result.order);
        setPendingOrder(null);
      }).catch(() => {
        setPendingOrder(null);
        setOrderError(t("sidebar.commodore.orderFailed"));
      });
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

  const beginTheaterPointerDrag = (event: ReactPointerEvent<HTMLDivElement>, theaterId: string) => {
    if (event.button !== 0) return;
    const orderedTheaterIds = orderedTheaterIdsRef.current;
    if (!orderedTheaterIds.includes(theaterId)) return;
    setActiveContextMenu(null);
    updateDrag({
      sourceTheaterId: theaterId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentY: event.clientY,
      dragging: false,
      dropIndex: orderedTheaterIds.indexOf(theaterId),
    });
  };

  // 사령관 메뉴는 누른 그 사령관을 대상으로 한다(전환하지 않는다). 길게 누르기는 손가락이 아직 머리 위에 있을 때 열리므로,
  // 그 누름이 세워 둔 끌기 대기를 거둔다 — 메뉴가 열린 뒤 손가락이 미끄러져도 사령관이 옮겨지지 않는다.
  const openTheaterMenu = (theaterId: string, anchor: DOMRect, returnFocus: HTMLElement | null, atCursor: boolean, focusFirst = false) => {
    if (dragRef.current && !dragRef.current.dragging) updateDrag(null);
    setActiveContextMenu({ theaterId, anchor, returnFocus, atCursor, focusFirst });
  };

  const openTheaterBrowser = (commodoreId: string) => {
    setActiveContextMenu(null);
    setBrowserCommodoreId(commodoreId);
    setAddFailure(null);
    setBrowserOpen(true);
  };

  const cancelTheaterBrowser = () => {
    setBrowserOpen(false);
    setBrowserCommodoreId(null);
  };

  const confirmTheaterBrowser = (path: string) => {
    const commodoreId = browserCommodoreId;
    setBrowserOpen(false);
    setBrowserCommodoreId(null);
    if (!commodoreId) return;
    void onAddTheater(commodoreId, path).catch((error: unknown) => {
      setAddFailure(error instanceof Error ? error.message : String(error));
    });
  };

  // 사이드바 빈 영역 우클릭 = 맨 위 「+」와 같은 새 세션 화면. 사령관 머리는 자체 우클릭 핸들러가 preventDefault()를
  // 호출하므로(버블로 도달 시 defaultPrevented=true) 그쪽 메뉴를 지키고 여기서는 무시한다.
  const openNewSessionAtCursor = (event: MouseEvent<HTMLElement>) => {
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
    menuSelector: '.side-bar-theater-menu[role="menu"]',
    returnFocusRef: contextMenuReturnFocusRef,
    focusFirst: activeContextMenu?.focusFirst,
    onEscape: closeActiveContextMenu,
  });

  // 활성 사령관을 한 번 더 골랐다 — 머리의 이름 쪽이든 아바타(표식) 쪽이든 같은 규칙이다. 펼침 유지가 켜진 대화 중심
  // 화면에서는 그 사령관 대화가 이미 서 있을 때만 목록을 접는다 — 지휘관 대화를 보다가 머리를 누른 것은 사령관 대화로
  // 돌아가는 이동이므로 펼침을 유지한다(접혀 있으면 펼친다). 꺼져 있으면 바뀌지 않는다. 대화 중심 화면이 아니면(모바일)
  // 예전 토글을 둔다.
  const reselectActiveCommodore = (commodoreId: string) => {
    if (commodoreId !== owningCommodoreId) return;
    const keepExpanded = readCommanderKeepExpanded();
    if (keepExpanded && isCommodoreConversationActive() && !isCommodoreConversationOpen(commodoreId)) {
      ensureCommanderExpanded(commodoreId);
      return;
    }
    reselectCommander(commodoreId, keepExpanded);
  };

  // 사령관 머리 — 그 사령관의 대화. 대화를 세울 수 없으면 첫 칸은 기여가 정한다(예: 자율 운영이 켜졌으면 사령관 기록). 아무도
  // 정하지 않으면 사령관 기록 칸이다.
  const openTheaterHeaderInbox = (theater: SideBarHead, returnFocus: HTMLElement | null) => {
    setActiveContextMenu(null);
    reselectActiveCommodore(theater.id);
    setZoneCommodore(theater.id);
    if (openCommodoreConversation(theater.id)) return;
    const landing = resolveTheaterInboxLanding(registry.theaterContributions, theater.id);
    if (landing) openTheaterInbox({ theaterId: theater.id, ...landing, returnFocus });
    else openTheaterInbox({ theaterId: theater.id, sectionId: "commodore:commodore", pageId: "log", returnFocus });
  };

  // "Theater 추가" 요청 소비(팔레트) — 그 사령관의 폴더 브라우저를 연다.
  useEffect(() => {
    const commodoreId = pendingSideBarAddTheater;
    if (!commodoreId) return;
    consumeSideBarAddTheater();
    openTheaterBrowser(commodoreId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSideBarAddTheater]);

  const startAliasEdit = (theaterId: string) => {
    setActiveContextMenu(null);
    setAliasEditingTheaterId(theaterId);
  };
  const finishAliasEdit = (theaterId: string, alias: string | null | undefined) => {
    setAliasEditingTheaterId((current) => (current === theaterId ? null : current));
    if (alias !== undefined) {
      setAliasError(null);
      void setCommodoreAlias(theaterId, alias).then(() => refreshCommodoreList()).catch(() => setAliasError(t("sidebar.commodore.aliasFailed")));
    }
  };
  const aliasEditingFor = (theaterId: string): TheaterAliasEditing => ({
    clampAlias,
    editingAlias: aliasEditingTheaterId === theaterId,
    onStartAliasEdit: startAliasEdit,
    onFinishAliasEdit: finishAliasEdit,
  });

  return (
    <aside
      className={`objective-records-side-bar${compact ? " is-compact" : ""}`}
      ref={rootRef}
      data-resizing={resizing ? "true" : undefined}
      data-snapping={snapping ? "true" : undefined}
      style={{ "--side-bar-width": `${width}px` } as CSSProperties}
      onContextMenu={openNewSessionAtCursor}
    >
      <div className="side-bar-top-strip is-compact">
        <span className="side-bar-top-strip-spacer" aria-hidden="true" />
        {topStripTrailing}
      </div>

      {!compact ? <ConsoleSectionSlot compact={false} /> : null}
      <div className="side-bar-wide">
      {addFailure ? <p className="side-bar-theater-error" role="alert">{addFailure}</p> : null}
      {aliasError ? <p className="side-bar-theater-error" role="alert">{aliasError}</p> : null}
      {orderError ? <p className="side-bar-theater-error" role="alert">{orderError}</p> : null}
      {sidebarSections.error ? <p className="side-bar-theater-error" role="alert">{t("sidebar.commodoreSection.error")}</p> : null}
      <ol className="objective-records-side-bar-chips" ref={listRef} aria-label={t("sidebar.list.aria")}>
        {sidebarBuckets.map((bucket) => {
          const rows = bucket.rows.map((face) => {
          const theaterIndex = faces.indexOf(face);
          const isTheaterDragging = drag?.sourceTheaterId === face.id && drag.dragging;
          const theaterDragOffsetY = isTheaterDragging ? drag.currentY - drag.startY : 0;
          const theaterDropBefore = hasSections ? drag?.sectionDrop?.targetId === face.id && !drag.sectionDrop.after
            : drag !== null && drag.dragging && drag.sourceTheaterId !== face.id && drag.dropIndex === theaterIndex;
          const theaterDropAfter = hasSections ? drag?.sectionDrop?.targetId === face.id && drag.sectionDrop.after
            : drag !== null && drag.dragging && drag.sourceTheaterId !== face.id && theaterIndex === faces.length - 1 && drag.dropIndex === faces.length;
          // TF 행은 사령관 행과 같은 카드·드래그·섹션 소속을 쓰고, 내용만 TF 것(멤버 묶음·이름·미리보기·판단 중)을 세운다.
          if (face.kind === "taskforce") {
            const selected = face.id === selectedTaskforceId;
            return (
              <li
                key={face.id}
                className={[
                  "side-bar-theater-section",
                  selected ? "side-bar-theater-section--active" : "",
                  theaterDropBefore ? "side-bar-theater-section--drop-before" : "",
                  theaterDropAfter ? "side-bar-theater-section--drop-after" : "",
                ].filter(Boolean).join(" ")}
                data-theater-id={face.id}
              >
                <TheaterSectionHeader
                  theater={{ id: face.id, label: face.row.name, createdAt: "", lastOpenedAt: "", activeAdmiralCount: 0 }}
                  active={selected}
                  lastResponse={face.row.preview?.text || face.row.topic}
                  dock={false}
                  editingAlias={false}
                  clampAlias={clampAlias}
                  onStartAliasEdit={() => {}}
                  onFinishAliasEdit={() => {}}
                  showStatusLiveTick={false}
                  liveOverride={face.row.judging.length > 0}
                  selectedOverride={selected}
                  dragging={isTheaterDragging}
                  dropTarget={theaterDropBefore}
                  dragOffsetY={theaterDragOffsetY}
                  onOpenInbox={() => openTaskforce(face.id)}
                  onContextMenu={(anchor, returnFocus, atCursor, focusFirst) => openTheaterMenu(face.id, anchor, returnFocus, atCursor, focusFirst)}
                  menuTarget={activeContextMenu?.theaterId === face.id}
                  onPointerDragStart={beginTheaterPointerDrag}
                  avatarOverride={
                    <span className="side-bar-theater-anchor is-avatar" aria-hidden="true">
                      <TaskforceStack members={face.row.members} judging={face.row.judging} />
                    </span>
                  }
                />
              </li>
            );
          }
          const theater: SideBarHead = {
            id: face.section.commodoreId,
            label: face.section.alias ?? face.section.label,
            createdAt: "",
            lastOpenedAt: "",
            activeAdmiralCount: 0,
            commodore: { id: face.section.commodoreId, ...(face.section.alias ? { alias: face.section.alias } : {}) },
          };
          const commanderRecords = objectiveRecords.filter((objectiveRecord) => objectiveRecord.commodoreId === theater.id);
          const waitingCount = countAwaitingObjectiveRecords(commanderRecords, objectiveRecordRuntime);
          // 사령관 섹션의 지휘관 목록 펼침 — 펼침 묶음은 사령관을 옮길 때 정해진다. 접힌 섹션은 마운트하지 않는다.
          // 아바타만 서는 좁은 열에는 목록을 두지 않는다 — 창을 넓히면 저장된 펼침대로 돌아온다.
          const sectionExpanded = !compact && expandedCommanders.has(theater.id);
          // 가운데 채팅이 가리키는 지휘관 — 왼쪽 목록이 이 선택을 말한다.
          const selectedCommanderId =
            typeof surface?.params.objectiveId === "string" && surface.params.commodoreId === theater.id
              ? surface.params.objectiveId
              : objectiveOwner === theater.id ? activeObjectiveId : null;
          return (
            <li
              key={theater.id}
              className={[
                "side-bar-theater-section",
                theater.id === owningCommodoreId ? "side-bar-theater-section--active" : "",
                theaterDropBefore ? "side-bar-theater-section--drop-before" : "",
                theaterDropAfter ? "side-bar-theater-section--drop-after" : "",
              ].filter(Boolean).join(" ")}
              data-theater-id={theater.id}
            >
              <TheaterSectionHeader
                theater={theater}
                active={theater.id === owningCommodoreId}
                lastResponse={commodoreSections.find((section) => section.commodoreId === theater.id)?.lastResponse?.text}
                // ⋯ 호버 독은 사령관 행에 달되, 아바타만 서는 좁은 열에는 두지 않는다.
                dock={!compact}
                onReselect={() => reselectActiveCommodore(theater.id)}
                {...aliasEditingFor(theater.id)}
                showStatusLiveTick={waitingCount > 0}
                hasPersonDecision={personDecisionOwners.has(theater.id)}
                dragging={isTheaterDragging}
                dropTarget={theaterDropBefore}
                dragOffsetY={theaterDragOffsetY}
                onOpenInbox={openTheaterHeaderInbox}
                onContextMenu={(anchor, returnFocus, atCursor, focusFirst) => openTheaterMenu(theater.id, anchor, returnFocus, atCursor, focusFirst)}
                menuTarget={activeContextMenu?.theaterId === theater.id}
                onPointerDragStart={beginTheaterPointerDrag}
              />
              {sectionExpanded ? (
                <div className="side-bar-commander-list" data-keep-objective-active="">
                  <SidebarCommanderList
                    hideSettled={!showSettled}
                    commodoreId={theater.id}
                    selectedId={selectedCommanderId}
                  />
                </div>
              ) : null}
            </li>
          );
          });
          return bucket.id === undefined ? rows : <CommodoreSidebarSection key={bucket.id ?? "none"} id={bucket.id} controller={sidebarSections} count={bucket.rows.length}
            dropTarget={!!drag?.dragging && !!drag.sectionDrop && !drag.sectionDrop.targetId && drag.sectionDrop.sectionId === bucket.id}>{rows}</CommodoreSidebarSection>;
        })}
        {faces.length === 0 && commodoresLoaded ? (
          // 사령관이 없는 사이드바는 목록이 아니라 시작 화면이다 — 유령 행 하나로 빈 높이를 남기지 않고,
          // 첫 행동(사령관 만들기)을 이 자리에서 바로 연다. 취역 가이드는 한 번 닫히면 사라지므로
          // 되돌아가는 길도 여기 둔다.
          <li className="side-bar-starter" data-testid="side-bar-starter">
            <span className="side-bar-starter-eyebrow">{t("sidebar.starter.eyebrow")}</span>
            <h2 className="side-bar-starter-title">{t("sidebar.starter.title")}</h2>
            <p className="side-bar-starter-body">{t("sidebar.starter.body")}</p>
            <button
              type="button"
              className="side-bar-starter-primary"
              onClick={requestCommodoreCreate}
            >
              {t("sidebar.commodore.createTitle")}
            </button>
            <button type="button" className="side-bar-starter-secondary" onClick={openOnboarding}>
              {t("sidebar.starter.reopenGuide")}
            </button>
            <p className="side-bar-starter-hints">
              <kbd>{searchShortcut}</kbd> {t("sidebar.starter.hintSearch")}
            </p>
          </li>
        ) : null}
      </ol>
      </div>

      {compact ? <ConsoleSectionSlot compact /> : null}
      {bottomAccessory}
      <SideBarResizeHandle onPointerDown={onResizePointerDown} />

      {activeContextMenu && contextMenuFace?.kind === "commodore" ? (
        <TheaterActionsMenu
          sections={sidebarSections}
          theater={{
            id: contextMenuFace.section.commodoreId,
            label: contextMenuFace.section.alias ?? contextMenuFace.section.label,
            createdAt: "",
            lastOpenedAt: "",
            activeAdmiralCount: 0,
            commodore: { id: contextMenuFace.section.commodoreId, ...(contextMenuFace.section.alias ? { alias: contextMenuFace.section.alias } : {}) },
          }}
          anchor={activeContextMenu.anchor}
          atCursor={activeContextMenu.atCursor === true}
          onDeleteCommodore={() => {
            const id = contextMenuFace.section.commodoreId;
            const opener = document.querySelector<HTMLElement>(`[data-theater-id="${CSS.escape(id)}"] .side-bar-theater-activate`);
            setActiveContextMenu(null);
            requestCommodoreDelete(id, opener);
          }}
          onAddTheater={() => openTheaterBrowser(contextMenuFace.section.commodoreId)}
          onNewSession={() => {
            openCommodoreNewSession(contextMenuFace.section.commodoreId);
            closeActiveContextMenu();
          }}
          onEditAlias={() => startAliasEdit(contextMenuFace.section.commodoreId)}
          onClose={closeActiveContextMenu}
        />
      ) : null}
      {activeContextMenu && contextMenuFace?.kind === "taskforce" ? (
        <TaskforceRowMenu
          id={contextMenuFace.id}
          anchor={activeContextMenu.anchor}
          focusFirst={activeContextMenu.focusFirst}
          returnFocus={activeContextMenu.returnFocus ?? null}
          onClose={closeActiveContextMenu}
        />
      ) : null}
      <DirectoryBrowserModal open={browserOpen} onCancel={cancelTheaterBrowser} onConfirm={confirmTheaterBrowser} />
    </aside>
  );
}

/** 그 사령관에서 사람의 답을 기다리는 Objective 수 — 사령관 카드 요약과 대기 틱은 미확인 도착을 세지 않는다. */
function countAwaitingObjectiveRecords(
  objectiveRecords: readonly ObjectiveRecord[],
  objectiveRecordRuntime: Readonly<Record<string, ObjectiveRuntimeState>>,
): number {
  return objectiveRecords.filter((objectiveRecord) =>
    resolveObjectiveActivity(objectiveRecord, objectiveRecordRuntime) === "awaiting").length;
}

function TheaterSectionHeader({
  theater,
  active,
  lastResponse,
  dock,
  onReselect,
  editingAlias,
  clampAlias,
  showStatusLiveTick,
  hasPersonDecision = false,
  liveOverride,
  selectedOverride,
  dragging,
  dropTarget,
  dragOffsetY,
  onOpenInbox,
  onContextMenu,
  menuTarget,
  onStartAliasEdit,
  onFinishAliasEdit,
  onPointerDragStart,
  avatarOverride,
}: TheaterSectionHeaderProps) {
  const t = useT();
  // 사령관 카드 — 아바타와 이름 아래에 사령관의 마지막 응답만 싣는다.
  const suppressClickRef = useRef(false);
  const activateRef = useRef<HTMLButtonElement | null>(null);
  // 플러그인 표식(자율 운영의 사령관 글리프)이 있으면 이니셜 칩 자리에 선다. 운영자가 일하는 동안 이름에 라이브 물결이 흐른다.
  const contributionSummary = useMemo(() => ({ id: theater.id, label: theater.label }), [theater.id, theater.label]);
  const contributedMark = useTheaterContributionMark(contributionSummary);
  // 자기 아바타를 가진 행(TaskForce)은 사령관 표식을 받지 않는다 — 표식이 TF id를 사령관으로 그리지 않게 한다.
  const mark = avatarOverride ? null : contributedMark;
  const contributedLive = useTheaterHeaderLive(theater.id);
  const live = liveOverride ?? contributedLive;
  const contributedSelected = useTheaterHeaderSelected(theater.id);
  const selected = selectedOverride ?? contributedSelected;
  // 별칭 편집을 키(Enter·Esc)로 마치면 포커스가 머리로 돌아온다. 다른 곳을 눌러 끝냈으면(blur) 그 자리의 포커스를 빼앗지 않는다.
  const wasEditingRef = useRef(editingAlias);
  const keyFinishRef = useRef(false);
  useEffect(() => {
    if (wasEditingRef.current && !editingAlias && keyFinishRef.current) activateRef.current?.focus({ preventScroll: true });
    if (!editingAlias) keyFinishRef.current = false;
    wasEditingRef.current = editingAlias;
  }, [editingAlias]);
  const displayName = theater.commodore?.alias ?? theater.label;
  const summaryText = lastResponse ?? t("sidebar.commodore.noConversation");
  // 사령관이 자기 세션으로 플릿 브라우저를 쓰는 동안 둘째 줄이 그 도구를 말한다 — 목표 줄이 지휘관의 사용을 말하는 것과 같은 문구·물결이다.
  // 그 사령관의 목표가 쓰는 것은 목표 줄의 몫이고, 자기 아바타를 가진 행(TaskForce)은 사령관이 아니다.
  const browsing = useCommodoreBrowserUse(avatarOverride ? null : theater.commodore?.id ?? null);
  const headerClassName = [
    "side-bar-theater-header",
    active ? "is-active" : "",
    selected ? "is-current" : "",
    "is-card",
    menuTarget ? "is-menu-target" : "",
    dragging ? "side-bar-theater-header--dragging" : "",
    dropTarget ? "side-bar-theater-header--drop-target" : "",
  ].filter(Boolean).join(" ");
  const headerStyle = dragging ? ({ "--drag-dy": `${Math.round(dragOffsetY)}px` } as CSSProperties) : undefined;

  // Theater 동작(별칭·시스템 프롬프트·플러그인 항목·새 그룹·Theater 잊기)은 머리에서 연다 — 우클릭은 커서 자리에, 키(ContextMenu·
  // Shift+F10)와 터치·펜 길게 누르기는 머리 아래에. 두 배치(기존·대화 중심) 모두 같다. 머리 오른쪽 끝의 ⋯ 호버 독은 이 메뉴가 아니라 새 목표·정렬·목록 위치·펼침 유지만 연다.
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
    onContextMenu(event.currentTarget.getBoundingClientRect(), event.currentTarget, false, true);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 표식 안의 단추(자율 운영 끄기)와 별칭 입력·호버 독에서 시작한 포인터는 드래그가 아니다. 활성화 버튼은
    // 행의 본문이므로 배제하지 않는다 — 배제하면 행을 잡아 옮길 수 없다.
    // 길게 누르기도 같은 자리만 받는다 — 단추 위 길게 누르기는 그 단추의 것이다.
    if (event.target instanceof Element && (event.target.closest(".side-bar-theater-mark button") || event.target.closest(".side-bar-theater-alias-input") || event.target.closest(".commodore-dock"))) return;
    longPress.onPointerDown(event);
    onPointerDragStart(event, theater.id);
  };

  const handlePointerUp = () => {
    longPress.onPointerUp();
    if (dragging) suppressClickRef.current = true;
  };

  // 표식 단추는 자기 클릭을 끝까지 처리하고 버블을 멈춘다 — 활성 사령관 재선택은 캡처 단계에서 먼저 알린다.
  const markClickCapture = (event: MouseEvent<HTMLSpanElement>) => {
    if (event.target instanceof Element && event.target.closest("button")) onReselect?.();
  };

  // 이름은 사령관의 대화를 연다.
  const select = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onOpenInbox(theater, activateRef.current);
  };
  const avatarAnchor = (tick: boolean) => (
    <span className="side-bar-theater-anchor is-avatar" aria-hidden="true">
      {/* 표식이 없을 때의 사령관 머리 — 결정 요청이 남아 있으면 답하기 전까지 결정 얼굴로 선다(열람으로 지워지지 않는다). */}
      <KeyedAvatar avatarKey={commodoreAvatarKey(theater.id)} role="commodore" state={hasPersonDecision ? "decision" : "idle"} size={32} label="" decorative />
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
          onClickCapture={markClickCapture}
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
            <TheaterAliasInput clampAlias={clampAlias} theater={theater} onDone={(alias, viaKey) => { keyFinishRef.current = viaKey; onFinishAliasEdit(theater.id, alias); }} />
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
          aria-current={selected ? "true" : undefined}
          title={`${active ? t("sidebar.theater.openInbox", { theater: displayName }) : t("sidebar.theater.switchTo", { theater: displayName })} · ${t("sidebar.theater.actionsHint")}`}
        >
          {mark === null ? avatarOverride ?? avatarAnchor(true) : null}
          <span className="side-bar-theater-text">
            <span className={`side-bar-theater-name${live ? " is-live" : ""}`} onDoubleClick={() => onStartAliasEdit(theater.id)}>{displayName}</span>
            <span className={`side-bar-theater-swap${browsing ? " is-tool-using" : ""}`}>
              <span className="side-bar-theater-sub">{summaryText}</span>
              <RowToolUse tool={browsing ? "browser" : null} label={browsing ? t("sidebar.row.use.browser") : null} />
            </span>
          </span>
        </button>
      )}
      {/* 호버 독 — 머리에 호버하거나 초점이 오면 ⋯ 글리프가 나오고, 거기서 새 목표·정렬·목록 위치·펼침 유지가 펼쳐진다. 머리를 누르는 활성화와는 따로 논다. */}
      {dock ? <CommodoreHoverDock commodoreId={theater.id} name={displayName} /> : null}
    </div>
  );
}

/**
 * 머리 자리의 별칭 입력 — Enter 는 저장, Esc 나 다른 곳을 누르면 취소, 비우고 저장하면 해제다. 바뀐 것이 없으면 저장하지 않는다.
 * IME 조합 중의 Enter·Esc 는 조합의 것이라 편집을 끝내지 않는다.
 */
function TheaterAliasInput({ theater, clampAlias, onDone }: { readonly clampAlias: (value: string) => string; readonly theater: SideBarHead; readonly onDone: (alias: string | null | undefined, viaKey: boolean) => void }) {
  const t = useT();
  const [value, setValue] = useState(theater.commodore?.alias ?? "");
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
    const next = clampAlias(value).trim();
    finish(next === (theater.commodore?.alias ?? "") ? undefined : next.length > 0 ? next : null, true);
  };
  return (
    <input
      ref={inputRef}
      className="side-bar-theater-alias-input"
      type="text"
      value={value}
      placeholder={theater.label}
      aria-label={t("sidebar.theater.alias.inputAria", { theater: theater.label })}
      onChange={(event) => setValue(composingRef.current ? event.target.value : clampAlias(event.target.value))}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={(event) => { composingRef.current = false; setValue(clampAlias(event.currentTarget.value)); }}
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

function TheaterActionsMenu({ sections, theater, anchor, atCursor = false, onDeleteCommodore, onAddTheater, onNewSession, onEditAlias, onClose }: TheaterActionsMenuProps) {
  const t = useT();
  const tf = taskforceT(useConsoleLocale());
  const { enabled: taskforceEnabled } = useTaskforceExperiment();
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
  }, [anchor, atCursor]);

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

  return createPortal(
    <div className="group-context-menu-overlay" data-native-browser-transparent role="presentation" onPointerDown={onClose}>
      <div
        ref={menuRef}
        className="theater-menu side-bar-theater-menu"
        role="menu"
        aria-label={t("sidebar.theater.actionsMenuAria", { theater: theater.commodore?.alias ?? theater.label })}
        style={{
          position: "fixed",
          left: menuPosition.left,
          top: menuPosition.top,
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <CommodoreSectionMoveMenu rowId={theater.id} controller={sections} onClose={onClose} />
        <div className="theater-menu-divider" aria-hidden="true" />
        {/* 사령관 별칭 — 사이드바 줄 자리에서 바로 편집한다(F2·이름 더블클릭도 같다). */}
        <button type="button" role="menuitem" className="theater-menu-item theater-menu-alias" onClick={onEditAlias}>
          <span className="theater-menu-check" aria-hidden="true"><PencilIcon /></span>
          <span className="theater-menu-label">{t("sidebar.commodore.rename")}</span>
        </button>
        <div className="theater-menu-divider" aria-hidden="true" />
        <button type="button" role="menuitem" className="theater-menu-item" onClick={onNewSession}>
          <span className="theater-menu-check" aria-hidden="true"><PlusIcon /></span>
          <span className="theater-menu-label">{t("sidebar.commodore.newSession")}</span>
        </button>
        {taskforceEnabled ? <button type="button" role="menuitem" className="theater-menu-item" onClick={() => { onClose(); requestTaskforceCreate(theater.id); }}>
          <span className="theater-menu-check" aria-hidden="true"><TaskforceIcon /></span>
          <span className="theater-menu-label">{tf("taskforce.fromCommodore")}</span>
        </button> : null}
        <button type="button" role="menuitem" className="theater-menu-item" onClick={onAddTheater}>
          <span className="theater-menu-check" aria-hidden="true"><FolderIcon /></span>
          <span className="theater-menu-label">{t("sidebar.commodore.addTheater")}</span>
        </button>
        <TheaterContributionMenuItems theater={theater} onClose={onClose} />
        {onDeleteCommodore ? (
          <>
            <div className="theater-menu-divider" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              className="theater-menu-item theater-menu-forget"
              onClick={onDeleteCommodore}
            >
              <span className="theater-menu-check" aria-hidden="true"><TrashIcon /></span>
              <span className="theater-menu-label">{t("sidebar.commodore.delete")}</span>
            </button>
          </>
        ) : null}
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

/** Console Use 시선 — 에이전트가 이 Theater 의 목록을 훑거나 그룹을 만지면 헤더에 점이 두 번 맥동한다. */
