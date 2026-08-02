---
name: protocol-frontline
description: Use the coordinated Fleet protocol mode for multi-stream Workflow coordination or parallel ownership work.
---

# Fleet Protocol: Frontline

Use this mode when operational work requires multi-stream Workflow coordination, independent parallel workstreams, cross-stream review loops, or file ownership coordination. If the work is high risk but single-owner, use `protocol-redline` instead.

## Checkpoints

Decomposition, Dispatch, Integration, Verification.

## Reporting Cadence

As you move through this protocol, report progress to the user in order — each step on its own line with its report token.

1. Brief how the Procedure will proceed — name (a) the Procedure steps that will run, (b) each stream's file or responsibility ownership, and (c) the Workflow wave sequencing. → report `brief: <…>`
2. State that execution is beginning and run the Procedure. → report `status: executing`

## General Quarters

Confirm each readiness check below before the Procedure. Work through them in order and report each as you confirm it, then proceed to reconnaissance and decomposition. These checks prepare the work; they do not gate entry.

- [ ] **Common** — objective stated (Mission Anchor), mode-fit holds (Mode Gate), Standing Orders binding. → report `common: ready`
- [ ] **Impact radius** — flag public-surface or API impact, irreversibility, and any security-sensitive surface. → report `impact: <…>`
- [ ] **Rollback** — identify a rollback-safe checkpoint and any user approval point before execution begins. → report `rollback: <…>`
- [ ] **Role availability** — confirm the intended Carrier roles are actually exposed and available this session. → report `roles: <…>`
- [ ] **Ownership** — pre-sketch each stream's file or responsibility boundary. → report `ownership: <…>`
- [ ] **Shared resources** — flag shared mutable resources (same files, lock files, or a singleton test environment). → report `shared: <…|none>`
- [ ] **Dependencies** — pre-classify parallel versus sequential work before decomposition and Workflow fan-out. → report `dependencies: <parallel|sequenced: …>`

## Procedure

1. Reconnaissance and decomposition: audit known facts, identify gaps, map affected surfaces, and split work into independently verifiable missions.
2. Ownership graph: assign each stream a clear file or responsibility boundary, note dependencies, and identify shared mutable resources.
3. Host-authored structured planning boundary: `Apply the Context Confidence Standing Order — entry requires complete`. Resolve all blocking and confirmatory gaps before the host authors the Workflow plan.
4. Parallel Workflow fan-out: use the Workflow tool as the canonical multi-stream orchestration path; sequence only for explicit dependencies or shared resources. Do not treat `carrier_dispatch` as the canonical fan-out path.
5. Integration: re-read files before editing or accepting stream output, reconcile overlaps, and preserve unrelated user or stream changes.
6. Multi-stream review loop: route implementation outputs through Workflow review stages/agents, send actionable findings back to owning stages, and re-review changed surfaces.
7. Verification: run integrated tests and apply Deep Dive to speculative or conflicting stream claims via Workflow agent stages.
8. Documentation and completion report: update directly affected docs and report executed waves, stream ownership, QA, unresolved risks, and final Result Integrity checks.

## Multi-Stream Workflow Feedback Patterns

When composing Workflow waves and review loops, select the structured feedback pattern that fits the task:

| Pattern | Flow | When |
|---------|------|------|
| **Build → Review** | implementation stage/agent → review stage/agent → findings back to implementation → re-review | Standard implementation cycle |
| **Analyze → Execute** | implementation or refactoring stage/agent → review stage/agent verifies | Refactoring workflow |
| **Decide → Host Planning → Execute** | optional judgment stage/agent → host-authored plan → execution stage/agent | Complex features |
| **Research → Act** | reconnaissance stage/agent → appropriate follow-up stage/agent from the active roster | Unknown scope tasks |
