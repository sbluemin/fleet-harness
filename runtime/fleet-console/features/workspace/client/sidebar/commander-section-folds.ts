import { useSyncExternalStore } from "react";

/**
 * 사령관 섹션별 지휘관 목록 접힘 — 사람이 직접 접거나 펼친 것만 사령관마다 기억한다.
 * 활성 사령관이 바뀌거나 새로고침해도 유지되며, 저장이 막히면 이번 화면에서만 기억한다.
 * `true`는 접힘, `false`는 펼침, 없음은 아직 정하지 않음이다.
 */
const STORAGE_KEY = "fleet-console.sidebar.commanderSections.collapsed";

export interface CommanderSectionFolds {
  readonly folds: Readonly<Record<string, boolean>>;
  /** 활성 중 사람이 접어 임시 펼침을 걷은 섹션 — 저장하지 않는 이번 화면 표시다. */
  readonly dismissed: ReadonlySet<string>;
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

let snapshot: CommanderSectionFolds = { folds: readCommanderSectionFolds(), dismissed: new Set() };
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
 * - 접힘으로 정한 섹션은 활성일 때만 잠시 펼쳐 보인다. 활성 중 사람이 접으면 그 표시를 걷는다.
 * - 아직 정하지 않은 섹션은 활성일 때만 펼쳐 보인다(지금까지 그대로).
 */
export function isCommanderSectionExpanded(
  folds: Readonly<Record<string, boolean>>,
  dismissed: ReadonlySet<string>,
  commodoreId: string,
  activeCommodoreId: string | null,
): boolean {
  const stored = folds[commodoreId];
  if (stored === false) return true;
  if (stored === true) return commodoreId === activeCommodoreId && !dismissed.has(commodoreId);
  return commodoreId === activeCommodoreId;
}

export function setCommanderSectionCollapsed(commodoreId: string, collapsed: boolean, activeCommodoreId: string | null): void {
  const stored = snapshot.folds[commodoreId];
  let folds = snapshot.folds;
  let dismissed = snapshot.dismissed;
  if (stored !== collapsed) {
    folds = { ...folds, [commodoreId]: collapsed };
    persist(folds);
  }
  if (collapsed) {
    // 활성 섹션을 접으면 임시 펼침 표시도 함께 걷는다 — 파생 펼침이 같은 활성 동안 다시 열지 못하게.
    // 저장은 '접힘' 그대로이므로 비활성이 되면 접힌 채로 선다.
    if (commodoreId === activeCommodoreId && !dismissed.has(commodoreId)) {
      dismissed = new Set(dismissed).add(commodoreId);
    }
  } else if (dismissed.has(commodoreId)) {
    const next = new Set(dismissed);
    next.delete(commodoreId);
    dismissed = next;
  }
  if (folds === snapshot.folds && dismissed === snapshot.dismissed) return;
  snapshot = { folds, dismissed };
  for (const listener of listeners) listener();
}

/** 글리프 토글 — 지금 보이는 대로 뒤집는다. 펼쳐 보이면 접힘으로 기억하고, 접혀 보이면 펼침으로 기억한다. */
export function toggleCommanderSectionCollapsed(commodoreId: string, activeCommodoreId: string | null, expandedNow: boolean): void {
  setCommanderSectionCollapsed(commodoreId, expandedNow, activeCommodoreId);
}

export function useCommanderSectionFolds(): CommanderSectionFolds {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => snapshot,
    () => snapshot,
  );
}
