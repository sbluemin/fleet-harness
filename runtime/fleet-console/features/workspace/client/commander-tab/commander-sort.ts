import { useSyncExternalStore } from "react";

import { createServerSyncedValue } from "./commander-server-sync.js";

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
// 같은 origin의 localStorage는 첫 그리기용 캐시로만 쓰고, 원천은 settings.json(`general.commanderSort`)이다.
const SORT_KEY = "fleet-console.commanderTab.sort";
const DEFAULT_SORT: SortPreference = { key: "activity", direction: "desc", answerFirst: true, grouped: false };

/** 서버·캐시값을 읽는다. 형태가 틀리면 null이다. */
function parseSortPreference(value: unknown): SortPreference | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Partial<SortPreference>;
  const key = candidate.key;
  const direction = candidate.direction;
  const answerFirst = candidate.answerFirst;
  const grouped = candidate.grouped;
  if (key === undefined || !SORTS.some((sort) => sort.key === key)) return null;
  if (direction !== "asc" && direction !== "desc") return null;
  if (typeof answerFirst !== "boolean" || typeof grouped !== "boolean") return null;
  return { key, direction, answerFirst, grouped };
}

function equalSortPreference(left: SortPreference, right: SortPreference): boolean {
  return left.key === right.key && left.direction === right.direction
    && left.answerFirst === right.answerFirst && left.grouped === right.grouped;
}

function readCache(): SortPreference {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(SORT_KEY);
    if (raw === null) return DEFAULT_SORT;
    return parseSortPreference(JSON.parse(raw)) ?? DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT;
  }
}

function writeCache(next: SortPreference): void {
  try {
    window.localStorage.setItem(SORT_KEY, JSON.stringify(next));
  } catch {
    // 저장하지 못하면 이번 화면에서만 기억한다.
  }
}

const syncedSort = createServerSyncedValue({
  field: "commanderSort",
  defaultValue: DEFAULT_SORT,
  readCache,
  writeCache,
  parseServerValue: parseSortPreference,
  equal: equalSortPreference,
  isDefault: (value) => equalSortPreference(value, DEFAULT_SORT),
});

/** 동기 읽기 — 서버 값을 받기 전·실패 시에는 같은 origin 캐시(기본 최근 활동)를 돌려준다. */
export function readSort(): SortPreference {
  return syncedSort.get();
}

export function setSort(next: SortPreference): void {
  syncedSort.set(next);
}

export function useSortPreference(): SortPreference {
  return useSyncExternalStore(syncedSort.subscribe, syncedSort.get, syncedSort.get);
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

