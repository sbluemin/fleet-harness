---
name: plan-operations
description: Host-owned Fleet Plan authoring and mutation workflow. Load before the first host plan_write call in a session and skip reloading when already in context. Use it for the required Plan template, optional Nimitz Plan assurance, Genesis Plan-driven handoff, host completion marking after artifact inspection, and Plan-state verification boundaries.
---

# Plan Operations

This skill owns Fleet Plan mechanics. The host authors and mutates Plans directly; Nimitz may optionally provide read-only assurance for an already host-authored PlanRef when `plan_ref` is supplied. PlanRef, TaskRef, workspace binding, Markdown schema, and host-owned completion semantics remain unchanged.

## Session Load Gate

Load this skill once before the first host `plan_write` call in a session. Skip reloading when this content is already in context and apply it to lint corrections, audit-driven revisions, and later Plan replacements. If this skill cannot be loaded, do not call `plan_write`; report the blocked host Plan operation.

`plan_write`, `plan_verify`, and `plan_mark_tasks` are host-only. `plan_read` is available to the host and metadata-authorized Carriers. No Carrier receives `plan_mark_tasks`.

## Host Authoring Flow

1. Resolve reconnaissance, product decisions, architecture decisions, scope, ownership, dependencies, and acceptance criteria on the host.
2. Choose a stable lowercase `plan_id`; never use a filesystem path.
3. Ensure this skill is loaded for the session, then submit one complete Plan using the required template below.
4. If `plan_write` returns lint diagnostics, correct the complete Markdown on the host and replace the Plan through another `plan_write` call.
5. Read the returned PlanRef with `plan_read`. Treat `valid=false` as blocking and never dispatch an invalid Plan.
6. Optionally ask Nimitz to audit the existing host-authored PlanRef by supplying `plan_ref`. Nimitz may make strategic and architecture judgments, but never authors, mutates, decomposes, or applies changes to Plan state. The host adjudicates findings and applies accepted corrections through `plan_write`.
7. Dispatch Genesis with required `<objective>` and `<scope>` plus optional `<task_refs>` from exactly one Plan and one Lane. Genesis reads that complete TaskRef group once at dispatch start, executes only the returned selected_tasks and exact Lane write set, runs Lane QA, and returns unmarked TaskRefs with artifact evidence. Plan wording, topology, ownership, or task changes return to the host.
8. Independently inspect the actual artifacts, QA evidence, and Lane contract. Only after that pass, call `plan_mark_tasks` with exactly the original dispatched TaskRefs.
9. After execution results are integrated and completion is marked, use `plan_verify` only to prove Plan state. Artifact inspection, tests, acceptance checks, and review separately prove implementation correctness.

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

- Full-plan execution: unavailable; dispatch explicit same-Lane TaskRefs only
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

Existing Plans that use exactly `- Full-plan Ohio invocation: unavailable; dispatch explicit same-Lane TaskRefs only` remain valid as the sole legacy alternative. New Plans must use the carrier-neutral line above. Plans that contain both lines or any malformed variant are invalid.

## Optional Nimitz Plan Assurance

Nimitz Plan assurance is never required for Plan authoring or Genesis dispatch. Dispatch Nimitz only after the host has a PlanRef, using Nimitz's normal required blocks plus:

1. `<context>` required
2. `<problem>` required
3. `<plan_ref>` optional — sole audit trigger; its presence activates read-only Plan assurance
4. `<audit_focus>` optional — applies only when `plan_ref` is supplied
5. `<constraints>` optional
6. `<artifacts>` optional

`plan_ref` is the sole audit trigger. `audit_focus` without `plan_ref` never authorizes Plan lookup or an invented Plan. With `plan_ref`, Nimitz calls only `plan_read` for that exact PlanRef (plus `carrier_jobs` for prior job lookup), supplements its normal strategic output with `PASS | REVISE | BLOCKED`, identifies every finding by Plan section, Lane, or TaskRef, and proposes host-applied corrections. A clean audit explicitly reports no findings. Missing, unreadable, or mismatched Plan evidence is `BLOCKED`. Nimitz never calls `plan_write`, edits Plan state, writes artifacts, or applies corrections.

## Genesis Handoff and Host Completion

The host dispatches one same-Lane TaskRef group per Genesis Plan-driven request. Genesis executes only the selected TaskRefs and exact Lane write set, preserves the ordered Wave and gate semantics, runs Lane QA, and reports exact TaskRefs/Lane/QA without mutating Plan state. The host independently inspects artifacts and QA, then calls `plan_mark_tasks` with exactly the original dispatched TaskRefs. Plan wording, topology, ownership, or task changes return to the host.

`plan_verify` reports whether the Plan is lint-valid and all Plan tasks are marked complete. It does not verify source, documentation, configuration, generated assets, tests, security, acceptance criteria, or user-visible behavior.
