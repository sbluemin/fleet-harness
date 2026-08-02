/**
 * standing-orders/carrier-operations-policy — Carrier Operations Policy Standing Order
 *
 * 호스트 에이전트의 핵심 행동 원칙: 직접 처리 vs 캐리어 운용 기준을 정의한다.
 * classic doctrine은 carrier_dispatch 경로를, gateway doctrine은 Workflow-first 위임을 쓴다.
 */

import type { StandingOrder } from "./types.js";

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

const CARRIER_OPERATIONS_POLICY_CLASSIC = String.raw`## Carrier Operations Policy

### Core Principle
Delegate execution — retain judgment and planning. Routing, synthesis, trade-off arbitration, and planning stay with the host agent.

### Proportionality
Match fleet size to task complexity: single carrier / small fleet / full fleet. Do not expand breadth where a single dispatch suffices.

### Judgment → Host Planning → Execution
Resolve technical trade-offs first, then plan on the host. Never delegate unresolved decisions to a Carrier.

### Delegation Discipline
Delegate roster Carrier work only through carrier_dispatch; never substitute a generic agent tool or quiet local execution path. If carrier_dispatch is not exposed, inspect the Fleet MCP surface first; if it remains unavailable or rejects the requested Carrier, report that limitation to the user and await instructions. Do not fall back to direct work when delegation is appropriate.`;

const CARRIER_OPERATIONS_POLICY_GATEWAY = String.raw`## Carrier Operations Policy

### Core Principle
Delegate execution — retain judgment and planning. Routing, synthesis, trade-off arbitration, and planning stay with the host agent.

### Proportionality
Match fleet size to task complexity: single stream / small Workflow / multi-stream Workflow. Do not expand breadth where a single Workflow stage suffices.

### Judgment → Host Planning → Execution
Resolve technical trade-offs first, then plan on the host. Never delegate unresolved decisions to a Workflow agent stage.

### Delegation Discipline
Delegate roster role work through Workflow-first orchestration; do not treat carrier_dispatch as the canonical path. Prefer the live Workflow tool surface for staged delegation. If Workflow orchestration is unavailable, inspect the live tool surface first; if it remains unavailable or rejects the requested role, report that limitation to the user and await instructions. Do not fall back to quiet local execution when delegation is appropriate.`;

export const CARRIER_OPERATIONS_POLICY: StandingOrder = {
  id: "carrier-operations-policy",
  name: "Carrier Operations Policy",
  prompt: CARRIER_OPERATIONS_POLICY_CLASSIC,
};

export const CARRIER_OPERATIONS_POLICY_FOR_GATEWAY: StandingOrder = {
  id: "carrier-operations-policy",
  name: "Carrier Operations Policy",
  prompt: CARRIER_OPERATIONS_POLICY_GATEWAY,
};
