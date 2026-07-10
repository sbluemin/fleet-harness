/**
 * protocols/standing-orders/context-confidence — Context Confidence Standing Order
 *
 * Active protocol planning boundary 진입 전 evidence 충분성을 강제하는 cross-cutting gate.
 * 정의·평가 절차·재진입 메커니즘을 owning하며, Protocol은 checkpoint boundary에서 발동만 책임진다.
 */

import type { StandingOrder } from "./types.js";

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

export const CONTEXT_CONFIDENCE: StandingOrder = {
  id: "context-confidence",
  name: "Context Confidence",
  prompt: String.raw`## Context Confidence Standing Order

Decision checkpoints require evidence at the threshold declared by the active protocol's planning boundary. This Standing Order owns the confidence definition, evaluation procedure, and re-entry mechanism; Protocols invoke it at their checkpoint boundaries by stating: "Apply the Context Confidence Standing Order — entry requires ≥ <threshold>."

### Confidence Levels (operational definition)

Confidence is determined by the resolution status of knowledge gaps identified during reconnaissance. The *blocking* / *confirmatory* labels are assigned during the reconnaissance gap-identification step — an evidence-criticality axis, kept separate from the re-entry resolution-path taxonomy owned by ${"`"}assumption-audit${"`"}.

| Level | Operational Definition |
|-------|------------------------|
| **complete** | All blocking AND confirmatory gaps resolved. Zero unverified assumptions driving the upcoming checkpoint. |
| **sufficient** | All blocking gaps resolved; remaining confirmatory gaps explicitly acknowledged as deferrable. |
| **partial** | At least one blocking gap unresolved. |
| **speculative** | Two or more blocking gaps unresolved, OR confidence never deliberately evaluated. |

Threshold selection: **${"`"}sufficient${"`"}** is the default; **${"`"}complete${"`"}** is required when any Downward Guard trigger (defined in the Protocol Gate) or multi-carrier coordination is in scope.

### Evidence Checklist

A confidence level cannot be declared without a verifiable evidence list; a label without one is treated as ${"`"}speculative${"`"} regardless of self-report. Before declaring, output:

- ${"`"}[verified]${"`"} file/symbol/fact — source (file:line | carrier job_id | direct read)
- ${"`"}[deferred]${"`"} confirmatory gap — reason for deferral
- ${"`"}[unresolved]${"`"} blocking gap — current status

### Re-entry Mechanism (gate failure)

If confidence is below the required threshold, do NOT proceed to the gated checkpoint. Instead:

1. Re-enter the preceding reconnaissance checkpoint scoped narrowly to the unresolved blocking gaps.
2. Triage each gap by the scout-shaped / decision-shaped / escalation-shaped taxonomy defined in ${"`"}assumption-audit${"`"}.
3. Re-evaluate confidence after gap resolution, then re-apply the gate.

Gate failure is the gate functioning as designed, not a workflow defect. Repeated failure within the same checkpoint is a signal to escalate to the user, never to lower the threshold.

### Re-evaluation Triggers

Confidence is not a one-time measurement. Re-evaluate when new unknowns surface during a later checkpoint, when Result Integrity identifies a contradiction with a previously verified fact (routed by its trigger mapping table), or when scope expansion brings new files or modules into the work boundary. Upon downgrade, halt the current checkpoint and re-apply the gate at the nearest decision boundary.

### Relationship to Mission Anchor

Mission Anchor governs *objective alignment*; Context Confidence governs *evidence sufficiency*. The two gates are orthogonal — apply both independently and never collapse one into the other.`,
};
