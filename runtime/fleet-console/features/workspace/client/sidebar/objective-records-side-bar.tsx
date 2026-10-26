import { useViewedTheaterId } from "../../../../core/client/src/integration/viewed-theater.js";
import { ConsoleSectionSlot } from "../../../remote-access/client/console-section-slot.js";
export { theaterInitials } from "./theater-initials.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { consoleUseWrapClassName, gestureCallerLabel, getAnyClusterListWrap, getTheaterWrap, subscribeConsoleUseGestures } from "../../../console-use/client/gestures.js";
import { createPortal } from "react-dom";

import type { ObjectiveRuntimeState } from "../../../execution/shared/client-contract.js";

import { useT } from "../../../../core/client/src/i18n/index.js";
import type { ObjectiveRecord, TheaterInfo } from "../../../../core/client/src/integration/types.js";
import { useSearchShortcutLabel } from "../../../../core/client/src/integration/shortcuts.js";
import { DirectoryBrowserModal } from "../../../../core/client/src/chrome/components/directory-browser-modal.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { openCommodoreNewSession, openDefaultNewSession } from "../conversation/new-session-entry.js";
import { openCommodoreConversation } from "../../../commodore/client/commodore-conversation.js";
import { requestCommodoreDelete } from "../../../commodore/client/commodore-delete-modal.js";
import { requestCommodoreCreate } from "../../../commodore/client/commodore-create-modal.js";
import { refreshCommodoreList, replaceCommodoreList, setZoneCommodore, useSidebarCommodores } from "../../../commodore/client/commodore-list.js";
import { saveCommodoreOrder } from "../../../commodore/client/theaters-api.js";
import { setCommodoreAlias } from "../../../../core/client/src/integration/api.js";
import { commodoreAvatarKey } from "../../shared/avatars.js";
import { KeyedAvatar } from "../avatars.js";
import { consumeSideBarAddTheater, openOnboarding } from "../../../../core/client/src/integration/store.js";
import { useFeatureRegistry } from "../../../../core/client/src/integration/feature-registry.js";
import { resolveTheaterInboxLanding, TheaterContributionMenuItems, TheaterContributionRows, useTheaterContributionMark, useTheaterHeaderLive, useTheaterHeaderSelected } from "../theater-contributions.js";
import { openTheaterInbox } from "../theater-inbox/store.js";
import { resolveObjectiveActivity } from "../../../execution/client/objective-activity.js";
import { reorderTheaterIds, theaterDropIndexFromPoint } from "./objective-records-side-bar-hit-test.js";
import { useContextMenuKeyboard } from "./context-menu-keyboard.js";
import { useAvatarClaims } from "../avatars.js";
import { TheaterAvatar } from "../theater-avatar.js";
import { useLongPress } from "../long-press.js";
import { anchorElementAt, scrollMovesAnchor } from "../anchored-scroll-dismissal.js";
import { setTheaterCollapsed, useCollapsedTheaters, useSideBarState } from "./objective-records-side-bar-store.js";
import { sideBarRowItems } from "./side-bar-cluster-row.js";
import { useClusterIndex } from "../objective-clusters.js";
import { SideBarResizeHandle, useSideBarResize } from "./side-bar-resize.js";

/*
 * 왼쪽 사이드바 — 사령관 목록이다. 사령관마다 머리(아바타·이름·지휘관 수와 답을 기다리는 수) 하나와 그 사령관의 기여 줄이 선다.
 * 지휘관 세션은 사령관 대화의 오른쪽 사이드바 「지휘관」 탭에 있다(commander-tab) — 여기서는 사령관을 고르고 옮기고 다룬다.
 */

interface ObjectiveRecordsSideBarProps {
  /** 대화 화면이 그리는 폭 상한(px). 저장된 폭 선호는 그대로 두고 그리는 폭만 깎는다. */
  readonly widthCap?: number;
  /** 맨 위 줄 오른쪽에 끼우는 단추들(대화 중심 화면의 검색·새로 만들기). */
  readonly topStripTrailing?: ReactNode;
  /** 맨 위 줄 가운데에 떠 있는 셸의 기여(대화 중심 화면의 출근한 부관 머리). 자리는 기여가 스스로 잰다. */
  readonly topStripCenter?: ReactNode;
  /** 사이드바 맨 아래에 서는 셸의 기여(호스트 아바타·플러그인 요약 줄). */
  readonly bottomAccessory?: ReactNode;
  readonly theaters: readonly TheaterInfo[];
  readonly objectiveRecords: readonly ObjectiveRecord[];
  readonly addingTheater: boolean;
  readonly theaterError: string | null;
  /** 사령관 별칭 지정 — null 은 해제다. */
  readonly clampAlias: (value: string) => string;
  readonly onAddTheater: (path: string) => void;
  readonly onCancelAddTheater: () => void;
  readonly onForgetTheater: (theaterId: string) => void;
}

/** atCursor — 우클릭으로 열었으면 앵커는 커서 한 점이고 메뉴는 그 자리에 선다. 아니면(키·길게 누르기) 앵커 아래에 선다. */
interface ActiveContextMenu {
  readonly theaterId: string;
  readonly anchor: DOMRect;
  readonly returnFocus?: HTMLElement | null;
  readonly atCursor?: boolean;
}

interface TheaterDragState {
  readonly sourceTheaterId: string;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly currentY: number;
  readonly dragging: boolean;
  readonly dropIndex: number;
}

/** 사령관 카드 둘째 줄의 요약 — 그 사령관의 지휘관(Objective) 수와 답을 기다리는 수. */
interface TheaterSummary {
  readonly commanders: number;
  readonly waiting: number;
}

/** 머리의 별칭 편집 — 한 번에 한 머리만 그 자리에서 편집한다. 끝낼 때 undefined 는 취소, null 은 해제다. */
interface TheaterAliasEditing {
  readonly clampAlias: (value: string) => string;
  readonly editingAlias: boolean;
  readonly onStartAliasEdit: (theaterId: string) => void;
  readonly onFinishAliasEdit: (theaterId: string, alias: string | null | undefined) => void;
}

interface TheaterSectionHeaderProps extends TheaterAliasEditing {
  readonly theater: TheaterInfo;
  readonly active: boolean;
  readonly collapsed: boolean;
  readonly summary: TheaterSummary;
  readonly showStatusLiveTick: boolean;
  readonly dragging: boolean;
  readonly dropTarget: boolean;
  readonly dragOffsetY: number;
  /** 머리를 눌렀을 때 — 그 사령관의 대화를 연다. */
  readonly onOpenInbox: (theater: TheaterInfo, returnFocus: HTMLElement | null) => void;
  readonly onToggleCollapsed: (theaterId: string) => void;
  /** 이 머리의 사령관 메뉴를 연다 — 우클릭은 커서 자리(atCursor), 키·길게 누르기는 앵커 아래. */
  readonly onContextMenu: (anchor: DOMRect, returnFocus: HTMLElement | null, atCursor: boolean) => void;
  /** 열린 사령관 메뉴가 이 머리를 대상으로 한다 — 활성이 아닌 사령관에서도 열리므로 머리가 대상을 말한다. */
  readonly menuTarget: boolean;
  readonly onPointerDragStart: (event: ReactPointerEvent<HTMLDivElement>, theaterId: string) => void;
  readonly onNewSession?: () => void;
}

interface TheaterActionsMenuProps {
  readonly theater: TheaterInfo;
  readonly anchor: DOMRect;
  /** 앵커가 커서 한 점이다 — 메뉴 윗변을 커서에 두고, 아래가 모자라면 커서 위로 뒤집는다. */
  readonly atCursor?: boolean;
  /** 등록 Theater 를 잊는다 — 사령관 행에는 없다(사령관은 Theater 가 아니다). */
  readonly onForgetTheater?: (() => void) | undefined;
  readonly onDeleteCommodore?: (() => void) | undefined;
  readonly onOpenZone: () => void;
  readonly onNewSession: () => void;
  readonly onEditAlias: () => void;
  readonly onClose: () => void;
}

const DRAG_THRESHOLD_PX = 6;
const AUTO_SCROLL_EDGE_PX = 34;
const AUTO_SCROLL_STEP_PX = 18;

export function ObjectiveRecordsSideBar({
  theaters,
  objectiveRecords,
  addingTheater,
  theaterError,
  clampAlias,
  onAddTheater,
  onCancelAddTheater,
  onForgetTheater,
  widthCap,
  topStripTrailing,
  topStripCenter,
  bottomAccessory,
}: ObjectiveRecordsSideBarProps) {
  const t = useT();
  const searchShortcut = useSearchShortcutLabel();
  const rootRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const sideBar = useSideBarState();
  // 좁은 창(대화 화면)에서는 아바타만 남은 열로 물러난다 — 사람이 정한 폭은 그대로 기억된다.
  const compact = sideBar.compact;
  const width = compact ? sideBar.compactWidth : widthCap === undefined ? sideBar.width : Math.min(sideBar.width, widthCap);
  const viewedTheaterId = useViewedTheaterId();
  const [drag, setDrag] = useState<TheaterDragState | null>(null);
  const dragRef = useRef<TheaterDragState | null>(null);
  const orderedTheaterIdsRef = useRef<string[]>([]);
  const contextMenuReturnFocusRef = useRef<HTMLElement | null>(null);
  const [activeContextMenu, setActiveContextMenu] = useState<ActiveContextMenu | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [aliasEditingTheaterId, setAliasEditingTheaterId] = useState<string | null>(null);
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [pendingOrder, setPendingOrder] = useState<readonly string[] | null>(null);
  const { resizing, onPointerDown: onResizePointerDown } = useSideBarResize();
  const collapsedTheaters = useCollapsedTheaters();
  const { objectiveRecordRuntime, pendingSideBarAddTheater, groups } = useConsoleState();
  // 몽글 아바타 처음 배정 — 사이드바 한 곳이 사령관·Objective 이 처음 보일 때 묶음째 뽑아 저장한다.
  useAvatarClaims();
  const clusterIndex = useClusterIndex();
  const registry = useFeatureRegistry();

  // 사이드바 행은 사령관(UUID)이다 — 등록 Theater 목록이 아니라 사령관 목록에서 선다.
  const commodoreSections = useSidebarCommodores(objectiveRecords, groups, t("sidebar.commodore.fallback"));
  const sectionFaces: TheaterInfo[] = commodoreSections.map((section) => ({
    id: section.commodoreId,
    label: section.alias ?? section.label,
    createdAt: "",
    lastOpenedAt: "",
    hasWiki: false,
    activeAdmiralCount: 0,
    commodore: { id: section.commodoreId, ...(section.alias ? { alias: section.alias } : {}) },
  }));
  const orderedFaces = pendingOrder === null ? sectionFaces : [...sectionFaces].sort((left, right) => {
    const rank = (id: string) => { const index = pendingOrder.indexOf(id); return index === -1 ? pendingOrder.length : index; };
    return rank(left.id) - rank(right.id);
  });
  const contextMenuTheater = activeContextMenu
    ? sectionFaces.find((theater) => theater.id === activeContextMenu.theaterId) ?? theaters.find((theater) => theater.id === activeContextMenu.theaterId) ?? null
    : null;

  // window 이벤트 핸들러에서 commit 시점 최신값을 읽기 위해 매 렌더 ref를 동기화한다.
  useEffect(() => {
    orderedTheaterIdsRef.current = orderedFaces.map((theater) => theater.id);
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
      updateDrag({ ...current, currentY: event.clientY, dragging: true, dropIndex });
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== dragPointerId) return;
      const snap = dragRef.current;
      updateDrag(null);
      if (!snap?.dragging) return;
      const nextTheaterIds = reorderTheaterIds(orderedTheaterIdsRef.current, snap.sourceTheaterId, snap.dropIndex);
      if (nextTheaterIds.join("\0") === orderedTheaterIdsRef.current.join("\0")) return;
      setOrderError(null);
      setPendingOrder(nextTheaterIds);
      void saveCommodoreOrder({ commodoreIds: nextTheaterIds }).then((result) => {
        replaceCommodoreList(result.commodores);
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
  const openTheaterMenu = (theaterId: string, anchor: DOMRect, returnFocus: HTMLElement | null, atCursor: boolean) => {
    if (dragRef.current && !dragRef.current.dragging) updateDrag(null);
    setActiveContextMenu({ theaterId, anchor, returnFocus, atCursor });
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
    onEscape: closeActiveContextMenu,
  });

  // 사령관 머리 — 그 사령관의 대화. 대화를 세울 수 없으면 첫 칸은 기여가 정한다(예: 자율 운영이 켜졌으면 사령관 기록). 아무도
  // 정하지 않으면 사령관 기록 칸이다.
  const openTheaterHeaderInbox = (theater: TheaterInfo, returnFocus: HTMLElement | null) => {
    setActiveContextMenu(null);
    setZoneCommodore(theater.id);
    if (openCommodoreConversation(theater.id)) return;
    const landing = resolveTheaterInboxLanding(registry.theaterContributions, theater.id);
    if (landing) openTheaterInbox({ theaterId: theater.id, ...landing, returnFocus });
    else openTheaterInbox({ theaterId: theater.id, sectionId: "commodore:commodore", pageId: "log", returnFocus });
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
      style={{ "--side-bar-width": `${width}px` } as CSSProperties}
      onContextMenu={openNewSessionAtCursor}
    >
      <div className="side-bar-top-strip is-compact">
        <span className="side-bar-top-strip-spacer" aria-hidden="true" />
        {topStripCenter}
        {topStripTrailing}
      </div>

      {!compact ? <ConsoleSectionSlot compact={false} /> : null}
      <div className="side-bar-wide">
      {theaterError ? <p className="side-bar-theater-error">{theaterError}</p> : null}
      {aliasError ? <p className="side-bar-theater-error" role="alert">{aliasError}</p> : null}
      {orderError ? <p className="side-bar-theater-error" role="alert">{orderError}</p> : null}
      <ol className="objective-records-side-bar-chips" ref={listRef} aria-label={t("sidebar.list.aria")}>
        {orderedFaces.map((theater, theaterIndex) => {
          const commanderRecords = objectiveRecords.filter((objectiveRecord) => objectiveRecord.commodoreId === theater.id);
          const waitingCount = countAwaitingObjectiveRecords(commanderRecords, objectiveRecordRuntime);
          // 지휘관 수는 「지휘관」 탭의 줄 수와 같은 기준이다 — 아직 세션이 서지 않은 시작 전 목표도 그 사령관의 지휘관이다.
          const commanderCount = sideBarRowItems([], clusterIndex, new Set(commanderRecords.map((objectiveRecord) => objectiveRecord.id)), theater.id).length;
          const summary: TheaterSummary = { commanders: commanderCount, waiting: waitingCount };
          const theaterCollapsed = collapsedTheaters.includes(theater.id);
          const isTheaterDragging = drag?.sourceTheaterId === theater.id && drag.dragging;
          const theaterDragOffsetY = isTheaterDragging ? drag.currentY - drag.startY : 0;
          const theaterDropBefore = drag !== null && drag.dragging && drag.sourceTheaterId !== theater.id && drag.dropIndex === theaterIndex;
          const theaterDropAfter = drag !== null && drag.dragging && drag.sourceTheaterId !== theater.id
            && theaterIndex === orderedFaces.length - 1 && drag.dropIndex === orderedFaces.length;
          return (
            <li
              key={theater.id}
              className={[
                "side-bar-theater-section",
                theater.id === viewedTheaterId ? "side-bar-theater-section--active" : "",
                theaterDropBefore ? "side-bar-theater-section--drop-before" : "",
                theaterDropAfter ? "side-bar-theater-section--drop-after" : "",
              ].filter(Boolean).join(" ")}
              data-theater-id={theater.id}
            >
              <TheaterSectionHeader
                theater={theater}
                active={theater.id === viewedTheaterId}
                collapsed={theaterCollapsed}
                summary={summary}
                {...aliasEditingFor(theater.id)}
                showStatusLiveTick={waitingCount > 0}
                dragging={isTheaterDragging}
                dropTarget={theaterDropBefore}
                dragOffsetY={theaterDragOffsetY}
                onToggleCollapsed={toggleTheaterSectionCollapsed}
                onOpenInbox={openTheaterHeaderInbox}
                onContextMenu={(anchor, returnFocus, atCursor) => openTheaterMenu(theater.id, anchor, returnFocus, atCursor)}
                menuTarget={activeContextMenu?.theaterId === theater.id}
                onPointerDragStart={beginTheaterPointerDrag}
                onNewSession={() => openCommodoreNewSession(theater.id)}
              />
              {!theaterCollapsed && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(theater.id) ? <TheaterContributionRows theater={theater} /> : null}
            </li>
          );
        })}
        {orderedFaces.length === 0 ? (
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
              disabled={addingTheater}
            >
              {addingTheater ? t("sidebar.starter.addingTheater") : t("sidebar.commodore.createTitle")}
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

      {activeContextMenu && contextMenuTheater ? (
        <TheaterActionsMenu
          theater={contextMenuTheater}
          anchor={activeContextMenu.anchor}
          atCursor={activeContextMenu.atCursor === true}
          onForgetTheater={theaters.some((theater) => theater.id === contextMenuTheater.id) ? () => {
            onForgetTheater(contextMenuTheater.id);
            closeActiveContextMenu();
          } : undefined}
          onDeleteCommodore={contextMenuTheater.commodore?.id === contextMenuTheater.id ? () => {
            const id = contextMenuTheater.id;
            const opener = document.querySelector<HTMLElement>(`[data-theater-id="${CSS.escape(id)}"] .side-bar-theater-activate`);
            setActiveContextMenu(null);
            requestCommodoreDelete(id, opener);
          } : undefined}
          onOpenZone={() => {
            setZoneCommodore(contextMenuTheater.id);
            // 오른쪽 패널의 탭은 가운데에 대화가 선 동안만 선다 — 사령관 대화를 먼저 세우고 그 설정(맨 위가 Theater)을 연다.
            openCommodoreConversation(contextMenuTheater.id);
            openTheaterInbox({ theaterId: contextMenuTheater.id, sectionId: "commodore:commodore", pageId: "settings", returnFocus: activeContextMenu.returnFocus ?? null });
            setActiveContextMenu(null);
          }}
          onNewSession={() => {
            openCommodoreNewSession(contextMenuTheater.id);
            closeActiveContextMenu();
          }}
          onEditAlias={() => startAliasEdit(contextMenuTheater.id)}
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
  collapsed,
  summary,
  editingAlias,
  clampAlias,
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
  onNewSession,
}: TheaterSectionHeaderProps) {
  const t = useT();
  // 대화 중심 화면의 머리는 사령관 카드다 — 큰 아바타, 둘째 줄 요약. 머리 제어(접기·「+」)는 머무를 때·활성일 때 선다(CSS).
  const suppressClickRef = useRef(false);
  const activateRef = useRef<HTMLButtonElement | null>(null);
  // Console Use — 에이전트가 이 사령관의 목록·그룹을 읽으면 헤더 행 전체가 감싸인다. 지휘관 줄은 「지휘관」 탭에 있으므로 목록 읽기도 머리가 말한다.
  const wrap = useSyncExternalStore(
    subscribeConsoleUseGestures,
    () => getTheaterWrap(theater.id) ?? getAnyClusterListWrap(theater.id),
    () => null,
  );
  // 플러그인 표식(자율 운영의 사령관 글리프)이 있으면 이니셜 칩 자리에 선다. 운영자가 일하는 동안 이름에 라이브 물결이 흐른다.
  const contributionSummary = useMemo(() => ({ id: theater.id, label: theater.label }), [theater.id, theater.label]);
  const mark = useTheaterContributionMark(contributionSummary);
  const live = useTheaterHeaderLive(theater.id);
  const selected = useTheaterHeaderSelected(theater.id);
  // 별칭 편집을 키(Enter·Esc)로 마치면 포커스가 머리로 돌아온다. 다른 곳을 눌러 끝냈으면(blur) 그 자리의 포커스를 빼앗지 않는다.
  const wasEditingRef = useRef(editingAlias);
  const keyFinishRef = useRef(false);
  useEffect(() => {
    if (wasEditingRef.current && !editingAlias && keyFinishRef.current) activateRef.current?.focus({ preventScroll: true });
    if (!editingAlias) keyFinishRef.current = false;
    wasEditingRef.current = editingAlias;
  }, [editingAlias]);
  const displayName = theater.commodore?.alias ?? theater.label;
  const summaryText = summary.commanders === 0
    ? t("sidebar.theater.summary.none")
    : [
        t(summary.commanders === 1 ? "sidebar.theater.summary.commanders_one" : "sidebar.theater.summary.commanders_other", { count: summary.commanders }),
        ...(summary.waiting > 0 ? [t("sidebar.theater.summary.waiting", { count: summary.waiting })] : []),
      ].join(" · ");
  // 둘째 줄 — 별칭이 있으면 원래 Theater 이름이 먼저 선다(어느 폴더인지 늘 보인다). 사령관 카드는 그 뒤에 요약을 잇는다.
  const subline = summaryText;
  const headerClassName = [
    "side-bar-theater-header",
    consoleUseWrapClassName(wrap),
    active ? "is-active" : "",
    selected ? "is-current" : "",
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
      <KeyedAvatar avatarKey={commodoreAvatarKey(theater.commodore?.id ?? theater.id)} role="commodore" state="idle" size={32} label="" decorative />
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
        {onNewSession ? <button type="button" className="side-bar-theater-row-btn" aria-label={t("sidebar.commodore.newSession")} title={t("sidebar.commodore.newSession")} onClick={onNewSession}><PlusIcon /></button> : null}
        {/* 사령관 동작은 머리의 우클릭·키·길게 누르기 메뉴에 있다(handleContextMenu). */}
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
function TheaterAliasInput({ theater, clampAlias, onDone }: { readonly clampAlias: (value: string) => string; readonly theater: TheaterInfo; readonly onDone: (alias: string | null | undefined, viaKey: boolean) => void }) {
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

function TheaterActionsMenu({ theater, anchor, atCursor = false, onForgetTheater, onDeleteCommodore, onOpenZone, onNewSession, onEditAlias, onClose }: TheaterActionsMenuProps) {
  const t = useT();
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
        {/* 대상 Theater — 활성이 아닌 Theater 에서도 열리므로 무엇을 다루는지 먼저 말한다. 메뉴의 aria-label 이 같은 이름을 읽는다. */}
        <div className="theater-menu-title" aria-hidden="true">
          <TheaterAvatar theaterId={theater.id} size={22} label="" decorative />
          <span className="theater-menu-title-text">
            <strong>{theater.commodore?.alias ?? theater.label}</strong>
            {theater.commodore?.alias ? <span>{theater.label}</span> : null}
          </span>
        </div>
        {/* 사령관 별칭 — 머리 자리에서 바로 편집한다(F2·이름 더블클릭도 같다). 원래 이름은 머리 둘째 줄에 남는다. */}
        <button type="button" role="menuitem" className="theater-menu-item theater-menu-alias" onClick={onEditAlias}>
          <span className="theater-menu-check" aria-hidden="true"><PencilIcon /></span>
          <span className="theater-menu-label">{t("sidebar.commodore.appearance")}</span>
        </button>
        <div className="theater-menu-divider" aria-hidden="true" />
        <button type="button" role="menuitem" className="theater-menu-item" onClick={onNewSession}>
          <span className="theater-menu-check" aria-hidden="true"><PlusIcon /></span>
          <span className="theater-menu-label">{t("sidebar.commodore.newSession")}</span>
        </button>
        <button type="button" role="menuitem" className="theater-menu-item" onClick={onOpenZone}>
          <span className="theater-menu-check" aria-hidden="true">✦</span>
          <span className="theater-menu-label">{t("sidebar.commodore.zone")}</span>
        </button>
        <TheaterContributionMenuItems theater={theater} onClose={onClose} />
        {onDeleteCommodore || onForgetTheater ? (
          <>
            <div className="theater-menu-divider" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              className="theater-menu-item theater-menu-forget"
              onClick={onDeleteCommodore ?? onForgetTheater}
            >
              <span className="theater-menu-check" aria-hidden="true"><TrashIcon /></span>
              <span className="theater-menu-label">{t(onDeleteCommodore ? "sidebar.commodore.delete" : "sidebar.theater.forget")}</span>
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
