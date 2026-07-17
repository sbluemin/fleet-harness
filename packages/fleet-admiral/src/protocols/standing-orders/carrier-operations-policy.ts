/**
 * standing-orders/carrier-operations-policy — Carrier Operations Policy Standing Order
 *
 * 호스트 에이전트의 핵심 행동 원칙: 직접 처리 vs 캐리어 운용 기준을 정의한다.
 */

import type { StandingOrder } from "./types.js";

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

export const CARRIER_OPERATIONS_POLICY: StandingOrder = {
  id: "carrier-operations-policy",
  name: "Carrier Operations Policy",
  prompt: String.raw`## Carrier Operations Policy

### Core Principle
Delegate execution — retain judgment. Routing, synthesis, and trade-off arbitration stay with the host agent.

### Proportionality
Match fleet size to task complexity: single carrier / small fleet / full fleet. Do not expand breadth where a single dispatch suffices.

### Judgment → Planning → Execution
Resolve technical trade-offs first; never delegate unresolved decisions to a planning carrier.

### Delegation Discipline
Delegate roster Carrier work only through carrier_dispatch; never substitute a generic agent tool or quiet local execution path. If carrier_dispatch is not exposed or rejects the requested Carrier, inspect the Fleet MCP surface first; if it remains unavailable, report that limitation to the user and await instructions. Do not fall back to direct work when delegation is appropriate.`,
};
