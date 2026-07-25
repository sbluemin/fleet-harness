---
name: plan-operations
description: Host-owned Fleet Plan authoring and mutation workflow. Load before the first host plan_write call in a session and skip reloading when already in context. Use it for the required Plan template, optional Kirov audit, Ohio handoff, and Plan-state verification boundaries.
---

# Plan Operations

This skill owns Fleet Plan mechanics. The host authors and mutates Plans directly; Kirov is optional read-only assurance for an already host-authored PlanRef. PlanRef, TaskRef, workspace binding, Markdown schema, and Ohio completion semantics remain unchanged.

## Session Load Gate

Load this skill once before the first host `plan_write` call in a session. Skip reloading when this content is already in context and apply it to lint corrections, audit-driven revisions, and later Plan replacements. If this skill cannot be loaded, do not call `plan_write`; report the blocked host Plan operation.

`plan_write` and `plan_verify` are host-only. `plan_read` is available to the host and metadata-authorized Carriers. `plan_mark_tasks` is Ohio-only and may only mark the assigned same-Lane TaskRefs after the Lane QA/integration gate passes.

## Host Authoring Flow

1. Resolve reconnaissance, product decisions, architecture decisions, scope, ownership, dependencies, and acceptance criteria on the host.
2. Choose a stable lowercase `plan_id`; never use a filesystem path.
3. Ensure this skill is loaded for the session, then submit one complete Plan using the required template below.
4. If `plan_write` returns lint diagnostics, correct the complete Markdown on the host and replace the Plan through another `plan_write` call.
5. Read the returned PlanRef with `plan_read`. Treat `valid=false` as blocking and never dispatch an invalid Plan.
6. Optionally ask Kirov to audit the existing host-authored PlanRef. Kirov never authors, mutates, or decides Plan content. The host adjudicates findings and applies accepted corrections through `plan_write`.
7. Dispatch Ohio with explicit TaskRefs from exactly one Plan and one Lane. Ohio reads that complete TaskRef group once at dispatch start and returns requested Plan changes or decisions to the host.
8. After execution results are integrated, use `plan_verify` only to prove Plan state. Artifact inspection, tests, acceptance checks, and review separately prove implementation correctness.

## Required Plan Template

Use the headings and order exactly as shown. Repeat Wave, Lane, File Ownership, and Dispatch Manifest entries as needed. Every Lane contains 3-7 contiguous `WN-X-TN` tasks. Use `Not applicable` for a non-applicable field rather than deleting it; extra sections are allowed only after the required sections.

```md
# Objective

<objective>

# File Ownership

- W1-A owns <exact write set>

# Execution Topology

- Execution mode: Sequential | Parallel
- Shared mutable resources: <resources or none>

# Waves

## Wave 1 — <name>

### Lane W1-A — <name>

- Exact write set:
  - <path or glob>
- Read dependencies:
  - <path, Plan input, or Not applicable>
- Dependency/start condition: <condition>
- Eligible concurrent lanes: <lane IDs or none>
- Integration gate: <gate>
- Handoff: <handoff>
- Rollback unit: <rollback-safe unit>
- Implementation summary:
  - [ ] W1-A-T1 — <step>
  - [ ] W1-A-T2 — <step>
  - [ ] W1-A-T3 — <step>
- Verification/static checks:
  - <command or check>
- Escalation triggers: <trigger or Not applicable>

# Dispatch Manifest

- Full-plan Ohio invocation: unavailable; dispatch explicit same-Lane TaskRefs only
- Lane W1-A — <exact write set, read dependencies, dependency/start condition, eligible concurrent lanes, integration gate, handoff, and rollback unit summary>

# QA Gates

- <global and per-Lane QA requirements>

# Acceptance Criteria

- <observable done criterion>

# Documentation Updates

- <directly affected documentation or Not applicable>

# Final Review Loop

- <host artifact inspection, tests, review, and correction loop>
```

For parallel execution, eligible concurrent Lane declarations must be reciprocal and exact write sets must not overlap. If safe disjoint ownership cannot be proven, use sequential execution.

## Optional Kirov Audit

Kirov is never required for Plan authoring or Ohio dispatch. Dispatch it only after the host has a PlanRef, using these blocks in this order:

1. `<plan_ref>` required
2. `<audit_focus>` optional
3. `<context>` optional
4. `<constraints>` optional

Kirov calls only `plan_read` (plus `carrier_jobs` for prior job lookup), returns `PASS | REVISE | BLOCKED`, identifies every finding by Plan section, Lane, or TaskRef, and proposes host-applied corrections. A clean audit explicitly reports no findings. Kirov never calls `plan_write`, edits Plan state, writes artifacts, or makes product or architecture decisions.

## Ohio Handoff and Completion

The host dispatches one same-Lane TaskRef group per Ohio request. Ohio executes only the selected TaskRefs and exact Lane write set, preserves the ordered Wave and gate semantics, and calls `plan_mark_tasks` only after every assigned task and the Lane QA/integration gate pass. Plan wording, topology, ownership, or task changes return to the host.

`plan_verify` reports whether the Plan is lint-valid and all Plan tasks are marked complete. It does not verify source, documentation, configuration, generated assets, tests, security, acceptance criteria, or user-visible behavior.
