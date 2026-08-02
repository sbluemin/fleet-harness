---
name: implementation-run
description: Apply one decided change across many files, packages, or call sites by discovering the sites, transforming each in isolation, and inspecting the artifacts rather than the reports. Load before a migration, a sweeping refactor, or a multi-package edit. Skip when the change fits in a few files you will edit directly, or when the approach is not yet decided.
---

# Implementation Run

The only stage shape here that **writes**. Its risk is not failure — a failed edit is visible — but convergence: many branches each producing something reasonable that together do not match the codebase.

Executing this skeleton — the surface it runs on, the wiring between stages, and model and effort assignment — belongs to `workflow`; this skill owns the shape of the run.

## When Not To Use

- The approach is undecided. Decide first with `architecture-review`; a stage handed an open decision will close it for you, differently in each branch.
- A handful of files you can edit directly. The per-stage overhead exceeds the work.
- Judging existing code. Use `quality-review`.

## Stage Skeleton

| Stage | Role | Fan | Returns |
|---|---|---|---|
| Discover | map | 1-3 | Every site that must change, each with a path and why it qualifies |
| **Decide** | — | **host only** | The literal values every site will use. Decided here, never in a stage. |
| Apply | implement | one per site or coherent group, `isolation: 'worktree'` | Files changed, and which existing conventions were matched |
| Inspect | verify | host reads the diff | Accept or reject per site |

Discover and Apply pipeline naturally, but **Decide is a barrier by necessity** — the literals must exist before any site is touched, or each branch invents its own.

## Decisions Travel as Literals

Before starting any branch, close every judgment gap. Ask both:

1. Must the stage choose a concrete value?
2. Does it lack the doctrine or convention context to justify that choice?

If both are yes, **the host chooses the value and passes it verbatim**. This covers design tokens, API paths, setting keys, protocol tokens, names, error message text, thresholds, and constants — not an exhaustive list.

Never leave a choice to a stage behind phrases like "match the existing style", "pick a consistent name", "follow the convention", or "적절히". A stage on another model has no feel for this repository and will produce something defensible but foreign.

## Rules

- **Isolate every writing branch.** Parallel edits to a shared tree corrupt each other. Worktree isolation costs setup time and disk; pay it whenever more than one branch writes.
- **Inspect artifacts, never narratives.** Read the actual diff for each site. A stage's summary of what it did is evidence of what it believed, not of what it wrote.
- **Verbatim match or defect.** A literal you sent must appear exactly. An equivalent-looking substitution — a synonym token, a reformatted path, a renamed key — is a defect, not a variation.
- **A site that needs a new decision stops.** When Apply discovers a case Decide did not cover, it returns that fact instead of choosing. Resolve it on the host and start that branch again with the value; do not let one branch set precedent for the rest.
- **Reject rather than patch.** A branch whose output drifted is re-run with a sharper prompt. Fixing its output by hand hides that the prompt was insufficient, and the next site will drift the same way.

## Scope Warning

Measurement covered only **local, well-precedented edits** — a couple of files with an obvious existing pattern to follow. Every model tested handled those correctly. Nothing establishes that this holds for sweeping or cross-package work, where convention drift compounds and each branch sees only its own slice. Treat wide runs as unproven: keep groups small, inspect every diff, and keep a structural change on the host rather than spreading it across branches that each see one slice.

## Stopping

Stop when every discovered site is either accepted or explicitly deferred with a reason. Do not accept a run with unexamined sites because the count is large — an unexamined site is an unknown edit.

## Gotchas

- **Symptom:** Tests pass and the build is green, but the change reads as foreign to the surrounding code.
  **Action:** Diff the produced values against the literals you sent. Re-run the drifted sites with the literal spelled out.
  **Why:** Green checks confirm the code runs, not that it belongs; convention is invisible to a compiler.

- **Symptom:** Different sites solved the same sub-problem differently.
  **Action:** That sub-problem belonged in Decide. Choose once on the host and re-run the affected sites with the value.
  **Why:** Each branch resolved an open decision independently, which is exactly what the Decide barrier exists to prevent.

- **Symptom:** A branch reports success but changed nothing.
  **Action:** Check the returned file list against the actual diff before accepting.
  **Why:** A branch that could not find its target may report the intent as done; only the artifact settles it.
