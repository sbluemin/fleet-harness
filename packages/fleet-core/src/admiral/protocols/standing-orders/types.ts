/**
 * standing-orders/types — Standing Order 타입 정의
 *
 * Standing Order는 모든 프로토콜에 항상 주입되는 cross-cutting 메커니즘이다.
 * 해군 세계관에서 "함장 부재 시에도 항시 유효한 규칙"을 의미한다.
 */

// ─────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────

/** Standing Order — 프로토콜 전환과 무관하게 항상 시스템 프롬프트에 포함되는 지침 */
export interface StandingOrder {
  /** 고유 식별자 (예: "carrier-operations-policy", "deep-dive") */
  id: string;
  /** 표시 이름 (예: "Carrier Operations Policy", "Deep Dive") */
  name: string;
  /** 프롬프트 본문 */
  prompt: string;
}
