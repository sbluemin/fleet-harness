/**
 * standing-orders/index — Standing Order 레지스트리
 *
 * 등록된 모든 Standing Order를 관리하고 반환한다.
 * 새 Standing Order 추가 시 여기에 import 1줄만 추가하면 된다.
 */

import type { StandingOrder } from "./types.js";

import { CARRIER_OPERATIONS_POLICY } from "./carrier-operations-policy.js";
import { CONTEXT_CONFIDENCE } from "./context-confidence.js";
import { DEEP_DIVE } from "./deep-dive.js";
import { MISSION_ANCHOR } from "./mission-anchor.js";
import { RESULT_INTEGRITY } from "./result-integrity.js";

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

/** 등록된 Standing Orders — 주입 순서대로 나열 */
const STANDING_ORDERS: readonly StandingOrder[] = [
  MISSION_ANCHOR,
  CONTEXT_CONFIDENCE,
  CARRIER_OPERATIONS_POLICY,
  DEEP_DIVE,
  RESULT_INTEGRITY,
];

// ─────────────────────────────────────────────────────────
// 함수
// ─────────────────────────────────────────────────────────

/** 등록된 모든 Standing Order를 주입 순서대로 반환한다. */
export function getAllStandingOrders(): readonly StandingOrder[] {
  return STANDING_ORDERS;
}
