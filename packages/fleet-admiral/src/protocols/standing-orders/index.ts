/**
 * standing-orders/index — Standing Order 레지스트리
 *
 * 등록된 모든 Standing Order를 관리하고 반환한다.
 * doctrine별 override는 id·주입 순서를 유지한 채 본문만 교체한다.
 */

import type { AdmiralDoctrine } from "../doctrine.js";
import type { StandingOrder } from "./types.js";

import {
  CARRIER_OPERATIONS_POLICY,
  CARRIER_OPERATIONS_POLICY_FOR_GATEWAY,
} from "./carrier-operations-policy.js";
import { COMMAND_INTEGRITY } from "./command-integrity.js";
import { CONTEXT_CONFIDENCE } from "./context-confidence.js";
import {
  DEEP_DIVE,
  DEEP_DIVE_FOR_GATEWAY,
} from "./deep-dive.js";
import { MISSION_ANCHOR } from "./mission-anchor.js";
import {
  RESULT_INTEGRITY,
  RESULT_INTEGRITY_FOR_GATEWAY,
} from "./result-integrity.js";

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

/** classic doctrine Standing Orders — 주입 순서대로 나열. */
const STANDING_ORDERS_CLASSIC: readonly StandingOrder[] = [
  COMMAND_INTEGRITY,
  MISSION_ANCHOR,
  CONTEXT_CONFIDENCE,
  CARRIER_OPERATIONS_POLICY,
  DEEP_DIVE,
  RESULT_INTEGRITY,
];

/** gateway doctrine Standing Orders — 동일 id·순서를 유지하고 override 본문만 교체. */
const STANDING_ORDERS_GATEWAY: readonly StandingOrder[] = [
  COMMAND_INTEGRITY,
  MISSION_ANCHOR,
  CONTEXT_CONFIDENCE,
  CARRIER_OPERATIONS_POLICY_FOR_GATEWAY,
  DEEP_DIVE_FOR_GATEWAY,
  RESULT_INTEGRITY_FOR_GATEWAY,
];

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
