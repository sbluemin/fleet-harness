---
name: workflow-research
description: Answer a question about a codebase or an external subject by fanning out independent searches, reading sources directly, and separating what was verified from what was only claimed. Load before orchestrating reconnaissance across many files, subsystems, or external sources. Skip for a single lookup you can perform directly.
---

# Workflow — Research

Reconnaissance whose product is **evidence, not a summary**. The run's value comes from covering angles a single reader would miss and from being explicit about what it failed to establish.

Executing this skeleton — the surface it runs on, the wiring between stages, and model and effort assignment — belongs to `workflow`; this skill owns the shape of the run.

## When Not To Use

- A fact one grep or one file read settles. Fanning out costs more than the answer is worth.
- Work that will change files. Use `workflow-implementing`.
- Judging code that already exists against a standard. Use `workflow-review`.

## Stage Skeleton

| Stage | Role | Fan | Returns |
|---|---|---|---|
| Scope | decompose | 1 | 3-6 angles, each a distinct search strategy — not paraphrases of one query |
| Sweep | scan | one per angle | Located candidates with a path or URL and why each is relevant |
| Read | extract | one per surviving candidate | Claims, each with a verbatim quote and its exact source |
| Reconcile | synthesize | 1 | Merged findings, ranked, with contradictions kept visible |

Run Sweep and Read as a pipeline. A barrier between them buys nothing: each candidate can be read the moment its angle finds it. Insert a barrier only before Reconcile, which genuinely needs the whole set.

## Capability Classes

Scope and Reconcile are the judgment seats: the angles Scope names bound everything the run can find, and Reconcile decides which claims survive and which contradictions stay visible. Each is a single seat, so the highest reachable `capabilityClass` costs one call (`workflow`, judgment regime). Sweep and Read are the wide mechanical fans — distribute them by allowance, where a `light`-class identity earns its keep.

## Rules

- **Angles must differ in method, not wording.** By-name, by-caller, by-test, by-history, by-config are different angles. Three rephrasings of one query is one angle run three times.
- **A claim without a quote is a lead, not a finding.** Require the source and the literal text; report the count of leads that never became findings.
- **Deduplicate before reading, not after.** Deduplicate on a normalized identity (path, or host plus path for a URL) so the same source is not read once per angle.
- **Contradictions survive to the report.** When two sources disagree, say so and name both. Collapsing them into whichever sounds more confident destroys the run's most valuable output.
- **Name what you failed to reach.** Blocked networks, unreadable files, and truncated searches are results. A report that omits them reads as exhaustive when it is not.

## Stopping

Stop when a full sweep round adds no source you had not already read. Do not keep spawning searchers because the subject is large — spawn them because the last round found something new.

## Gotchas

- **Symptom:** The report is confident and short, and every finding traces to one or two sources.
  **Action:** Check whether the angles actually differed. Re-run with methods, not phrasings.
  **Why:** Similar queries return the same top results, so the fan-out produced redundancy that reads as corroboration.

- **Symptom:** A cited file path or symbol does not exist.
  **Action:** Treat the whole finding as unverified and re-read the source before keeping it.
  **Why:** A stage that could not reach a source may still produce a plausible path; requiring a verbatim quote is what makes this detectable.
