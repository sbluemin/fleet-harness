/**
 * standing-orders/index — Standing Order 레지스트리
 *
 * 본문은 `gateway.ts`가 단독으로 소유한다.
 */

import { STANDING_ORDERS_GATEWAY } from "./gateway.js";

// ─────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────

/** Standing Order — 프로토콜 전환과 무관하게 항상 시스템 프롬프트에 포함되는 지침 */
export interface StandingOrder {
  /** 고유 식별자 (예: "orchestration-policy", "deep-dive") */
  id: string;
  /** 표시 이름 (예: "Orchestration Policy", "Deep Dive") */
  name: string;
  /** 프롬프트 본문 */
  prompt: string;
}

// ─────────────────────────────────────────────────────────
// 함수
// ─────────────────────────────────────────────────────────

/** Standing Order를 주입 순서대로 반환한다. */
export function getAllStandingOrders(): readonly StandingOrder[] {
  return STANDING_ORDERS_GATEWAY;
}
