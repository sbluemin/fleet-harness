---
name: fleet-protocol-high-risk
description: Use the risk-controlled Fleet protocol mode for irreversible, structural, multi-module, or prompt-policy work.
---

# Fleet Protocol: High Risk

Use this mode for irreversible operations, structural/API changes, cross-module edits, doctrine or prompt-policy edits, security-sensitive work, or any operational request needing explicit risk controls. Escalate to `fleet-protocol-multi-agent` when multiple Carriers or parallel ownership boundaries are required.

The always-on Standing Orders remain binding: Mission Anchor, Context Confidence, Carrier Operations Policy, Deep Dive, and Result Integrity.

## Reporting Cadence

As you move through this protocol, report progress to the Admiral of the Navy in order — each step on its own line with its report token. Do not merge steps together or fold them into the General Quarters checks below.

1. State that you are drawing up the plan for this work. → report `plan: drafting`
2. State that you are running the readiness checks below. → report `checks: running`
3. Confirm the readiness checks are complete. → report `checks: complete`
4. Brief how the Workflow will proceed — name (a) the Workflow steps that will run, (b) file ownership and the rollback-safe checkpoint, and (c) the risk controls in force. → report `brief: <…>`
5. Confirm all five steps were reported, then state that execution is beginning and run the Workflow. → report `executing`

Steps 2–3 wrap the General Quarters section: step 2 opens the readiness checks, they run in full, and step 3 closes them once every check has reported its token.

## General Quarters

Confirm each readiness check below before the Workflow. Work through them in order and report each as you confirm it, then proceed to full reconnaissance. These checks prepare the work; they do not gate entry.

- [ ] **Common** — objective stated (Mission Anchor), mode-fit holds (Mode Gate), Standing Orders binding. → report `common: ready`
- [ ] **Doctrine** — enumerate the applicable AGENTS.md files to load for the affected scope. → report `doctrine: <…>`
- [ ] **Impact radius** — flag public-surface or API impact, irreversibility, and any security-sensitive surface. → report `impact: <…>`
- [ ] **Rollback** — identify a rollback-safe checkpoint and any Admiral approval point before execution begins. → report `rollback: <…>`
- [ ] **Isolation** — confirm a working branch or worktree isolates the change; no direct work on the default branch. → report `isolation: <branch>`
- [ ] **Escalation** — if multiple carriers or parallel ownership boundaries are required, re-classify under multi-agent. → report `escalation: clear`

## Workflow

1. Full reconnaissance: audit known facts, enumerate blocking and confirmatory gaps, read applicable AGENTS.md files, map affected code, tests, docs, and boundaries.
2. Architecture and risk review: identify public-surface impact, dependency constraints, rollback risk, security risk, and approval needs.
3. Structured planning boundary: `Apply the Context Confidence Standing Order — entry requires complete`. Do not plan with unresolved blocking or confirmatory gaps.
4. Risk-controlled plan: define file ownership, small execution batches, verification commands, rollback-safe checkpoints, and any approval point.
5. Small-batch execution: edit narrowly, re-read before modifying shared files, and pause on unexpected diffs or scope expansion.
6. Refactor gate: refactor only touched code when duplication, complexity, or convention drift appears.
7. Parallel correctness and security review: review changed behavior and risk controls; apply Deep Dive to speculative findings and repeat after fixes.
8. Documentation and completion report: update directly affected operator docs and report changes, QA, risk controls, and residual uncertainty.
