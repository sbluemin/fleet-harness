---
name: fleet-protocol-trivial
description: Use the compact Fleet protocol mode for simple, reversible, single-surface work.
---

# Fleet Protocol: Trivial

Use this mode only for simple, reversible, single-surface operational work. If irreversible operations, structural/API changes, multi-module edits, doctrine or prompt-policy edits, or multi-carrier coordination appear, self-escalate to `fleet-protocol-high-risk` or `fleet-protocol-multi-agent` before planning.

The always-on Standing Orders remain binding: Mission Anchor, Context Confidence, Carrier Operations Policy, Deep Dive, and Result Integrity.

## Reporting Cadence

As you move through this protocol, report progress to the Admiral of the Navy in order, each step with its report token. For trivial work you may compress this into one or two lines, but all five steps must still appear — do not drop a step even when compressing.

1. State that you are drawing up the plan for this work. → report `plan: drafting`
2. State that you are running the readiness checks below. → report `checks: running`
3. Confirm the readiness checks are complete. → report `checks: complete`
4. Brief in one line how the Workflow will proceed. → report `brief: <…>`
5. Confirm all five steps were reported, then state that execution is beginning and run the Workflow. → report `executing`

Steps 2–3 wrap the General Quarters section: step 2 opens the readiness checks, they run in full, and step 3 closes them once every check has reported its token.

## General Quarters

Confirm each readiness check below before the Workflow. Work through them in order and report each as you confirm it, then proceed to the Objective anchor. These checks prepare the work; they do not gate entry.

- [ ] **Common** — objective stated (Mission Anchor), mode-fit holds (Mode Gate), Standing Orders binding. → report `common: ready`
- [ ] **Single surface** — the exact file, command, or fact is identified and the change is trivially reversible. → report `surface: <x> | reversible: yes`
- [ ] **Downward-guard** — no structural, API, doctrine, multi-module, or multi-carrier signal is present; if one appears, re-classify under a higher mode before anchoring. → report `downward-guard: clear`

## Workflow

1. Objective anchor: state the Mission Anchor objective once.
2. Minimal knowledge audit: verify the exact file, command, or fact needed for the request.
3. Planning micro-check: when a planning decision exists, state `Apply the Context Confidence Standing Order — entry requires complete` before choosing the direct action.
4. Direct execution: make the smallest reversible change or run the exact requested command.
5. Exact verification: check the touched surface or command result.
6. Compact final: report what changed, verification, and any skipped escalation trigger.
