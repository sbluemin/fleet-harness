/**
 * 모듈 수준 스토어의 구독자 목록. `useSyncExternalStore`의 `subscribe`로 그대로 쓰고, 상태를 바꾼 쪽이 `emit`을 부른다.
 * 스냅샷·초기값·테스트 초기화는 각 스토어가 소유한다 — 이 목록은 구독자만 든다.
 */
export interface ListenerSet {
  readonly subscribe: (listener: () => void) => () => void;
  readonly emit: () => void;
  readonly clear: () => void;
}

export function createListenerSet(): ListenerSet {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit() {
      for (const listener of listeners) listener();
    },
    clear() {
      listeners.clear();
    },
  };
}
