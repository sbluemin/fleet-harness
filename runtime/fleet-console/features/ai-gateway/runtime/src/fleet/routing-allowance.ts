/**
 * routing-allowance — 배정이 허용량을 읽는 자리.
 *
 * 로스터는 허용량을 **모델에게 읽히려고** 싣는다. 여기서는 그것을 배정이 직접 쓴다: 소진
 * 직전인 공급자를 후보에서 내리고, 남은 공급자 사이를 고르게 돌린다.
 *
 * 로스터와 같은 판정을 쓰되(`deriveQuotaWindowRisk`) 같은 페이로드를 짓지는 않는다. 로스터는
 * 사람과 모델이 읽는 문서라 모든 창을 다 싣지만, 배정에 필요한 것은 공급자 하나당 한 글자짜리
 * 평결뿐이다.
 */

import { deriveQuotaWindowRisk, type QuotaWindowPressure } from "../quota/pressure.js";
import type { GatewayQuotaSnapshot, GatewayProviderQuota } from "./quota-snapshot.js";

/** 압박이 센 순서. 한 모델을 여러 창이 묶으면 가장 restrictive한 평결이 이긴다. */
const SEVERITY: Readonly<Record<QuotaWindowPressure, number>> = { ok: 0, elevated: 1, critical: 2 };

/**
 * 이 모델이 지금 어느 압박 아래 있는가. 읽을 수 없으면 `undefined`.
 *
 * **부재는 안전이 아니다.** 읽지 못한 허용량은 `critical`로도 `ok`로도 읽지 않는다 — 배제하면
 * 멀쩡한 공급자를 잃고, 통과시키면 소진된 공급자에 몰아넣는다. 호출자가 그 중간을 정한다.
 *
 * 공급자가 보고한 창은 모두 동시에 적용된다.
 */
export function modelPressure(quota: GatewayProviderQuota | undefined): QuotaWindowPressure | undefined {
  const binding = quota?.windows;
  if (!binding || binding.length === 0) return undefined;
  const at = typeof quota?.fetchedAt === "number" && Number.isFinite(quota.fetchedAt)
    ? quota.fetchedAt
    : Date.now();
  let worst: QuotaWindowPressure | undefined;
  for (const window of binding) {
    const { pressure } = deriveQuotaWindowRisk(window, at);
    if (pressure === undefined) continue;
    if (worst === undefined || SEVERITY[pressure] > SEVERITY[worst]) worst = pressure;
  }
  return worst;
}

/** 이 공급자의 허용량을 아예 읽지 못했는가. `signed_out`도 여기에 들어온다. */
export function allowanceUnreadable(snapshot: GatewayQuotaSnapshot | undefined, provider: string): boolean {
  const quota = snapshot?.[provider];
  if (!quota) return true;
  return !quota.windows || quota.windows.length === 0;
}
