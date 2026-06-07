---
name: fleet-protocol-standard
description: Use the normal Fleet protocol mode for bounded operational work without downward-guard triggers.
---

# Fleet Protocol: Standard

Use this mode for ordinary bounded operational work that does not involve irreversible operations, structural/API changes, multi-module edits, doctrine or prompt-policy edits, or required multi-carrier coordination. If any downward-guard trigger appears, self-escalate before planning.

The always-on Standing Orders remain binding: Mission Anchor, Context Confidence, Carrier Operations Policy, Deep Dive, and Result Integrity.

## Reporting Cadence

As you move through this protocol, report progress to the Admiral of the Navy in order — each step on its own line with its report token. Do not merge steps together or fold them into the General Quarters checks below.

1. State that you are drawing up the plan for this work. → report `plan: drafting`
2. State that you are running the readiness checks below. → report `checks: running`
3. Confirm the readiness checks are complete. → report `checks: complete`
4. Brief how the Workflow will proceed — name (a) the Workflow steps that will run, (b) the target surfaces, and (c) the verification command. → report `brief: <…>`
5. Confirm all five steps were reported, then state that execution is beginning and run the Workflow. → report `executing`

Steps 2–3 wrap the General Quarters section: step 2 opens the readiness checks, they run in full, and step 3 closes them once every check has reported its token.

## General Quarters

Confirm each readiness check below before the Workflow. Work through them in order and report each as you confirm it, then proceed to focused reconnaissance. These checks prepare the work; they do not gate entry.

- [ ] **Common** — objective stated (Mission Anchor), mode-fit holds (Mode Gate), Standing Orders binding. → report `common: ready`
- [ ] **Target surfaces** — name the minimal modules or files reconnaissance will touch. → report `surfaces: <…>`
- [ ] **Verification** — pre-load the test, build, or check command that will prove the work done. → report `verify: <cmd>`
- [ ] **Carrier** — declare whether a carrier sortie is needed. → report `carrier: <none|…>`
- [ ] **Downward-guard** — affirm bounded single-owner scope; if a full boundary map, risk review, or parallel ownership emerges, re-classify under high-risk or multi-agent. → report `downward-guard: clear`

## Workflow

1. Focused reconnaissance: audit known facts, identify blocking and confirmatory gaps, and inspect the minimal relevant surfaces.
2. Planning boundary: `Apply the Context Confidence Standing Order — entry requires complete`. Resolve all blocking and confirmatory gaps before planning.
3. Inline plan: state objective, targets, execution steps, and done criteria.
4. Execution: implement the plan in narrow batches, using Carrier Operations Policy when delegation is appropriate.
5. Verification and review: run targeted checks, apply Deep Dive to speculative results, and fix actionable issues.
6. Documentation and final report: update directly affected docs only when behavior or operator guidance changed, then summarize changes and QA.
