import type { ClientApiCapability } from "@fleet-console/sdk/plugin";

import type { QuotaSummaryDto } from "@fleet-console/ai-gateway";
import { PROVIDER_ORDER_DEFAULT, sanitizeProviderOrder, type ProviderId } from "../provider-order.js";

/**
 * 사용 한도 요약의 공유 원천 — 레일 패널과 도구모음 요약이 같은 한 장을 읽는다.
 *
 * 폴링의 주인은 하나다. 패널이 열려 있으면 패널이 자기 주기(60초, 화면이 보일 때)로 읽고 그 결과를 여기에
 * 싣는다. 패널이 닫혀 있고 요약이 서 있을 때만 요약이 같은 주기로 읽는다 — 둘이 동시에 폴링하지 않는다.
 * 요청은 Gateway가 single-flight로 묶고 5분 캐시로 답하므로, 겹친 한 번도 upstream을 두 번 부르지 않는다.
 */

const POLL_MS = 60_000;

export interface QuotaSummarySnapshot {
  readonly data: QuotaSummaryDto | null;
  /** 사용자가 패널에서 정한 카드 순서 — 요약이 같은 급의 공급자 중 무엇을 앞세울지 정한다. */
  readonly order: readonly ProviderId[];
  /** 마지막으로 읽은 시각(ms). 0이면 아직 읽지 않았다. */
  readonly checkedAt: number;
  /** 레일 패널이 지금 서 있는가 — 서 있으면 폴링은 패널 몫이고, 요약은 켜짐 표식을 단다. */
  readonly panelOpen: boolean;
}

type SummaryResponse = QuotaSummaryDto & { readonly providerOrder?: unknown; readonly revalidating?: boolean };

let snapshot: QuotaSummarySnapshot = { data: null, order: PROVIDER_ORDER_DEFAULT, checkedAt: 0, panelOpen: false };
const listeners = new Set<() => void>();
let api: ClientApiCapability | null = null;
let panelHolds = 0;
let summaryHolds = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

function emit(next: QuotaSummarySnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getQuotaSummarySnapshot(): QuotaSummarySnapshot {
  return snapshot;
}

export function subscribeQuotaSummary(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 플러그인 설치가 API 능력을 건넨다. 도구모음 항목의 render()는 문맥을 받지 않기 때문이다. */
export function connectQuotaSummaryApi(next: ClientApiCapability): () => void {
  api = next;
  return () => {
    if (api === next) api = null;
  };
}

/** 패널이 화면에 선 그대로를 싣는다(응답 채택·순서 이동 모두). */
export function publishQuotaSummary(data: QuotaSummaryDto, order: readonly ProviderId[], checkedAt: number): void {
  if (snapshot.data === data && snapshot.order === order && snapshot.checkedAt === checkedAt) return;
  emit({ ...snapshot, data, order, checkedAt });
}

/** 패널이 서 있는 동안 쥔다. 놓으면 요약이 폴링을 이어받는다. */
export function holdQuotaPanel(): () => void {
  panelHolds += 1;
  if (!snapshot.panelOpen) emit({ ...snapshot, panelOpen: true });
  syncPolling();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    panelHolds -= 1;
    if (panelHolds === 0) emit({ ...snapshot, panelOpen: false });
    syncPolling();
  };
}

/** 도구모음 요약이 서 있는 동안 쥔다. 처음 쥐거나 값이 한 주기보다 오래됐으면 곧바로 한 번 읽는다. */
export function holdQuotaSummary(): () => void {
  summaryHolds += 1;
  syncPolling();
  if (panelHolds === 0 && Date.now() - snapshot.checkedAt >= POLL_MS) void readSummary();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    summaryHolds -= 1;
    syncPolling();
  };
}

function syncPolling(): void {
  const wanted = summaryHolds > 0 && panelHolds === 0;
  if (wanted && pollTimer === null) {
    pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") void readSummary();
    }, POLL_MS);
  } else if (!wanted && pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function readSummary(): Promise<void> {
  const capability = api;
  if (capability === null || inFlight || panelHolds > 0) return;
  inFlight = true;
  try {
    // 그릴 것이 없을 때만 만료된 캐시라도 먼저 받는다 — 패널의 첫 읽기와 같은 규칙.
    const response = await capability.fetch("quota", snapshot.data === null ? "summary?stale=1" : "summary");
    if (!response.ok) return;
    const result = await response.json() as SummaryResponse;
    // 그사이 패널이 열렸으면 패널의 답이 이긴다 — 늦게 온 이 답이 패널이 실은 값을 덮지 않게.
    if (panelHolds > 0) return;
    emit({ ...snapshot, data: result, order: sanitizeProviderOrder(result.providerOrder), checkedAt: result.revalidating === true ? snapshot.checkedAt : Date.now() });
  } catch {
    // 요약은 곁눈의 신호다 — 실패는 다음 주기가 다시 묻는다. 오류 안내는 패널의 몫이다.
  } finally {
    inFlight = false;
  }
}
