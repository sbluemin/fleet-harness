import { useSyncExternalStore } from "react";

/**
 * 사이드바 그룹 접힘과 Operation 액센트.
 * 영속 키는 예전 캔버스 저장(`fleet-console.canvas.<theaterId>`)을 유지하고,
 * 그 JSON의 다른 필드는 지우지 않는다.
 */
const STORAGE_KEY_PREFIX = "fleet-console.canvas.";

export interface GroupCollapseSlice {
  readonly collapsedGroups: readonly string[];
  readonly operationAccent: Readonly<Record<string, string>>;
}

const EMPTY_SLICE: GroupCollapseSlice = { collapsedGroups: [], operationAccent: {} };

type Listener = () => void;

const listeners = new Set<Listener>();
let activeTheaterId: string | null = null;
let slice: GroupCollapseSlice = EMPTY_SLICE;
let storedTheaterRevision = 0;
let persistHook: ((theaterId: string) => void) | null = null;

/** 활성 Theater 저장을 캔버스 저장과 한 번에 맞춘다. 훅이 없으면 이 스토어가 필드만 병합해 적는다. */
export function registerGroupCollapsePersistHook(hook: ((theaterId: string) => void) | null): void {
  persistHook = hook;
}

export function loadGroupCollapseForTheater(theaterId: string | null): void {
  activeTheaterId = theaterId;
  slice = theaterId ? readSlice(theaterId) : EMPTY_SLICE;
  emit();
}

export function getGroupCollapseTheaterId(): string | null {
  return activeTheaterId;
}

export function getGroupCollapseSlice(): GroupCollapseSlice {
  return slice;
}

export function getTheaterGroupCollapse(theaterId: string): GroupCollapseSlice {
  return theaterId === activeTheaterId ? slice : readSlice(theaterId);
}

export function toggleGroupCollapsed(groupId: string): readonly string[] {
  if (!activeTheaterId) return slice.collapsedGroups;
  const collapsedGroups = toggleId(slice.collapsedGroups, groupId);
  slice = { ...slice, collapsedGroups };
  persistActive();
  emit();
  return collapsedGroups;
}

export function toggleTheaterGroupCollapsed(theaterId: string, groupId: string): void {
  if (theaterId === activeTheaterId) {
    toggleGroupCollapsed(groupId);
    return;
  }
  const stored = readSlice(theaterId);
  writeSlice(theaterId, { ...stored, collapsedGroups: toggleId(stored.collapsedGroups, groupId) });
  storedTheaterRevision += 1;
  emit();
}

export function setOperationAccent(operationId: string, accentKey: string | null): GroupCollapseSlice {
  const operationAccent = { ...slice.operationAccent };
  if (accentKey === null) delete operationAccent[operationId];
  else operationAccent[operationId] = accentKey;
  slice = { ...slice, operationAccent };
  persistActive();
  emit();
  return slice;
}

/** 사라진 Operation의 액센트만 걷는다. 바뀌지 않으면 같은 참조를 돌려 구독자가 깨어나지 않게 한다. */
export function pruneOperationAccents(validIds: ReadonlySet<string>): GroupCollapseSlice {
  const pruned = Object.fromEntries(Object.entries(slice.operationAccent).filter(([id]) => validIds.has(id)));
  if (Object.keys(pruned).length === Object.keys(slice.operationAccent).length) return slice;
  slice = { ...slice, operationAccent: pruned };
  persistActive();
  emit();
  return slice;
}

export function useCollapsedGroups(): readonly string[] {
  return useSyncExternalStore(subscribe, getCollapsedGroupsSnapshot, getCollapsedGroupsSnapshot);
}

export function useOperationAccent(): Readonly<Record<string, string>> {
  return useSyncExternalStore(subscribe, getOperationAccentSnapshot, getOperationAccentSnapshot);
}

export function useStoredTheaterRevision(): number {
  return useSyncExternalStore(subscribe, getStoredTheaterRevision, getStoredTheaterRevision);
}

/** 비활성 Theater의 캔버스 저장이 바뀌었을 때 사이드바가 그 스냅샷을 다시 읽게 한다. */
export function bumpStoredTheaterRevision(): void {
  storedTheaterRevision += 1;
  emit();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getCollapsedGroupsSnapshot(): readonly string[] {
  return slice.collapsedGroups;
}

function getOperationAccentSnapshot(): Readonly<Record<string, string>> {
  return slice.operationAccent;
}

function getStoredTheaterRevision(): number {
  return storedTheaterRevision;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function persistActive(): void {
  if (!activeTheaterId) return;
  if (persistHook) {
    persistHook(activeTheaterId);
    return;
  }
  writeSlice(activeTheaterId, slice);
}

function toggleId(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id];
}

function storageKey(theaterId: string): string {
  return `${STORAGE_KEY_PREFIX}${theaterId}`;
}

function readSlice(theaterId: string): GroupCollapseSlice {
  const parsed = readRaw(theaterId);
  if (!parsed) return EMPTY_SLICE;
  return {
    collapsedGroups: normalizeStringArray(parsed.collapsedGroups),
    operationAccent: normalizeOperationAccent(parsed.operationAccent),
  };
}

function readRaw(theaterId: string): Record<string, unknown> | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(storageKey(theaterId));
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeSlice(theaterId: string, next: GroupCollapseSlice): void {
  if (typeof window === "undefined") return;
  try {
    const existing = readRaw(theaterId) ?? {};
    window.localStorage.setItem(storageKey(theaterId), JSON.stringify({
      ...existing,
      collapsedGroups: next.collapsedGroups,
      operationAccent: next.operationAccent,
    }));
  } catch {
    // 저장 실패는 접힘 복구성만 낮추므로 런타임 흐름을 막지 않는다.
  }
}

function normalizeStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function normalizeOperationAccent(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const operationAccent: Record<string, string> = {};
  for (const [id, accentKey] of Object.entries(value)) {
    if (typeof accentKey !== "string") continue;
    operationAccent[id] = accentKey;
  }
  return operationAccent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
