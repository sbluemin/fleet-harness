/**
 * standing-orders/index — Standing Order 레지스트리
 *
 * doctrine별 Standing Order 목록을 반환한다. 본문은 각각 `classic.ts`와 `gateway.ts`가
 * 단독으로 소유하며, 두 파일은 본문을 공유하지 않는다.
 */

import type { AdmiralDoctrine } from "../doctrine.js";
import type { StandingOrder } from "./types.js";

import { STANDING_ORDERS_CLASSIC } from "./classic.js";
import { STANDING_ORDERS_GATEWAY } from "./gateway.js";

// ─────────────────────────────────────────────────────────
// 함수
// ─────────────────────────────────────────────────────────

/** doctrine별 Standing Order를 주입 순서대로 반환한다. 기본값은 classic. */
export function getAllStandingOrders(
  doctrine: AdmiralDoctrine = "classic",
): readonly StandingOrder[] {
  return doctrine === "gateway" ? STANDING_ORDERS_GATEWAY : STANDING_ORDERS_CLASSIC;
}

/** getAllStandingOrders의 명시적 alias. */
export function getStandingOrdersForDoctrine(
  doctrine: AdmiralDoctrine,
): readonly StandingOrder[] {
  return getAllStandingOrders(doctrine);
}
