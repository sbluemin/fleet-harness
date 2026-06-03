/**
 * protocols/standing-orders/context-confidence — Context Confidence Standing Order
 *
 * Phase 3 (Work Plan) 진입 전 evidence 충분성을 강제하는 cross-cutting gate.
 * 정의·평가 절차·재진입 메커니즘을 owning하며, Protocol은 phase boundary에서 발동만 책임진다.
 */

import type { StandingOrder } from "./types.js";

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

export const CONTEXT_CONFIDENCE: StandingOrder = {
  id: "context-confidence",
  name: "Context Confidence",
  prompt: String.raw`## Context Confidence Standing Order

Decision phases (typically Work Plan) require strong evidence before commencing — the Fleet Action Protocol's Work Plan phase in particular requires ${"`"}complete${"`"} confidence unconditionally. This Standing Order owns the operational definition, evaluation procedure, and re-entry mechanism for the Context Confidence metric; Protocols are responsible for invoking it at their phase boundaries.

### Confidence Levels (operational definition)

Confidence is determined by the resolution status of knowledge gaps identified during reconnaissance.

| Level | Operational Definition |
|-------|------------------------|
| **complete** | All blocking gaps resolved AND all confirmatory gaps resolved. Zero unverified assumptions driving the upcoming phase. |
| **sufficient** | All blocking gaps resolved. Confirmatory gaps may remain but are explicitly acknowledged as deferrable. |
| **partial** | At least one blocking gap remains unresolved. |
| **speculative** | Two or more blocking gaps remain unresolved, OR confidence has not been deliberately evaluated. |

The terms *blocking* and *confirmatory* are assigned during the reconnaissance phase's gap identification step. They are the evidence base — not a free-form judgment.

### Evidence Checklist

Confidence cannot be declared without a verifiable evidence list. Before declaring a confidence level, output an evidence list of the form:

- ${"`"}[verified]${"`"} file/symbol/fact — source (file:line | carrier job_id | direct read)
- ${"`"}[deferred]${"`"} confirmatory gap — reason for deferral
- ${"`"}[unresolved]${"`"} blocking gap — current status

A confidence label declared without an attached evidence list is treated as ${"`"}speculative${"`"} regardless of self-report.

### Gate Invocation by Protocols

Protocols invoke this Standing Order at decision boundaries by stating:

> "Apply the Context Confidence Standing Order — entry requires ≥ <threshold>."

Threshold selection follows proportionality:
- **${"`"}sufficient${"`"}** is the default threshold.
- **${"`"}complete${"`"}** is required when the upcoming work involves: structural or architectural changes, multi-carrier coordination, cross-module modifications, doctrine or prompt-policy edits, or irreversible operations.

> Note: The Fleet Action Protocol's Work Plan phase overrides this default and unconditionally requires ${"`"}complete${"`"}.

### Re-entry Mechanism (gate failure)

If confidence is below the required threshold, do NOT proceed to the gated phase. Instead:

1. Re-enter the preceding reconnaissance phase scoped narrowly to the unresolved blocking gaps.
2. Dispatch focused reconnaissance carriers if direct knowledge audit is insufficient.
3. Re-evaluate confidence after gap resolution.
4. Re-apply the gate.

Gate failure is not a workflow defect — it is the gate functioning as designed. Repeated failure within the same phase is a signal to escalate to the Admiral of the Navy (대원수), not to lower the threshold.

### Re-evaluation Triggers

Confidence is not a one-time measurement. Re-evaluate when:
- New unknowns surface during a later phase (e.g., Execution discovers an unmodelled dependency).
- Carrier results contradict a previously verified fact.
- Scope expansion brings new files or modules into the work boundary.

Upon re-evaluation downgrade, halt the current phase and re-apply the appropriate gate at the nearest decision boundary.

### Relationship to Other Standing Orders

- **Mission Anchor** governs *objective alignment* across phase boundaries.
- **Context Confidence** governs *evidence sufficiency* before decision phases.

The two gates are orthogonal: an anchored objective with speculative evidence still fails the Context Confidence gate, and conversely, complete evidence on a drifting objective still fails the Mission Anchor self-check. Apply both independently — never collapse one into the other.

### Admiral's role (yours — the host agent, 제독; not the user)

Evaluate confidence honestly and apply the gate strictly. Do not flatten partial evidence into a confident-sounding label. Surfacing ${"`"}partial${"`"} or ${"`"}speculative${"`"} is a feature, not a failure — it triggers the correct workflow (re-entry) and prevents low-quality plans from contaminating execution.`,
};
