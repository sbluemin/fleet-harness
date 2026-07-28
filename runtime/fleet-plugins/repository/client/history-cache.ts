import type { LogCommitEntry, WorktreeCheckout } from "../server/types.js";

// 이 캐시는 host와 상태를 조율하지 않고 repository 플러그인 client 번들 안에서만 재마운트 상태를 잇는다.
// 따라서 host/plugin이 별도 모듈 사본을 로드할 수 있는 경계에서도 모듈 스코프 저장소가 안전하다.
export const HISTORY_CACHE_LIMIT = 4;

export interface HistoryCacheEntry {
  readonly commits: readonly LogCommitEntry[];
  readonly checkouts: readonly WorktreeCheckout[];
  readonly hasMore: boolean;
  readonly truncated: boolean;
  readonly scrollTop: number;
  readonly targetHash: string | null;
  readonly filterText: string;
}

const historyCache = new Map<string, HistoryCacheEntry>();

export function readHistoryCache(scope: string): HistoryCacheEntry | null {
  const entry = historyCache.get(scope);
  if (!entry) return null;
  historyCache.delete(scope);
  historyCache.set(scope, entry);
  return entry;
}

export function writeHistoryCache(scope: string, entry: HistoryCacheEntry): void {
  historyCache.delete(scope);
  historyCache.set(scope, entry);
  if (historyCache.size <= HISTORY_CACHE_LIMIT) return;
  const oldest = historyCache.keys().next().value;
  if (oldest !== undefined) historyCache.delete(oldest);
}

export function dropHistoryCache(scope: string): void {
  historyCache.delete(scope);
}

export function dropHistoryCacheForRepository(scope: string): void {
  for (const key of historyCache.keys()) {
    if (key === scope || key.startsWith(`${scope}::`)) historyCache.delete(key);
  }
}
