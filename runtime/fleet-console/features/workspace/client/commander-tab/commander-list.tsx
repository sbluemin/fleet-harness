import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useViewportFit, ChevronGlyph, MenuCheckGlyph } from "@fleet-console/ui/react";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { useViewMode } from "../../../../core/client/src/integration/view-mode-store.js";
import { openCommanderConversation } from "./commander-navigation.js";
import { openCommanderRowMenu } from "../sidebar/commander-row-menu-store.js";
import type { RowPopups, SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";
import { SettledDoneGlyph, SettledFreshGlyph } from "../sidebar/side-bar-cluster-row.js";
import { commanderObjectiveId } from "../objective-clusters.js";
import { SideBarClusterRow } from "../sidebar/side-bar-cluster-row.js";
import { CommodoreAvatar } from "../../../commodore/client/commodore-avatar.js";
import { openCommodoreTasksPanel } from "../../../commodore/client/commodore-conversation.js";
import { commodoreSectionLabel, useCommodoreList } from "../../../commodore/client/commodore-list.js";
import { useCommodore } from "../../../commodore/client/commodore-state.js";
import { commodoreMongleState } from "../../../commodore/client/commodore-header.js";
import { useObjectiveTheater } from "../../../commodore/client/board.js";
import { isNotStartedRow } from "../conversation/new-session-mention.js";
import { openCommodoreNewSession } from "../conversation/new-session-entry.js";
import { SORTS, setSort, type SortDirection, type SortPreference } from "./commander-sort.js";
import { toggleFold, useCommanderFolds, type CommanderFold } from "./commander-folds.js";
import { useCommanderRows } from "./commander-rows.js";
import { dismissCommanderPlacementNotice, moveCommanderPlacement, setCommanderPlacement, useCommanderPlacement, useCommanderPlacementNotice, type CommanderPlacement } from "./commander-placement.js";
import { Toast, ToastHost } from "../../../../core/client/src/chrome/components/toast.js";
import { ensureCommanderExpanded } from "../sidebar/commander-expansion.js";
import "./commander-list.css";

/** 고스트 목록과 폰 시트가 같은 두 줄 행·정렬을 쓴다. 작업 탭 목표 섹션도 이 목록을 빌려 쓴다(조립이 렌더러를 넘긴다). */
/** 접힌 settled 머리의 접근 이름 — 0인 상태는 빼고 시작 전·완료를 나눠 읽는다. */
function settledToggleLabel(t: ReturnType<typeof useT>, collapsed: boolean, fresh: number, done: number): string {
  const parts: string[] = [];
  if (fresh > 0) parts.push(t("commanderTab.settledFresh", { n: fresh }));
  if (done > 0) parts.push(t("commanderTab.settledDone", { n: done }));
  return t(collapsed ? "commanderTab.settledExpand" : "commanderTab.settledCollapse", { parts: parts.join(" · ") });
}

/**
 * 접힌 settled 머리의 분리 개수 — 행 글리프와 같은 표시(SettledFreshGlyph·SettledDoneGlyph) + 숫자라 좁은 사이드바에 들어간다.
 * 시작 전 먼저, 완료 다음. 0인 상태는 자리를 차지하지 않는다. 버튼의 접근 이름이 뜻을 말하므로 장식이다.
 */
function SettledCounts({ fresh, done }: { readonly fresh: number; readonly done: number }) {
  return (
    <span className="commander-tab-settled-count" aria-hidden="true">
      {fresh > 0 ? (
        <span className="commander-tab-settled-part">
          <SettledFreshGlyph />
          {fresh}
        </span>
      ) : null}
      {done > 0 ? (
        <span className="commander-tab-settled-part">
          <SettledDoneGlyph />
          {done}
        </span>
      ) : null}
    </span>
  );
}

export function CommodoreCommanderList({ commodoreId, selectedId = null, onSelect, onNewSession, onRowMenu, sortNameOnly = false, card = false, showBar = true, heading, popups }: {
  readonly commodoreId: string;
  readonly selectedId?: string | null;
  readonly onSelect?: (item: SideBarRowItem) => void;
  readonly onNewSession?: () => void;
  readonly onRowMenu?: (item: SideBarRowItem) => void;
  /** 사이드바·좁은 팝오버처럼 좁을 때만 정렬 칩에 현재 이름만 보인다. 폰은 접두어를 유지한다. */
  readonly sortNameOnly?: boolean;
  /** 루틴 목록과 같은 테두리 카드 안에 행이 선다(작업 탭 목표 섹션). */
  readonly card?: boolean;
  /** 정렬·새 목표·위치 막대를 그린다. 사이드바는 사령관 머리의 호버 독이 같은 일을 하므로 끈다. */
  readonly showBar?: boolean;
  /** 목록 막대 앞에 서는 섹션 머리 — 개수와 함께 부른다. */
  readonly heading?: ReactNode;
  /** 우측 작업 탭 카드의 행 팝업(아바타·임무 게이지) — 목표 행에만 건넨다. 없으면 지금 행 그대로다. */
  readonly popups?: ((item: SideBarRowItem, objectiveId: string) => RowPopups) | undefined;
}) {
  const t = useT();
  const desktop = useViewMode().effective !== "mobile";
  const { sorted, listSections, preference } = useCommanderRows(commodoreId, selectedId);
  const folds = useCommanderFolds();
  const groupsId = useId();
  const renderItems = (rows: readonly SideBarRowItem[], settled: boolean) => rows.map((item) => {
    const objectiveId = commanderObjectiveId(item.layout.cluster);
    const selected = objectiveId !== null && selectedId === objectiveId;
    return <SideBarClusterRow key={item.layout.cluster.id} item={item} selected={selected} settled={settled}
      popups={popups !== undefined && objectiveId !== null ? popups(item, objectiveId) : undefined}
      onFocus={(id) => { if (onSelect) onSelect(item); else openCommanderConversation(commodoreId, id); }}
      onContextMenu={onRowMenu ?? (desktop ? (row, anchor, returnFocus, focusFirst) => openCommanderRowMenu({ item: row, anchor, returnFocus, focusFirst }) : undefined)} />;
  });
  // 우측 작업 탭 카드만 시작 전·완료를 카드 밖 구역으로 나눈다. 줄 순서는 통합 목록(기한·최근 완료)을 유지하고, 접힘은 fresh/done 키다.
  const settledRows = listSections.find((group) => group.settled === true)?.rows;
  const outsideFolds: readonly { id: Extract<CommanderFold, "fresh" | "done">; label: "sidebar.row.glyph.fresh" | "sidebar.row.glyph.done"; count: "commanderTab.settledFresh" | "commanderTab.settledDone"; rows: readonly SideBarRowItem[] }[] = [
    { id: "fresh", label: "sidebar.row.glyph.fresh", count: "commanderTab.settledFresh", rows: settledRows?.filter((item) => isNotStartedRow(item.row)) ?? [] },
    { id: "done", label: "sidebar.row.glyph.done", count: "commanderTab.settledDone", rows: settledRows?.filter((item) => item.row.glyph === "done") ?? [] },
  ];

  return (
    <section className={["commander-tab", card ? "commander-tab--card" : ""].filter(Boolean).join(" ")} aria-label={t("commanderTab.aria")}>
      {showBar ? <div className="commander-tab-bar">
        {heading ? <span className="commander-tab-heading">{heading}</span> : null}
        <SortMenu preference={preference} nameOnly={sortNameOnly} />
        <button type="button" className="commander-tab-direction" aria-label={t("sidebar.commodore.newSession")} title={t("sidebar.commodore.newSession")} onClick={onNewSession ?? (() => openCommodoreNewSession(commodoreId))}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        <CommanderPlacementGlyphs commodoreId={commodoreId} />
      </div> : null}
      {sorted.length === 0 ? null : card ? (
        <>
          {listSections.some((group) => group.settled !== true) ? (
            <div className="commander-tab-groups">
              {listSections.filter((group) => group.settled !== true).map((group) => {
                return <section key={group.id}>
                  {group.title !== null ? <h3 className="commander-tab-group-title">{group.title}<span>{group.rows.length}</span></h3> : null}
                  <ol className="commander-tab-list side-bar-group-chips">{renderItems(group.rows, false)}</ol>
                </section>;
              })}
            </div>
          ) : null}
          {outsideFolds.map((fold) => {
            if (fold.rows.length === 0) return null;
            const collapsed = folds[fold.id];
            const listId = `${groupsId}-${fold.id}`;
            return <section key={fold.id} className="commander-tab-outside">
              <button type="button" className="commander-tab-outside-head" aria-expanded={!collapsed} aria-controls={listId}
                aria-label={t(collapsed ? "commanderTab.settledExpand" : "commanderTab.settledCollapse", { parts: t(fold.count, { n: fold.rows.length }) })}
                onClick={() => toggleFold(fold.id)}>
                <span>{t(fold.label)}</span>
                <span className="commander-tab-outside-count">{fold.rows.length}</span>
                <span className="commander-tab-outside-rule" aria-hidden="true" />
                <ChevronGlyph direction="right" className="commander-tab-outside-chev" />
              </button>
              <ol id={listId} className="commander-tab-list side-bar-group-chips" hidden={collapsed}>{renderItems(fold.rows, true)}</ol>
            </section>;
          })}
        </>
      ) : (
        <div className="commander-tab-groups">
          {listSections.map((group) => {
            // 시작 전·완료 통합 목록은 구분 머리(접기 단추) 아래에 선다. 진행 중 행이 없어도 머리는 선다.
            const foldId = group.settled === true ? group.fold : null;
            const collapsed = foldId !== null && folds[foldId];
            const listId = `${groupsId}-${group.id}`;
            return <section key={group.id}>
            {group.settled === true
              ? <button type="button" className="commander-tab-settled-head" aria-expanded={!collapsed} aria-controls={listId}
                  aria-label={settledToggleLabel(t, collapsed, group.freshCount ?? 0, group.doneCount ?? 0)}
                  onClick={() => { if (foldId !== null) toggleFold(foldId); }}>
                  <span className="commander-tab-settled-rule" aria-hidden="true" />
                  {collapsed ? <SettledCounts fresh={group.freshCount ?? 0} done={group.doneCount ?? 0} /> : null}
                  <ChevronGlyph direction={collapsed ? "right" : "down"} />
                </button>
              : group.title !== null ? <h3 className="commander-tab-group-title">{group.title}<span>{group.rows.length}</span></h3> : null}
            <ol id={group.settled === true ? listId : undefined} className="commander-tab-list side-bar-group-chips" hidden={collapsed}>
              {renderItems(group.rows, group.settled === true)}
            </ol>
          </section>;
          })}
        </div>
      )}
    </section>
  );
}

export function useCommanderOwner(commodoreId: string) {
  const t = useT();
  const owner = useCommodoreList().find((item) => item.commodoreId === commodoreId);
  const { view } = useCommodore(commodoreId);
  const board = useObjectiveTheater(commodoreId);
  return {
    name: owner ? commodoreSectionLabel(owner, t("sidebar.commodore.fallback")) : t("sidebar.commodore.fallback"),
    state: commodoreMongleState(view, board.objectives),
  };
}

export function CommanderListOwner({ commodoreId, selected, onSelect }: { readonly commodoreId: string; readonly selected: boolean; readonly onSelect: () => void }) {
  const owner = useCommanderOwner(commodoreId);
  const t = useT();
  return <button type="button" className="commander-list-owner" aria-current={selected ? "true" : undefined} onClick={onSelect}>
    <CommodoreAvatar commodoreId={commodoreId} state={owner.state} size={30} label="" decorative />
    <span><strong>{owner.name}</strong><small>{t("sidebar.commodore.fallback")}</small></span>
  </button>;
}

/** 목록 위치. 글자 없이 글리프만 두고, 왼쪽·오른쪽 사이드바는 한 묶음이다. 폰에는 위치 선택을 두지 않는다. */
function CommanderPlacementGlyphs({ commodoreId }: { readonly commodoreId: string }) {
  const t = useT();
  const desktop = useViewMode().effective !== "mobile";
  const placement = useCommanderPlacement();
  if (!desktop) return null;
  // 알림·되돌리기·옮겨 간 쪽 보이기는 언마운트되지 않는 호스트가 맡는다.
  const choose = (next: CommanderPlacement) => moveCommanderPlacement(commodoreId, next);
  return (
    <span className="commander-place" role="group" aria-label={t("commanderRail.place")}>
      <button type="button" className="commander-place-button" aria-pressed={placement === "left"} aria-label={t("commanderRail.placeSidebar")} title={t("commanderRail.placeSidebar")} onClick={() => choose("left")}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 2.4h3.1v11.2H2.2z" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M7.6 4.6h6M7.6 8h6M7.6 11.4h4.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
      <button type="button" className="commander-place-button" aria-pressed={placement === "right"} aria-label={t("commanderRail.placeRight")} title={t("commanderRail.placeRight")} onClick={() => choose("right")}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.7 2.4h3.1v11.2h-3.1z" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M2.4 4.6h6M2.4 8h6M2.4 11.4h4.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
    </span>
  );
}

/**
 * 옮기기 알림 한 곳 — 목록이 반대쪽으로 넘어가며 언마운트돼도 살아남는다. 사이드바 뿌리처럼 옮겨도
 * 바뀌지 않는 자리에 둔다. 옮겨 간 쪽을 보이게 하고, 되돌리기는 그 반대로 보인다.
 */
export function CommanderPlacementNoticeHost() {
  const t = useT();
  const notice = useCommanderPlacementNotice();
  useEffect(() => {
    if (notice === null) return;
    if (notice.next === "left") ensureCommanderExpanded(notice.commodoreId);
    else openCommodoreTasksPanel(notice.commodoreId);
  }, [notice]);
  if (notice === null) return null;
  const undo = () => {
    setCommanderPlacement(notice.prev);
    if (notice.prev === "left") ensureCommanderExpanded(notice.commodoreId);
    else openCommodoreTasksPanel(notice.commodoreId);
    dismissCommanderPlacementNotice();
  };
  // 화면 최상위 층에 포털로 그린다 — 사이드바 스택 문맥 안에 두면 오른쪽 패널에 가려진다.
  return createPortal(
    <ToastHost>
      <Toast open tone="info" title={t(notice.next === "left" ? "commanderRail.movedToLeft" : "commanderRail.movedToRight")} actionLabel={t("chrome.toast.undo")} onAction={undo} onDismiss={dismissCommanderPlacementNotice} />
    </ToastHost>,
    document.body,
  );
}

/**
 * 정렬 메뉴 — `glyph`는 글자 칩 대신 아이콘 단추로 서고(사령관 머리의 호버 독), 열림·닫힘을 `onOpenChange`로 알린다.
 * `glyph` 메뉴는 호버로 열리고 접히는 독·스크롤하는 사이드바 목록 밖, 문서 최상위에 독의 오른쪽 아래를 닻으로 고정해 그린다 —
 * 독의 :hover·:focus-within·넘침·전환이 항목을 누르는 중에 판을 움직이지 못하게 한다.
 */
export function SortMenu({ preference, nameOnly = false, glyph = false, onOpenChange }: { readonly preference: SortPreference; readonly nameOnly?: boolean; readonly glyph?: boolean; readonly onOpenChange?: (open: boolean) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useViewportFit(menuRef, open);
  const current = SORTS.find((sort) => sort.key === preference.key) ?? SORTS[0]!;
  const sortLabel = t("commanderTab.sort.button", { label: t(current.label) });
  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  const [anchor, setAnchor] = useState<CSSProperties | null>(null);
  const toggle = () => {
    if (glyph && !open) {
      const box = (buttonRef.current?.closest(".commodore-dock") ?? buttonRef.current)?.getBoundingClientRect();
      if (box) setAnchor({ position: "fixed", top: box.bottom + 4, right: window.innerWidth - box.right, left: "auto", zIndex: 40 });
    }
    setOpen((value) => !value);
  };
  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);
  // 문서에 고정된 판은 닻이 움직이면(창 크기·목록 스크롤) 따라가지 않고 닫는다.
  useEffect(() => {
    if (!open || !glyph) return;
    const dismiss = () => setOpen(false);
    const onScroll = (event: Event) => { if (event.target instanceof Node && event.target.contains(buttonRef.current)) setOpen(false); };
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("resize", dismiss); document.removeEventListener("scroll", onScroll, true); };
  }, [open, glyph]);
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"], [aria-pressed="true"]')?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && (menuRef.current?.contains(event.target) || buttonRef.current?.contains(event.target))) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-sort-row]");
    const column = (document.activeElement as HTMLElement | null)?.dataset.sortColumn ?? "name";
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      if (!row) return;
      event.preventDefault();
      const order = ["name", "asc", "desc"];
      const next = order[order.indexOf(column) + (event.key === "ArrowRight" ? 1 : -1)];
      if (next) row.querySelector<HTMLElement>(`[data-sort-column="${next}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    if (row) {
      const rows = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[data-sort-row]") ?? []);
      const next = rows[rows.indexOf(row) + step];
      if (next) { (next.querySelector<HTMLElement>(`[data-sort-column="${column}"]`) ?? next.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus({ preventScroll: true }); return; }
    }
    const fallback = items[index + step] ?? items[step > 0 ? 0 : items.length - 1];
    fallback?.focus({ preventScroll: true });
  };
  const pick = (key: SortPreference["key"], direction: SortDirection) => { setSort({ ...preference, key, direction }); close(); };
  const place = (node: ReactNode) => (glyph ? createPortal(node, document.body) : node);
  return (
    <span className="commander-tab-sort">
      <button ref={buttonRef} type="button" className={glyph ? "commodore-dock-button" : "commander-tab-sort-button"} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} aria-label={sortLabel} title={sortLabel} onClick={toggle}>
        {glyph
          ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3v10M3 11l2 2 2-2M11 13V3M9 5l2-2 2 2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          : <span className="commander-tab-sort-label">{nameOnly ? t(current.label) : sortLabel}</span>}
      </button>
      {open ? place(<div ref={menuRef} id={menuId} className="commander-tab-menu" role="menu" aria-label={t("commanderTab.sort.menu")} data-keep-objective-active={glyph ? "" : undefined} style={glyph ? anchor ?? undefined : undefined} onKeyDown={onMenuKeyDown}
        // 항목을 누르는 순간 초점이 옮겨 가며 판·독이 다시 그려지지 않게 한다 — 초점은 단추에 남고 클릭만 항목으로 간다.
        onMouseDown={glyph ? (event) => event.preventDefault() : undefined}>
        {SORTS.map((sort) => {
          const label = t(sort.label);
          const selected = sort.key === preference.key;
          return <div key={sort.key} className="commander-tab-menu-row" data-sort-row="">
            <button type="button" role="menuitemradio" data-sort-column="name" aria-checked={selected} className="commander-tab-menu-item" onClick={() => pick(sort.key, sort.direction)}>
              <span className="commander-tab-menu-check" aria-hidden="true">{selected ? <MenuCheckGlyph size={14} /> : null}</span>{label}
            </button>
            {(["asc", "desc"] as const).map((direction) => (
              <button key={direction} type="button" role="menuitemradio" data-sort-column={direction} className="commander-tab-menu-direction" aria-checked={selected && preference.direction === direction} aria-label={t("commanderTab.sort.toward", { label, direction: t(direction === "asc" ? "commanderTab.sort.asc" : "commanderTab.sort.desc") })} title={t(direction === "asc" ? "commanderTab.sort.asc" : "commanderTab.sort.desc")} onClick={() => pick(sort.key, direction)}>
                <svg viewBox="0 0 16 16" aria-hidden="true">{direction === "asc"
                  ? <path d="M8 13V3M8 3 4.5 6.5M8 3l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  : <path d="M8 3v10M8 13l-3.5-3.5M8 13l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />}</svg>
              </button>
            ))}
          </div>;
        })}
        <span className="commander-tab-menu-rule" role="separator" />
        <button type="button" role="menuitemcheckbox" aria-checked={preference.answerFirst} className="commander-tab-menu-item" onClick={() => setSort({ ...preference, answerFirst: !preference.answerFirst })}>
          <span className="commander-tab-menu-check" aria-hidden="true">{preference.answerFirst ? <MenuCheckGlyph size={14} /> : null}</span>{t("commanderTab.sort.answerFirst")}
        </button>
        <button type="button" role="menuitemcheckbox" aria-checked={preference.grouped} className="commander-tab-menu-item" onClick={() => setSort({ ...preference, grouped: !preference.grouped })}>
          <span className="commander-tab-menu-check" aria-hidden="true">{preference.grouped ? <MenuCheckGlyph size={14} /> : null}</span>{t("commanderTab.sort.grouped")}
        </button>
      </div>) : null}
    </span>
  );
}
