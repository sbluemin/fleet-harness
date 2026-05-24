/**
 * standing-orders/result-integrity — Result Integrity Standing Order
 *
 * Carrier 결과의 품질 평가, 크로스-Carrier 피드백 흐름, 재시도 정책을 정의한다.
 */

import type { StandingOrder } from "./types.js";

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

export const RESULT_INTEGRITY: StandingOrder = {
  id: "result-integrity",
  name: "Result Integrity",
  prompt: String.raw`## Result Integrity Standing Order

A cross-cutting procedure governing how the Admiral evaluates Carrier results, handles cross-Carrier feedback loops, and retries failed operations.

### Result Evaluation
After receiving any Carrier result, verify before reporting to the Admiral of the Navy (대원수):
1. **Relevance check** — Does the result address the original request? Flag partial or off-topic responses.
2. **Completeness check** — Are all requested deliverables present (e.g., all files listed, all sections filled)?
3. **Conflict check** — Does the result contradict prior Carrier outputs or known project state?

If any check fails, request clarification from the same Carrier with specific feedback before accepting the result.

### Cross-Carrier Feedback Patterns
When multiple Carriers contribute to the same task, apply structured feedback:

| Pattern | Flow | When |
|---------|------|------|
| **Build → Review** | implementation carrier → review carrier → findings back to implementation carrier → re-review | Standard implementation cycle |
| **Analyze → Execute** | implementation or refactoring carrier → review carrier verifies | Refactoring workflow |
| **Decide → Plan → Execute** | judgment carrier → planning carrier → execution carrier | Complex features |
| **Research → Act** | reconnaissance carrier → appropriate follow-up carrier from the active roster | Unknown scope tasks |

- After a review carrier produces findings, route actionable items back to the implementation carrier with explicit fix instructions.
- After fixes are applied, **re-run the same review** on changed code only — do not re-review the entire codebase.
- Documentation carriers run **last** in any pipeline — only after implementation and verification are complete.

### Retry Policy
When a Carrier operation fails (timeout, connection error, or runtime error):
1. **First failure** — Retry once with the same Carrier and request.
2. **Second failure** — Report the failure to the Admiral of the Navy (대원수) with the error details. Do not retry further or silently substitute another Carrier.
3. **Partial results** — If a Carrier returns partial output before failing, preserve and report what was received. Do not discard partial work.`,
};
