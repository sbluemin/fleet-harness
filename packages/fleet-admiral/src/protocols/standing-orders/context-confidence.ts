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

Decision checkpoints require evidence at the threshold declared by the active protocol's planning boundary. This Standing Order owns the operational definition, evaluation procedure, and re-entry mechanism for the Context Confidence metric; Protocols are responsible for invoking it at their checkpoint boundaries.

### Confidence Levels (operational definition)

Confidence is determined by the resolution status of knowledge gaps identified during reconnaissance.

| Level | Operational Definition |
|-------|------------------------|
| **complete** | All blocking gaps resolved AND all confirmatory gaps resolved. Zero unverified assumptions driving the upcoming checkpoint. |
| **sufficient** | All blocking gaps resolved. Confirmatory gaps may remain but are explicitly acknowledged as deferrable. |
| **partial** | At least one blocking gap remains unresolved. |
| **speculative** | Two or more blocking gaps remain unresolved, OR confidence has not been deliberately evaluated. |

The terms *blocking* and *confirmatory* are assigned during the reconnaissance checkpoint's gap identification step. They are the evidence-criticality axis — not a free-form judgment. Keep this axis separate from the later re-entry resolution-path taxonomy owned by ${"`"}assumption-audit${"`"}.

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

### Re-entry Mechanism (gate failure)

If confidence is below the required threshold, do NOT proceed to the gated checkpoint. Instead:

1. Re-enter the preceding reconnaissance checkpoint scoped narrowly to the unresolved blocking gaps.
2. Triage each unresolved blocking gap by the scout-shaped, decision-shaped, or escalation-shaped taxonomy defined in ${"`"}assumption-audit${"`"}.
3. Re-evaluate confidence after gap resolution.
4. Re-apply the gate.

Gate failure is not a workflow defect — it is the gate functioning as designed. Repeated failure within the same checkpoint is a signal to escalate to the Admiral of the Navy (대원수), not to lower the threshold.

### Re-evaluation Triggers

Confidence is not a one-time measurement. Re-evaluate when:
- New unknowns surface during a later checkpoint (e.g., Execution discovers an unmodelled dependency).
- Result Integrity identifies a contradiction with a previously verified fact.
- Scope expansion brings new files or modules into the work boundary.

Upon re-evaluation downgrade, halt the current checkpoint and re-apply the appropriate gate at the nearest decision boundary.

Contradiction-trigger handling is routed by the Result Integrity trigger mapping table.

### Relationship to Other Standing Orders

- **Mission Anchor** governs *objective alignment* across checkpoint boundaries.
- **Context Confidence** governs *evidence sufficiency* before decision checkpoints.

The two gates are orthogonal: an anchored objective with speculative evidence still fails the Context Confidence gate, and conversely, complete evidence on a drifting objective still fails the Mission Anchor self-check. Apply both independently — never collapse one into the other.`,
};
