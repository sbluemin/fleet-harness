---
name: protocol-frontline
description: Use the coordinated Fleet protocol mode for multi-carrier or parallel ownership work.
---

# Fleet Protocol: Frontline

Use this mode when operational work requires multiple Carriers, independent parallel workstreams, cross-carrier review loops, or file ownership coordination. If the work is high risk but single-owner, use `protocol-redline` instead.

## Checkpoints

Decomposition, Dispatch, Integration, Verification.

## Reporting Cadence

As you move through this protocol, report progress to the user in order — each step on its own line with its report token.

1. Brief how the Procedure will proceed — name (a) the Procedure steps that will run, (b) each carrier's file or responsibility ownership, and (c) the dispatch wave sequencing. → report `brief: <…>`
2. State that execution is beginning and run the Procedure. → report `status: executing`

## General Quarters

Confirm each readiness check below before the Procedure. Work through them in order and report each as you confirm it, then proceed to reconnaissance and decomposition. These checks prepare the work; they do not gate entry.

- [ ] **Common** — objective stated (Mission Anchor), mode-fit holds (Mode Gate), Standing Orders binding. → report `common: ready`
- [ ] **Impact radius** — flag public-surface or API impact, irreversibility, and any security-sensitive surface. → report `impact: <…>`
- [ ] **Rollback** — identify a rollback-safe checkpoint and any user approval point before execution begins. → report `rollback: <…>`
- [ ] **Carrier availability** — confirm the intended carriers are actually exposed and available this session. → report `carriers: <…>`
- [ ] **Ownership** — pre-sketch each carrier's file or responsibility boundary. → report `ownership: <…>`
- [ ] **Shared resources** — flag shared mutable resources (same files, lock files, or a singleton test environment). → report `shared: <…|none>`
- [ ] **Dependencies** — pre-classify parallel versus sequential work before decomposition and dispatch. → report `dependencies: <parallel|sequenced: …>`

## Procedure

1. Reconnaissance and decomposition: audit known facts, identify gaps, map affected surfaces, and split work into independently verifiable missions.
2. Ownership graph: assign each Carrier a clear file or responsibility boundary, note dependencies, and identify shared mutable resources.
3. Host-authored structured planning boundary: `Apply the Context Confidence Standing Order — entry requires complete`. Resolve all blocking and confirmatory gaps before the host authors the dispatch plan.
4. Parallel dispatch: use the `carrier-operations` skill's sequencing rules to launch independent Carrier work in parallel; sequence only for explicit dependencies or shared resources.
5. Integration: re-read files before editing or accepting Carrier output, reconcile overlaps, and preserve unrelated user or Carrier changes.
6. Cross-carrier review loop: route implementation outputs to review Carriers, send actionable findings back to owners, and re-review changed surfaces.
7. Verification: run integrated tests and apply Deep Dive to speculative or conflicting Carrier claims.
8. Documentation and completion report: update directly affected docs and report executed waves, Carrier ownership, QA, unresolved risks, and final Result Integrity checks.

## Cross-Carrier Feedback Patterns

When composing waves and review loops, select the structured feedback pattern that fits the task:

| Pattern | Flow | When |
|---------|------|------|
| **Build → Review** | implementation carrier → review carrier → findings back to implementation carrier → re-review | Standard implementation cycle |
| **Analyze → Execute** | implementation or refactoring carrier → review carrier verifies | Refactoring workflow |
| **Decide → Host Planning → Execute** | optional judgment carrier → host-authored plan → execution carrier | Complex features |
| **Research → Act** | reconnaissance carrier → appropriate follow-up carrier from the active roster | Unknown scope tasks |
