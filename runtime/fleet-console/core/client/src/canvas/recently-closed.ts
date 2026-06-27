import { useMemo, useSyncExternalStore } from "react";
import type { OperationGeometry, OperationLaunchKind } from "@fleet-console/sdk/operations";

// 닫힌 Operation의 재오픈 스냅샷 — Operations Control의 Recover 섹션이 소비한다. kind는 launch 시점에
// core client가 보유한 불투명 식별자라, core가 plugin payload(cliId 등)를 해석하지 않고도 relaunch할 수 있다.
export interface ClosedOperationSnapshot {
  readonly id: string;
  readonly theaterId: string;
  readonly pluginId: string;
  readonly title: string;
  readonly kind: OperationLaunchKind;
  readonly geometry: OperationGeometry | null;
  readonly closedAt: number;
}

// 새로고침까지 보존하되 민감정보(경로/토큰)는 담지 않는다 — title·opaque kind·geometry만.
const STORAGE_KEY = "fleet-console.recentlyClosed";
const MAX_PER_THEATER = 6;

let snapshot: readonly ClosedOperationSnapshot[] = load();
const listeners = new Set<() => void>();

export function recordClosedOperation(entry: ClosedOperationSnapshot): void {
  const sameTheater = snapshot.filter((item) => item.theaterId === entry.theaterId && item.id !== entry.id).slice(0, MAX_PER_THEATER - 1);
  const otherTheaters = snapshot.filter((item) => item.theaterId !== entry.theaterId);
  snapshot = [entry, ...sameTheater, ...otherTheaters];
  persist();
  emit();
}

export function removeClosedOperation(id: string): void {
  const next = snapshot.filter((item) => item.id !== id);
  if (next.length === snapshot.length) return;
  snapshot = next;
  persist();
  emit();
}

export function useRecentlyClosed(theaterId: string | null): readonly ClosedOperationSnapshot[] {
  const all = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => (theaterId ? all.filter((item) => item.theaterId === theaterId) : []), [all, theaterId]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): readonly ClosedOperationSnapshot[] {
  return snapshot;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // localStorage 불가 환경(프라이빗 모드 등)에서는 세션 메모리로만 동작한다.
  }
}

function load(): readonly ClosedOperationSnapshot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isValidSnapshot) : [];
  } catch {
    return [];
  }
}

function isValidSnapshot(value: unknown): value is ClosedOperationSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const kind = record.kind as Record<string, unknown> | null;
  return typeof record.id === "string"
    && typeof record.theaterId === "string"
    && typeof record.pluginId === "string"
    && typeof record.title === "string"
    && typeof kind === "object" && kind !== null && typeof kind.id === "string" && typeof kind.type === "string";
}
