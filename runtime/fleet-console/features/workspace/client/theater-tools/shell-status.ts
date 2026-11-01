import { useSyncExternalStore } from "react";

/**
 * Theater별 Shell 상태 조회 — 메뉴의 초록 점과 설정의 해제 확인이 함께 읽는다.
 * 답을 아는 쪽은 Shell이다(미션 8이 공급자를 단다). 그 전까지는 "살아 있지 않고 바쁘지 않다"가
 * 답이라 점도 확인도 서지 않는다 — 조용히 꺼 두는 것이 모르는 값을 지어내는 것보다 낫다.
 */
export interface CommodoreShellTheaterStatus {
  readonly live: boolean;
  readonly busy: boolean;
}

export interface CommodoreShellStatusProvider {
  readonly query: (commodoreId: string, theaterId: string) => CommodoreShellTheaterStatus;
  readonly subscribe: (listener: () => void) => () => void;
}

const IDLE: CommodoreShellTheaterStatus = { live: false, busy: false };
const LIVE_AT_PROMPT: CommodoreShellTheaterStatus = { live: true, busy: false };
const LIVE_BUSY: CommodoreShellTheaterStatus = { live: true, busy: true };

/**
 * 참조 안정한 답 — `useSyncExternalStore`의 getSnapshot은 같은 값에 같은 참조를 돌려줘야 한다.
 * 매번 새 객체를 만들면 메뉴 같은 구독자가 무한 렌더에 빠진다(사령관 도구 메뉴 실측).
 */
export function stableShellStatus(live: boolean, busy: boolean): CommodoreShellTheaterStatus {
  if (!live) return IDLE;
  return busy ? LIVE_BUSY : LIVE_AT_PROMPT;
}

const idleProvider: CommodoreShellStatusProvider = {
  query: () => IDLE,
  subscribe: () => () => undefined,
};

let provider: CommodoreShellStatusProvider = idleProvider;
const providerListeners = new Set<() => void>();

function emitProvider(): void {
  for (const listener of [...providerListeners]) listener();
}

/** Shell이 공급자를 단다 — 미션 8. 해지하면 기본(조용함)으로 돌아간다. */
export function registerCommodoreShellStatusProvider(next: CommodoreShellStatusProvider): () => void {
  provider = next;
  emitProvider();
  return () => {
    if (provider === next) {
      provider = idleProvider;
      emitProvider();
    }
  };
}

function subscribeProvider(listener: () => void): () => void {
  providerListeners.add(listener);
  return () => { providerListeners.delete(listener); };
}

/** 설정의 Theater 해제 확인이 읽는다 — 그 Theater의 Shell이 바쁜지만 보면 된다. */
export function queryCommodoreShellStatus(commodoreId: string, theaterId: string): CommodoreShellTheaterStatus {
  try {
    return provider.query(commodoreId, theaterId);
  } catch {
    return IDLE;
  }
}

/** 패널 메뉴의 초록 점이 읽는다 — Theater마다 한 행이 구독한다. */
export function useCommodoreShellStatus(commodoreId: string | null, theaterId: string | null): CommodoreShellTheaterStatus {
  return useSyncExternalStore(
    (listener) => {
      const offProvider = subscribeProvider(listener);
      const offStatus = provider.subscribe(listener);
      return () => { offProvider(); offStatus(); };
    },
    () => (commodoreId !== null && theaterId !== null ? queryCommodoreShellStatus(commodoreId, theaterId) : IDLE),
    () => IDLE,
  );
}
