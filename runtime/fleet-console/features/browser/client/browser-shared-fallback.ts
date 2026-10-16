import { React } from "@fleet-console/sdk/plugin/browser";

/**
 * Desktop shared 중 링크를 내 브라우저로 열 때, 세션당 한 번 안내한다.
 * Session 브라우저가 멈춰 있다는 사실이지, 별도의 전역 브라우저가 아니다.
 */

let sharedFallbackShown = false;
let sharedFallbackVisible = false;
const sharedFallbackListeners = new Set<() => void>();

function emitSharedFallback(): void {
  for (const listener of sharedFallbackListeners) listener();
}

function subscribeSharedFallback(listener: () => void): () => void {
  sharedFallbackListeners.add(listener);
  return () => { sharedFallbackListeners.delete(listener); };
}

export function notifySharedFallback(): void {
  if (sharedFallbackShown) return;
  sharedFallbackShown = true;
  sharedFallbackVisible = true;
  emitSharedFallback();
}

export function dismissSharedFallback(): void {
  if (!sharedFallbackVisible) return;
  sharedFallbackVisible = false;
  emitSharedFallback();
}

export function useSharedFallbackNotice(): boolean {
  return React.useSyncExternalStore(subscribeSharedFallback, () => sharedFallbackVisible, () => false);
}
