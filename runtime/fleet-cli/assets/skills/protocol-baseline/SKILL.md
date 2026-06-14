---
name: protocol-baseline
description: Use the compact Fleet protocol mode for simple, reversible, single-surface work.
---

# Fleet Protocol: Baseline

Use this mode only for simple, reversible, single-surface operational work.

At any point during the work, if a Downward Guard trigger appears, stop and re-classify.

## Checkpoints

None. Selecting baseline implies Mission Anchor Compact Mode.

## Reporting Cadence

As you move through this protocol, report progress to the Admiral of the Navy in order.

1. Brief in one line how the Workflow will proceed. → report `brief: <…>`
2. State that execution is beginning and run the Workflow. → report `status: executing`

## General Quarters

Confirm each readiness check below before the Workflow. Work through them in order and report each as you confirm it, then proceed to the Objective anchor. These checks prepare the work; they do not gate entry.

- [ ] **Common** — objective stated (Mission Anchor), mode-fit holds (Mode Gate), Standing Orders binding. → report `common: ready`
- [ ] **Single surface** — the exact file, command, or fact is identified. → report `surface: <x>`
- [ ] **Reversibility** — the change is trivially reversible. → report `reversible: yes`

## Workflow

1. Objective statement: state the Mission Anchor objective in one line.
2. Exact fact/file verification: verify the exact file, command, or fact needed for the request.
3. Execution: make the smallest reversible change or run the exact requested command.
4. Result verification: check the touched surface or command result.
5. One-line report: report what changed, verification, and any skipped escalation trigger.
