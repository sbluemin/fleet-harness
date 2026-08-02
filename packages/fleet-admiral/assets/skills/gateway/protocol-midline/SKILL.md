---
name: protocol-midline
description: Use the normal Fleet protocol mode for bounded operational work without downward-guard triggers.
---

# Fleet Protocol: Midline

Use this mode for ordinary bounded operational work.

At any point during the work, if a Downward Guard trigger appears, stop and re-classify.

## Checkpoints

Reconnaissance, Plan, Execution, Verification.

## Reporting Cadence

As you move through this protocol, report progress to the user in order — each step on its own line with its report token.

1. Brief how the Procedure will proceed — name (a) the Procedure steps that will run, (b) the target surfaces, and (c) the verification command. → report `brief: <…>`
2. State that execution is beginning and run the Procedure. → report `status: executing`

## General Quarters

Confirm each readiness check below before the Procedure. Work through them in order and report each as you confirm it, then proceed to focused reconnaissance. These checks prepare the work; they do not gate entry.

- [ ] **Common** — objective stated (Mission Anchor), mode-fit holds (Mode Gate), Standing Orders binding. → report `common: ready`
- [ ] **Target surfaces** — provisionally name the minimal modules or files reconnaissance will touch; confirm or revise in the brief after reconnaissance. → report `surfaces: <…>`
- [ ] **Verification** — provisionally pre-load the test, build, or check command that will prove the work done; confirm or revise in the brief after reconnaissance. → report `verify: <cmd>`
- [ ] **Orchestration** — declare whether a Workflow fan-out is needed. → report `workflow: <none|…>`

## Procedure

1. Focused reconnaissance: audit known facts, identify blocking and confirmatory gaps, and inspect the minimal relevant surfaces.
2. Host-authored planning boundary: `Apply the Context Confidence Standing Order — entry requires sufficient`. Resolve all blocking gaps before the host plans.
3. Host-authored inline plan: state objective, targets, execution steps, and done criteria.
4. Execution: implement the plan in narrow batches; when delegation is appropriate, use the Workflow tool as the canonical orchestration path.
5. Verification and review: run targeted checks, apply Deep Dive to speculative results, and fix actionable issues.
6. Documentation and final report: update directly affected docs only when behavior or operator guidance changed, then summarize changes and QA.
