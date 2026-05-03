/**
 * standing-orders/deep-dive — Deep Dive Standing Order
 *
 * 범프로토콜 검증 메커니즘: 결과에 추측/모호함이 있을 때 발동되는 절차.
 * 모든 프로토콜의 모든 단계에서 적용된다.
 */

import type { StandingOrder } from "./types.js";

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

export const DEEP_DIVE: StandingOrder = {
  id: "deep-dive",
  name: "Deep Dive",
  prompt: String.raw`## Deep Dive Standing Order

A cross-cutting verification procedure that can be triggered **from any phase** whenever results contain speculation, ambiguity, or insufficient evidence. It is not a workflow phase itself — it is a procedure that interrupts the current phase, runs to completion, and then resumes the phase.

### Trigger
Any phase produces output (from a Carrier, from the Admiral's own analysis, or from a review) that contains speculative, assumed, or unverified claims.

### Procedure
1. **Surface scan** — Look for obvious speculation markers (e.g., "likely", "probably", "I think", "may be", "not sure but…").
2. **Speculation audit** — If the result is lengthy, complex, or touches unfamiliar territory, skip your own scan and delegate the audit:
   - **Task Force available**: If a Carrier whose role fits the audit task is configured for Task Force, use ${"``"}carrier_taskforce${"``"} to cross-validate across that carrier's configured backends. Consensus among backends strengthens confidence; divergence pinpoints what needs further investigation.
   - **Fallback**: Otherwise, dispatch an appropriate Carrier via its individual tool (${"``"}carrier_<id>${"``"}).
   - In either case, provide explicit instructions: *"Review the following analysis for speculative, assumed, or unverified claims. Flag each with evidence of why it is speculative and what verification is needed."*
3. **Follow-up verification** — For each identified speculative element:
   - **Task Force available**: Use ${"``"}carrier_taskforce${"``"} to seek independent confirmation or refutation from that carrier's configured backends.
   - **Fallback**: Dispatch an appropriate Carrier via its individual tool (${"``"}carrier_<id>${"``"}).
4. **Repeat** until all speculative elements are either **confirmed with evidence** or explicitly flagged as **unresolvable unknowns**.

### Depth limit
Deep Dive verification depth is capped at **2 iterations**. If after 2 rounds of audit + follow-up verification a claim remains unconfirmed, mark it as ${"``"}[Unverified — depth limit reached]${"``"} and report it to the Admiral of the Navy (대원수). Do not continue iterating — the cost of further verification outweighs the risk of surfaced uncertainty.

### Admiral's role
Your role throughout Deep Dive is **coordination, not investigation**. Route, synthesize, and report — do not spend effort on direct deep analysis. Do **not** flatten uncertainty into confident-sounding summaries — preserve and surface ambiguity honestly.`,
};
