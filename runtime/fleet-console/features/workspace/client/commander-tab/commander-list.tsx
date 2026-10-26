import { Fragment, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";

import { useT } from "../../../../core/client/src/i18n/index.js";
import type { CoreMessageKey } from "../../../../core/client/src/i18n/index.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { closeNewSession, objectiveRecordOrderFromNodes } from "../../../../core/client/src/integration/store.js";
import { useClusterIndex } from "../objective-clusters.js";
import { buildTheaterEntries, SideBarClusterRow, sideBarRowItems, type SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";
import { openCommanderSplit, useCommanderSplit } from "../conversation/commander-split-store.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../../../execution/client/objective-marks.js";
import { openCommodoreNewSession } from "../conversation/new-session-entry.js";
import { CommodoreRecentActions } from "../../../commodore/client/commodore-trail.js";
import { revealCommodoreTurn } from "../../../commodore/client/commodore-conversation.js";
import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import "./commander-list.css";

/*
 * 사령관 오른쪽 「지휘관」 탭 — 시작 전·진행 중·완료 목표를 같은 두 줄 문법으로 보인다. 정렬과 그룹 묶기 선호는 전역이다.
 * 목표를 고르면 옆 칸에 시작 화면 또는 그룹 대화가 서고, 선택한 행 아래에 최근 사령관 행위가 펼쳐진다.
 */

type SortKey = "activity" | "progress" | "remaining" | "due" | "created" | "name" | "manual";
type SortDirection = "asc" | "desc";

interface SortPreference {
  readonly key: SortKey;
  readonly direction: SortDirection;
  /** 사람의 답을 기다리는 줄을 정렬과 상관없이 맨 위에 둔다. */
  readonly answerFirst: boolean;
  readonly grouped: boolean;
}

const SORTS: readonly { readonly key: SortKey; readonly label: CoreMessageKey; readonly direction: SortDirection }[] = [
  { key: "activity", label: "commanderTab.sort.activity", direction: "desc" },
  { key: "progress", label: "commanderTab.sort.progress", direction: "desc" },
  { key: "remaining", label: "commanderTab.sort.remaining", direction: "asc" },
  { key: "due", label: "commanderTab.sort.due", direction: "asc" },
  { key: "created", label: "commanderTab.sort.created", direction: "desc" },
  { key: "name", label: "commanderTab.sort.name", direction: "asc" },
  { key: "manual", label: "commanderTab.sort.manual", direction: "asc" },
];

// 정렬은 브라우저에 하나 — 모든 사령관이 함께 쓴다(사이드바 닫힘·분할 기억과 같은 전역 규칙).
const SORT_KEY = "fleet-console.commanderTab.sort";
const DEFAULT_SORT: SortPreference = { key: "activity", direction: "desc", answerFirst: true, grouped: false };

function readSort(): SortPreference {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(SORT_KEY);
    if (raw === null) return DEFAULT_SORT;
    const parsed = JSON.parse(raw) as Partial<SortPreference>;
    const key = SORTS.some((sort) => sort.key === parsed.key) ? parsed.key! : DEFAULT_SORT.key;
    const direction = parsed.direction === "asc" || parsed.direction === "desc" ? parsed.direction : DEFAULT_SORT.direction;
    return { key, direction, answerFirst: parsed.answerFirst !== false, grouped: parsed.grouped === true };
  } catch {
    return DEFAULT_SORT;
  }
}

let sortPreference = readSort();
const sortListeners = new Set<() => void>();

function setSort(next: SortPreference): void {
  sortPreference = next;
  try {
    window.localStorage.setItem(SORT_KEY, JSON.stringify(next));
  } catch {
    // 저장하지 못하면 이번 화면에서만 기억한다.
  }
  for (const listener of sortListeners) listener();
}

function useSortPreference(): SortPreference {
  return useSyncExternalStore(
    (listener) => { sortListeners.add(listener); return () => { sortListeners.delete(listener); }; },
    () => sortPreference,
    () => sortPreference,
  );
}

function entriesOf(item: SideBarRowItem) {
  return item.anchor ? [item.anchor, ...item.fold] : item.fold;
}

function activityOf(item: SideBarRowItem): number | undefined {
  const times = entriesOf(item).map((entry) => entry.objectiveRecord.ts.updatedAt);
  if (item.row.activityAt !== undefined) times.push(item.row.activityAt);
  return times.length ? Math.max(...times) : undefined;
}

function createdOf(item: SideBarRowItem): number | undefined {
  return item.row.createdAt ?? item.anchor?.objectiveRecord.ts.createdAt;
}

function waitsForPerson(item: SideBarRowItem): boolean {
  return item.row.decisionRequestedAt !== undefined || entriesOf(item).some((entry) => (entry.mark ?? entry.status) === "awaiting");
}

/** 정렬 값 — 값이 없는 줄(기한 없음·미션 없음)은 방향과 상관없이 값이 있는 줄 뒤에 선다. */
function sortValue(item: SideBarRowItem, key: SortKey): number | string | undefined {
  switch (key) {
    case "activity": return activityOf(item);
    case "progress": return item.row.progress && item.row.progress.total > 0 ? item.row.progress.done / item.row.progress.total : undefined;
    case "remaining": return item.row.progress && item.row.progress.total > 0 ? item.row.progress.total - item.row.progress.done : undefined;
    case "due": return item.row.due?.date;
    case "created": return createdOf(item);
    case "name": return item.layout.cluster.title;
    case "manual": return item.row.order;
  }
}

function compare(left: number | string, right: number | string): number {
  if (typeof left === "string" || typeof right === "string") return String(left).localeCompare(String(right));
  return left - right;
}

function sortCommanderRows(items: readonly SideBarRowItem[], preference: SortPreference): SideBarRowItem[] {
  const sign = preference.direction === "asc" ? 1 : -1;
  return [...items].sort((left, right) => {
    if (preference.answerFirst) {
      const waiting = Number(waitsForPerson(right)) - Number(waitsForPerson(left));
      if (waiting !== 0) return waiting;
    }
    const a = sortValue(left, preference.key);
    const b = sortValue(right, preference.key);
    if (a !== undefined && b !== undefined) {
      const order = compare(a, b);
      if (order !== 0) return sign * order;
    } else if (a !== undefined || b !== undefined) {
      return a === undefined ? 1 : -1;
    }
    // 같으면 최근에 움직인 줄이 먼저다.
    return (activityOf(right) ?? 0) - (activityOf(left) ?? 0);
  });
}

export function CommodoreCommanderList({ commodoreId }: { readonly commodoreId: string }) {
  const t = useT();
  const state = useConsoleState();
  const clusterIndex = useClusterIndex();
  const split = useCommanderSplit();
  const preference = useSortPreference();
  // 도착 표식은 줄의 마크다 — 옆 칸에서 읽어 확인 처리되면(활성 Objective 은 그대로) 그 자리에서 줄이 다시 그려져야 한다.
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  const language = useConsoleLocale();
  const shownId = split.open && state.newSession?.placement !== "commander-split" ? split.picked[commodoreId] ?? null : null;
  const items = useMemo(() => {
    const records = state.objectiveRecords.filter((objectiveRecord) => objectiveRecord.commodoreId === commodoreId);
    const entries = buildTheaterEntries({
      theaterId: commodoreId,
      objectiveRecords: records,
      objectiveRecordOrder: objectiveRecordOrderFromNodes(records),
      // 옆 칸에 선 지휘관이 이 목록의 선택이다 — 가운데 칸의 주인은 사령관이라 활성 Objective 로 고르지 않는다.
      activeObjectiveId: shownId,
      objectiveRecordNotifications: state.objectiveRecordNotifications,
      objectiveRecordRuntime: state.objectiveRecordRuntime,
    });
    return sideBarRowItems(entries, clusterIndex, new Set(records.map((objectiveRecord) => objectiveRecord.id)), commodoreId);
  }, [clusterIndex, commodoreId, idleArrivalIds, shownId, state.objectiveRecordNotifications, state.objectiveRecordRuntime, state.objectiveRecords]);
  const sorted = useMemo(() => sortCommanderRows(items, preference), [items, preference]);
  const groups = [...state.groups].filter((group) => group.commodoreId === commodoreId).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  const groupIdOf = (item: SideBarRowItem) => item.anchor ? item.anchor.objectiveRecord.groupId ?? null : item.row.groupId;
  const groupIds = new Set(groups.map((group) => group.id));
  const sections = preference.grouped
    ? [...groups.map((group) => ({ id: group.id, title: group.name, rows: sorted.filter((item) => groupIdOf(item) === group.id) })),
      { id: "ungrouped", title: t("commanderTab.ungrouped"), rows: sorted.filter((item) => !groupIds.has(groupIdOf(item) ?? "")) }].filter((group) => group.rows.length > 0)
    : [{ id: "all", title: null, rows: sorted }];

  return (
    <section className="commander-tab" aria-label={t("commanderTab.aria")}>
      <div className="commander-tab-bar">
        <span className="commander-tab-count">{t("commanderTab.count", { count: sorted.length })}</span>
        <SortMenu preference={preference} />
        <button
          type="button"
          className="commander-tab-direction"
          aria-label={t(preference.direction === "asc" ? "commanderTab.sort.ascending" : "commanderTab.sort.descending")}
          title={t(preference.direction === "asc" ? "commanderTab.sort.ascending" : "commanderTab.sort.descending")}
          onClick={() => setSort({ ...preference, direction: preference.direction === "asc" ? "desc" : "asc" })}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {preference.direction === "asc"
              ? <path d="M8 13V3M8 3 4.5 6.5M8 3l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              : <path d="M8 3v10M8 13l-3.5-3.5M8 13l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />}
          </svg>
        </button>
        <button type="button" className="commander-tab-direction" aria-label={t("sidebar.commodore.newSession")} title={t("sidebar.commodore.newSession")} onClick={() => openCommodoreNewSession(commodoreId)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </div>
      {sorted.length === 0 ? <p className="commander-tab-empty">{t("commanderTab.empty")}</p> : (
        <div className="commander-tab-groups">
          {sections.map((group) => <section key={group.id}>
            {group.title !== null ? <h3 className="commander-tab-group-title">{group.title}<span>{group.rows.length}</span></h3> : null}
            <ol className="commander-tab-list side-bar-group-chips">
              {group.rows.map((item) => <Fragment key={item.layout.cluster.id}><SideBarClusterRow item={item}
                selected={shownId === item.layout.cluster.id}
                onFocus={(objectiveId) => { closeNewSession(); openCommanderSplit(commodoreId, objectiveId); }} />
                {!item.row.commodore && shownId === item.layout.cluster.id ? <li className="commander-tab-trail"><CommodoreRecentActions commodoreId={commodoreId} objectiveId={item.layout.cluster.id} language={language} onReveal={(at) => revealCommodoreTurn(commodoreId, at)} /></li> : null}
              </Fragment>)}
            </ol>
          </section>)}
        </div>
      )}
    </section>
  );
}

function SortMenu({ preference }: { readonly preference: SortPreference }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const current = SORTS.find((sort) => sort.key === preference.key) ?? SORTS[0]!;
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && (menuRef.current?.contains(event.target) || buttonRef.current?.contains(event.target))) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);
  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return (
    <span className="commander-tab-sort">
      <button
        ref={buttonRef}
        type="button"
        className="commander-tab-sort-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {t("commanderTab.sort.button", { label: t(current.label) })}
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} className="commander-tab-menu" role="menu" aria-label={t("commanderTab.sort.menu")} onKeyDown={onMenuKeyDown}>
          {SORTS.map((sort) => (
            <button
              key={sort.key}
              type="button"
              role="menuitemradio"
              aria-checked={sort.key === preference.key}
              className="commander-tab-menu-item"
              onClick={() => { setSort({ ...preference, key: sort.key, direction: sort.direction }); close(); }}
            >
              <span className="commander-tab-menu-check" aria-hidden="true">{sort.key === preference.key ? "✓" : ""}</span>
              {t(sort.label)}
            </button>
          ))}
          <span className="commander-tab-menu-rule" role="separator" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={preference.answerFirst}
            className="commander-tab-menu-item"
            onClick={() => setSort({ ...preference, answerFirst: !preference.answerFirst })}
          >
            <span className="commander-tab-menu-check" aria-hidden="true">{preference.answerFirst ? "✓" : ""}</span>
            {t("commanderTab.sort.answerFirst")}
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={preference.grouped} className="commander-tab-menu-item" onClick={() => setSort({ ...preference, grouped: !preference.grouped })}>
            <span className="commander-tab-menu-check" aria-hidden="true">{preference.grouped ? "✓" : ""}</span>{t("commanderTab.sort.grouped")}
          </button>
        </div>
      ) : null}
    </span>
  );
}
