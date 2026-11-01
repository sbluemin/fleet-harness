import { useSyncExternalStore } from "react";

import { createServerSyncedValue } from "./commander-server-sync.js";

/** 시작 전·완료 구역의 접힘 — 데스크톱 통합 목록의 settled 구역도 같은 저장소에 둔다. 정렬과 같이 이 브라우저의 모든 사령관이 함께 쓴다. */
export type CommanderFold = "fresh" | "done" | "settled";

type FoldMap = Readonly<Record<CommanderFold, boolean>>;

// 같은 origin의 localStorage는 첫 그리기용 캐시로만 쓰고, 원천은 settings.json(`general.commanderFolds`)이다.
const FOLD_KEY = "fleet-console.commanderTab.folds";
const OPEN: FoldMap = { fresh: false, done: false, settled: false };

/** 서버·캐시값을 읽는다. 형태가 틀리면 null이다. */
function parseFolds(value: unknown): FoldMap | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Partial<Record<CommanderFold, boolean>>;
  const fresh = candidate.fresh;
  const done = candidate.done;
  const settled = candidate.settled;
  if (typeof fresh !== "boolean" || typeof done !== "boolean" || typeof settled !== "boolean") return null;
  return { fresh, done, settled };
}

function equalFolds(left: FoldMap, right: FoldMap): boolean {
  return left.fresh === right.fresh && left.done === right.done && left.settled === right.settled;
}

function readCache(): FoldMap {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(FOLD_KEY);
    if (raw === null) return OPEN;
    return parseFolds(JSON.parse(raw)) ?? OPEN;
  } catch {
    return OPEN;
  }
}

function writeCache(next: FoldMap): void {
  try {
    window.localStorage.setItem(FOLD_KEY, JSON.stringify(next));
  } catch {
    // 저장하지 못하면 이번 화면에서만 기억한다.
  }
}

const syncedFolds = createServerSyncedValue({
  field: "commanderFolds",
  defaultValue: OPEN,
  readCache,
  writeCache,
  parseServerValue: parseFolds,
  equal: equalFolds,
  isDefault: (value) => equalFolds(value, OPEN),
});

/** 동기 읽기 — 서버 값을 받기 전·실패 시에는 같은 origin 캐시(기본 펼침)를 돌려준다. */
export function readFolds(): FoldMap {
  return syncedFolds.get();
}

export function setFold(id: CommanderFold, collapsed: boolean): void {
  syncedFolds.set({ ...syncedFolds.get(), [id]: collapsed });
}

export function toggleFold(id: CommanderFold): void {
  const folds = syncedFolds.get();
  setFold(id, !folds[id]);
}

export function useCommanderFolds(): FoldMap {
  return useSyncExternalStore(syncedFolds.subscribe, syncedFolds.get, syncedFolds.get);
}
