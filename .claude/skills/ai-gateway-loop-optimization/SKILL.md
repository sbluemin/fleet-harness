---
name: ai-gateway-loop-optimization
description: Optimize AI Gateway provider-loop latency, retries, tool amplification, or cache cost using before/after evidence from the same live workload. Not for general API features or UI-only diagnosis.
---

# AI Gateway Loop Optimization

Use **observe → one optimization → controlled remeasurement → falsification**. Deliver more than a patch: reproducible evidence of which layer changed and whether the caller contract survived.

## Inputs and experiment contract

Choose the exact provider/model and effort, a short workload (usually 3–5 logical operations), a symptom hypothesis, and trial count. Default to **5 successful trials** before and after. Report changed sample sizes and excluded fixture failures.

Read [Execution surface](references/execution.md) and use the smallest suitable path. For router/provider-loop behavior alone, use the standalone runner or built adapter without Console. Use a real Operation through `console-e2e` and its live-agent reference only when caller transcripts, auxiliary turns, or host lifecycle matter.

The live runner's confirmation flag consents to real quota use. Never add live calls to default test/CI paths. Raw wire contains sensitive prompt/tool payloads; collect it in scratchpad only with explicit authorization. Never record credentials.

## Execution decisions

1. Before baseline, read [Measurement](references/measurement.md). Freeze literal model/effort, prompt, tool catalog/permissions, model-visible cwd/revision, turn-dispatch policy, logging, trial count, and success criteria. A changed condition or model mutation of the frozen tree invalidates that controlled comparison.
2. Observe only existing layers. Separate caller executions, provider requests/retries, replay history, and host auxiliary turns. Do not report nonexistent standalone transcripts/lifecycle as zero. Record counts with denominators.
3. Before editing, read [Optimization and verification](references/optimization.md). State candidates as `observed symptom → smallest change → expected delta → failure mode`; change **one thing per round**. Wire size alone does not prove waste. Preserve provider stateless/retry/permission/tool contracts.
4. Implement at the owning layer. Test positive and near-match negative cases, affected retry/cancellation/correlation behavior, and privacy boundaries. Repeat the baseline and challenge attribution with relevant failures, auxiliary turns, and repeated/concurrent cases. Use direct-adapter probes or focused tests for shapes the runner cannot express.
5. Run relevant package tests, typecheck, build, and `git diff --check`. Add dependent Console build/restart only for Console wiring or real Operation changes. Repair task-induced regressions and reverify under the same conditions.

## Completion

Finish when the target improves, caller calls/results/errors, permissions, and final result are preserved, and falsification checks pass. Also stop when evidence proves remaining cost belongs to a required upstream/host contract; report why it is not removable. Do not continue merely because a number is large.

Read [Reporting and gotchas](references/reporting.md) when interpreting results. Report before/after metrics, request ownership, frozen conditions, sample/exclusions, stable invariants, verification, and unknowns. Verify router/server cleanup for standalone runs; clean up only owned Console/agent processes for real Operations.
