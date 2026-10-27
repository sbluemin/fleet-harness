import { useSyncExternalStore } from "react";

/** 시작 전·완료 구역의 접힘. 정렬과 같이 이 브라우저의 모든 사령관이 함께 쓴다. */
export type CommanderFold = "fresh" | "done";

const FOLD_KEY = "fleet-console.commanderTab.folds";
const OPEN: Readonly<Record<CommanderFold, boolean>> = { fresh: false, done: false };

export function readFolds(): Readonly<Record<CommanderFold, boolean>> {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(FOLD_KEY);
    if (raw === null) return OPEN;
    const parsed = JSON.parse(raw) as Partial<Record<CommanderFold, boolean>>;
    return { fresh: parsed.fresh === true, done: parsed.done === true };
  } catch {
    return OPEN;
  }
}

let folds = readFolds();
const listeners = new Set<() => void>();

export function setFold(id: CommanderFold, collapsed: boolean): void {
  folds = { ...folds, [id]: collapsed };
  try {
    window.localStorage.setItem(FOLD_KEY, JSON.stringify(folds));
  } catch {
    // 저장하지 못하면 이번 화면에서만 기억한다.
  }
  for (const listener of listeners) listener();
}

export function toggleFold(id: CommanderFold): void {
  setFold(id, !folds[id]);
}

export function useCommanderFolds(): Readonly<Record<CommanderFold, boolean>> {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => folds,
    () => folds,
  );
}
