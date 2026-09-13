import { useSyncExternalStore } from "react";

import { getState, subscribe } from "../store.js";
import type { ConsoleState } from "../types.js";

export function useConsoleState(): ConsoleState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/**
 * Theater 이름 하나만 구독한다 — 칩마다 전체 상태를 구독하면 무관한 변화에도 목록이 통째로 다시 그려진다.
 * 스냅샷이 문자열이라 값이 그대로면 React가 렌더를 건너뛴다.
 */
export function useTheaterLabel(theaterId: string | null | undefined): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (theaterId ? getState().theaters.find((theater) => theater.id === theaterId)?.label ?? null : null),
    () => null,
  );
}
