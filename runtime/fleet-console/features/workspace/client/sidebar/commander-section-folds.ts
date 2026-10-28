import { useSyncExternalStore } from "react";

/**
 * 사령관 섹션별 지휘관 목록 접힘 — 사람이 직접 접거나 펼친 것만 사령관마다 기억한다.
 * 활성 사령관이 바뀌거나 새로고침해도 유지되며, 저장이 막히면 이번 화면에서만 기억한다.
 * `true`는 접힘, `false`는 펼침, 없음은 아직 정하지 않음이다.
 */
const STORAGE_KEY = "fleet-console.sidebar.commanderSections.collapsed";

export interface CommanderSectionFolds {
  readonly folds: Readonly<Record<string, boolean>>;
}

export function readCommanderSectionFolds(): Readonly<Record<string, boolean>> {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const next: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") next[key] = value;
    }
    return next;
  } catch {
    return {};
  }
}

let snapshot: CommanderSectionFolds = { folds: readCommanderSectionFolds() };
const listeners = new Set<() => void>();

function persist(folds: Readonly<Record<string, boolean>>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(folds));
  } catch {
    // 저장하지 못하면 이번 화면에서만 기억한다.
  }
}

/**
 * 그 섹션의 지휘관 목록을 그릴지 — 저장값을 바꾸지 않는 파생값이다.
 * - 펼침으로 정한 섹션은 활성이 아니어도 펼친 채로 둔다.
 * - 접힘으로 정한 섹션은 활성일 때만 잠시 펼쳐 보인다. `dismissedCommodoreId`는 현재 활성 구간에서
 *   사람이 직접 접은 사령관 하나로, 사이드바 로컬 상태가 들고 활성 전환 때 비운다. 활성 중 접기는
 *   그 활성 구간 동안만 파생 펼침을 걷고, 다시 활성화하면 임시 펼침이 돌아온다.
 * - 아직 정하지 않은 섹션은 활성일 때만 펼쳐 보인다(지금까지 그대로).
 */
export function isCommanderSectionExpanded(
  folds: Readonly<Record<string, boolean>>,
  dismissedCommodoreId: string | null,
  commodoreId: string,
  activeCommodoreId: string | null,
): boolean {
  const stored = folds[commodoreId];
  if (stored === false) return true;
  if (stored === true) return commodoreId === activeCommodoreId && dismissedCommodoreId !== commodoreId;
  return commodoreId === activeCommodoreId;
}

export function setCommanderSectionCollapsed(commodoreId: string, collapsed: boolean): void {
  const stored = snapshot.folds[commodoreId];
  if (stored === collapsed) return;
  const folds = { ...snapshot.folds, [commodoreId]: collapsed };
  persist(folds);
  snapshot = { folds };
  for (const listener of listeners) listener();
}

/** 글리프 토글 — 지금 보이는 대로 뒤집는다. 펼쳐 보이면 접힘으로 기억하고, 접혀 보이면 펼침으로 기억한다. */
export function toggleCommanderSectionCollapsed(commodoreId: string, expandedNow: boolean): void {
  setCommanderSectionCollapsed(commodoreId, expandedNow);
}

export function useCommanderSectionFolds(): CommanderSectionFolds {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => snapshot,
    () => snapshot,
  );
}
