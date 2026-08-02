/**
 * standing-orders/result-integrity — Result Integrity Standing Order
 *
 * Carrier/Workflow 결과의 품질 평가, 크로스-에이전트 피드백 흐름, 재시도 정책을 정의한다.
 */

import type { StandingOrder } from "./types.js";

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

const RESULT_INTEGRITY_CLASSIC = String.raw`## Result Integrity Standing Order

A cross-cutting procedure governing how the host agent evaluates Carrier results, handles cross-Carrier feedback loops, and retries failed operations.

### Trigger Mapping
| Trigger | Route |
|---|---|
| Result received | Run the Result Integrity relevance, completeness, and conflict checks. |
| Mutating job finalized | Run the Artifact Inspection Gate. |
| Speculation found | Invoke Deep Dive. |
| Contradiction with verified fact | Re-evaluate Context Confidence. |

### Result Evaluation
After receiving any Carrier result, verify before reporting to the user:
1. **Relevance check** — Does the result address the original request? Flag partial or off-topic responses.
2. **Completeness check** — Are all requested deliverables present (e.g., all files listed, all sections filled)?
3. **Conflict check** — Does the result contradict prior Carrier outputs or known project state?

If any check fails, request clarification from the same Carrier with specific feedback before accepting the result.

### Artifact Inspection Gate
For any carrier job that mutates the workspace (code, docs, plans, prompts), the three Result Evaluation checks alone do not close the job. Before accepting, the host agent MUST inspect the actual artifacts directly — git diff and changed files, retrieved alongside the carrier_jobs response — and judge them against the dispatch intent and the Mission Objective, never against the carrier's narrative alone:
1. Scope — only surfaces within the carrier's declared ownership changed.
2. Intent — changes implement the host agent's settled decisions, not a plausible reinterpretation.
3. Side effects — no unrelated reverts, history rewrites, or drive-by edits.
Report one disposition line: ${"`"}inspection: pass${"`"} | ${"`"}inspection: fixed — <n> deviations corrected by the host agent${"`"} | ${"`"}inspection: rejected — re-dispatched with findings${"`"}. The host agent corrects small deviations directly during integration; systematic deviations route back to the owning carrier. Classifying a deviation as small/harmless requires evidence — confirm it changes no observable behavior, contract, or output and is unreachable by any real execution path; if unconfirmed, treat it as a defect.
Proportionality: full-diff reading for doctrine/prompt/structural changes; stat + targeted sampling for large mechanical changes. Read-only jobs skip this gate — their claims route through Deep Dive instead.

### Multi-agent Filesystem Safety
Multiple agents may share one branch and filesystem. Re-read files before modifying them or accepting Carrier-proposed modifications, prefer precise edits over full-file writes, and never overwrite or revert changes made by others. If ownership is unclear or concurrent edits conflict, stop and escalate.

### Cross-Carrier Feedback
When multiple Carriers contribute to one task: route actionable review findings back to the implementing carrier with explicit fix instructions, re-run the same review on changed code only — never the entire codebase — and perform post-verification documentation on the host directly, only after implementation and verification are complete. Multi-carrier pattern selection lives in ${"`"}protocol-frontline${"`"}.

### Retry Policy
On carrier failure (timeout, connection, or runtime error): retry once with the same Carrier and request; on a second failure, report the error details to the user — never retry further or silently substitute another Carrier. Always preserve and report partial output received before a failure.`;

const RESULT_INTEGRITY_GATEWAY = String.raw`## Result Integrity Standing Order

A cross-cutting procedure governing how the host agent evaluates Workflow results and artifacts, handles cross-agent feedback loops, and retries failed operations.

### Trigger Mapping
| Trigger | Route |
|---|---|
| Result received | Run the Result Integrity relevance, completeness, and conflict checks. |
| Mutating Workflow stage finalized | Run the Artifact Inspection Gate. |
| Speculation found | Invoke Deep Dive. |
| Contradiction with verified fact | Re-evaluate Context Confidence. |

### Result Evaluation
After receiving any Workflow agent result, verify before reporting to the user:
1. **Relevance check** — Does the result address the original request? Flag partial or off-topic responses.
2. **Completeness check** — Are all requested deliverables present (e.g., all files listed, all sections filled)?
3. **Conflict check** — Does the result contradict prior Workflow outputs or known project state?

If any check fails, request clarification from the same Workflow agent stage with specific feedback before accepting the result.

### Artifact Inspection Gate
For any Workflow stage that mutates the workspace (code, docs, plans, prompts), the three Result Evaluation checks alone do not close the stage. Before accepting, the host agent MUST inspect the actual artifacts directly — git diff and changed files produced by that Workflow stage — and judge them against the stage intent and the Mission Objective, never against the agent's narrative alone:
1. Scope — only surfaces within the stage's declared ownership changed.
2. Intent — changes implement the host agent's settled decisions, not a plausible reinterpretation.
3. Side effects — no unrelated reverts, history rewrites, or drive-by edits.
Report one disposition line: ${"`"}inspection: pass${"`"} | ${"`"}inspection: fixed — <n> deviations corrected by the host agent${"`"} | ${"`"}inspection: rejected — re-dispatched with findings${"`"}. The host agent corrects small deviations directly during integration; systematic deviations route back through Workflow orchestration to the owning agent stage. Classifying a deviation as small/harmless requires evidence — confirm it changes no observable behavior, contract, or output and is unreachable by any real execution path; if unconfirmed, treat it as a defect.
Proportionality: full-diff reading for doctrine/prompt/structural changes; stat + targeted sampling for large mechanical changes. Read-only stages skip this gate — their claims route through Deep Dive instead.

### Multi-agent Filesystem Safety
Multiple agents may share one branch and filesystem. Re-read files before modifying them or accepting agent-proposed modifications, prefer precise edits over full-file writes, and never overwrite or revert changes made by others. If ownership is unclear or concurrent edits conflict, stop and escalate.

### Cross-Agent Feedback
When multiple Workflow agent stages contribute to one task: route actionable review findings back to the implementing stage with explicit fix instructions, re-run the same review on changed code only — never the entire codebase — and perform post-verification documentation on the host directly, only after implementation and verification are complete. Multi-stream Workflow coordination pattern selection lives in ${"`"}protocol-frontline${"`"}.

### Retry Policy
On Workflow agent failure (timeout, connection, or runtime error): retry once with the same agent role and request; on a second failure, report the error details to the user — never retry further or silently substitute another agent. Always preserve and report partial output received before a failure.`;

export const RESULT_INTEGRITY: StandingOrder = {
  id: "result-integrity",
  name: "Result Integrity",
  prompt: RESULT_INTEGRITY_CLASSIC,
};

export const RESULT_INTEGRITY_FOR_GATEWAY: StandingOrder = {
  id: "result-integrity",
  name: "Result Integrity",
  prompt: RESULT_INTEGRITY_GATEWAY,
};
