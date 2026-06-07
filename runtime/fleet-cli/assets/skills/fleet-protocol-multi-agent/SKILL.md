---
name: fleet-protocol-multi-agent
description: Use the coordinated Fleet protocol mode for multi-carrier or parallel ownership work.
---

# Fleet Protocol: Multi-Agent

Use this mode when operational work requires multiple Carriers, independent parallel workstreams, cross-carrier review loops, or file ownership coordination. If the work is high risk but single-owner, use `fleet-protocol-high-risk` instead.

The always-on Standing Orders remain binding: Mission Anchor, Context Confidence, Carrier Operations Policy, Deep Dive, and Result Integrity.

## Reporting Cadence

As you move through this protocol, report progress to the Admiral of the Navy in order — each step on its own line with its report token. Do not merge steps together or fold them into the General Quarters checks below.

1. State that you are drawing up the plan for this work. → report `plan: drafting`
2. State that you are running the readiness checks below. → report `checks: running`
3. Confirm the readiness checks are complete. → report `checks: complete`
4. Brief how the Workflow will proceed — name (a) the Workflow steps that will run, (b) each carrier's file or responsibility ownership, and (c) the dispatch wave sequencing. → report `brief: <…>`
5. Confirm all five steps were reported, then state that execution is beginning and run the Workflow. → report `executing`

Steps 2–3 wrap the General Quarters section: step 2 opens the readiness checks, they run in full, and step 3 closes them once every check has reported its token.

## General Quarters

Confirm each readiness check below before the Workflow. Work through them in order and report each as you confirm it, then proceed to reconnaissance and decomposition. These checks prepare the work; they do not gate entry.

- [ ] **Common** — objective stated (Mission Anchor), mode-fit holds (Mode Gate), Standing Orders binding. → report `common: ready`
- [ ] **Impact & isolation** — carry the high-risk checks (public-surface impact, rollback checkpoint, branch or worktree isolation) wherever the work is also high risk. → report `impact/isolation: <…>`
- [ ] **Carrier availability** — confirm the intended carriers are actually exposed and available this session. → report `carriers: <…>`
- [ ] **Ownership** — pre-sketch each carrier's file or responsibility boundary. → report `ownership: <…>`
- [ ] **Shared resources** — flag shared mutable resources (same files, lock files, or a singleton test environment). → report `shared: <…|none>`
- [ ] **Dependencies** — pre-classify parallel versus sequential work before decomposition and dispatch. → report `dependencies: <parallel|sequenced: …>`

## Workflow

1. Reconnaissance and decomposition: audit known facts, identify gaps, map affected surfaces, and split work into independently verifiable missions.
2. Ownership graph: assign each Carrier a clear file or responsibility boundary, note dependencies, and identify shared mutable resources.
3. Structured planning boundary: `Apply the Context Confidence Standing Order — entry requires complete`. Resolve all blocking and confirmatory gaps before dispatch planning.
4. Parallel dispatch: use Carrier Operations Policy to launch independent Carrier work in parallel; sequence only for explicit dependencies or shared resources.
5. Integration: re-read files before editing or accepting Carrier output, reconcile overlaps, and preserve unrelated user or Carrier changes.
6. Cross-carrier review loop: route implementation outputs to review Carriers, send actionable findings back to owners, and re-review changed surfaces.
7. Verification: run integrated tests and apply Deep Dive to speculative or conflicting Carrier claims.
8. Documentation and completion report: update directly affected docs and report executed waves, Carrier ownership, QA, unresolved risks, and final Result Integrity checks.
