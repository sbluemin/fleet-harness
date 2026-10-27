import { useSyncExternalStore } from "react";

import type { CoreMessageKey } from "../../../../core/client/src/i18n/index.js";
import type { SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";

export type SortKey = "activity" | "progress" | "remaining" | "due" | "created" | "name" | "manual";
export type SortDirection = "asc" | "desc";

export interface SortPreference {
  readonly key: SortKey;
  readonly direction: SortDirection;
  /** 사람의 답을 기다리는 줄을 정렬과 상관없이 맨 위에 둔다. */
  readonly answerFirst: boolean;
  readonly grouped: boolean;
}

export const SORTS: readonly { readonly key: SortKey; readonly label: CoreMessageKey; readonly direction: SortDirection }[] = [
  { key: "activity", label: "commanderTab.sort.activity", direction: "desc" },
  { key: "progress", label: "commanderTab.sort.progress", direction: "desc" },
  { key: "remaining", label: "commanderTab.sort.remaining", direction: "asc" },
  { key: "due", label: "commanderTab.sort.due", direction: "asc" },
  { key: "created", label: "commanderTab.sort.created", direction: "desc" },
  { key: "name", label: "commanderTab.sort.name", direction: "asc" },
  { key: "manual", label: "commanderTab.sort.manual", direction: "asc" },
];

// 정렬은 브라우저에 하나 — 모든 사령관이 함께 쓴다(사이드바 닫힘과 같은 전역 규칙).
const SORT_KEY = "fleet-console.commanderTab.sort";
const DEFAULT_SORT: SortPreference = { key: "activity", direction: "desc", answerFirst: true, grouped: false };

export function readSort(): SortPreference {
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

export function setSort(next: SortPreference): void {
  sortPreference = next;
  try {
    window.localStorage.setItem(SORT_KEY, JSON.stringify(next));
  } catch {
    // 저장하지 못하면 이번 화면에서만 기억한다.
  }
  for (const listener of sortListeners) listener();
}

export function useSortPreference(): SortPreference {
  return useSyncExternalStore(
    (listener) => { sortListeners.add(listener); return () => { sortListeners.delete(listener); }; },
    () => sortPreference,
    () => sortPreference,
  );
}

function entriesOf(item: SideBarRowItem) {
  return item.anchor ? [item.anchor, ...item.fold] : item.fold;
}

export function activityOf(item: SideBarRowItem): number | undefined {
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

export function sortCommanderRows(items: readonly SideBarRowItem[], preference: SortPreference): SideBarRowItem[] {
  const sign = preference.direction === "asc" ? 1 : -1;
  return [...items].sort((left, right) => {
    if (preference.answerFirst) {
      const waiting = Number(waitsForPerson(right)) - Number(waitsForPerson(left));
      if (waiting !== 0) return waiting;
    }
    // 기본 활동 정렬은 최근 시각이 큰 완료 줄을 시작 전(만든 시각만 있는 줄)보다 앞에 둔다.
    // 정렬 방향 전체를 뒤집지 않고, 완료만 나머지 뒤로 내려 시작 전이 완료보다 앞에 서게 한다.
    if (preference.key === "activity" && preference.direction === "desc") {
      const settled = Number(left.row.glyph === "done") - Number(right.row.glyph === "done");
      if (settled !== 0) return settled;
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

