import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from "react";

/**
 * 대화 칸의 입력 독. 독을 그리는 기능이 요소를 등록하고, 컨텍스트 칩 줄은 그 요소의 위에서 끝난다.
 * 레일은 기능의 클래스 이름을 알지 못한다.
 */
let docks: readonly HTMLElement[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 이 요소가 마운트된 동안 입력 독으로 등록한다. 돌려준 함수로 거둔다. */
export function registerConversationDock(element: HTMLElement): () => void {
  if (!docks.includes(element)) {
    docks = [...docks, element];
    emit();
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    docks = docks.filter((dock) => dock !== element);
    emit();
  };
}

export function useConversationDocks(): readonly HTMLElement[] {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => docks,
    () => docks,
  );
}

/**
 * 독 루트에 붙이는 ref. 같은 노드가 다시 오면 등록을 유지하고, 빠지면 거둔다.
 */
export function useConversationDockRef<T extends HTMLElement>(): (node: T | null) => void {
  const release = useRef<(() => void) | null>(null);
  const bound = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => () => {
    release.current?.();
    release.current = null;
    bound.current = null;
  }, []);
  return useCallback((node: T | null) => {
    if (bound.current === node) return;
    release.current?.();
    release.current = null;
    bound.current = node;
    if (node) release.current = registerConversationDock(node);
  }, []);
}

/** 이미 ref 객체를 가진 독이 그 노드를 등록하게 한다. */
export function useRegisterConversationDock(dock: RefObject<HTMLElement | null>): void {
  const register = useConversationDockRef();
  useLayoutEffect(() => { register(dock.current); });
}
