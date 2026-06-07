---
name: fleet-protocol-high-risk
description: Use the risk-controlled Fleet protocol mode for irreversible, structural, multi-module, or prompt-policy work.
---

# Fleet Protocol: High Risk

Use this mode for irreversible operations, structural/API changes, cross-module edits, doctrine or prompt-policy edits, security-sensitive work, or any operational request needing explicit risk controls. Escalate to `fleet-protocol-multi-agent` when multiple Carriers or parallel ownership boundaries are required.

The always-on Standing Orders remain binding: Mission Anchor, Context Confidence, Carrier Operations Policy, Deep Dive, and Result Integrity.

## Workflow

1. Full reconnaissance: audit known facts, enumerate blocking and confirmatory gaps, read applicable AGENTS.md files, map affected code, tests, docs, and boundaries.
2. Architecture and risk review: identify public-surface impact, dependency constraints, rollback risk, security risk, and approval needs.
3. Structured planning boundary: `Apply the Context Confidence Standing Order — entry requires complete`. Do not plan with unresolved blocking or confirmatory gaps.
4. Risk-controlled plan: define file ownership, small execution batches, verification commands, rollback-safe checkpoints, and any approval point.
5. Small-batch execution: edit narrowly, re-read before modifying shared files, and pause on unexpected diffs or scope expansion.
6. Refactor gate: refactor only touched code when duplication, complexity, or convention drift appears.
7. Parallel correctness and security review: review changed behavior and risk controls; apply Deep Dive to speculative findings and repeat after fixes.
8. Documentation and completion report: update directly affected operator docs and report changes, QA, risk controls, and residual uncertainty.
