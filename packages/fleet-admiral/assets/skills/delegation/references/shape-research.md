# Shape — establishing facts

Reconnaissance whose product is evidence, not a summary. The run's value comes from covering angles a single reader would miss and from being explicit about what it failed to establish. The delegation skill owns whether to fan out at all; `references/seat-assignment.md` owns which identities fill the seats; `references/surfaces-and-flight.md` owns the surface and wiring.

## When not to use

- A fact one grep or one file read settles — fanning out costs more than the answer is worth.
- Work that changes files — see `references/shape-implementation.md`.
- Judging what exists against a standard — see `references/shape-review.md`.

## Skeleton

| Stage | Role | Fan | Returns |
|---|---|---|---|
| Scope | decompose | 1 | 3–6 angles, each a distinct search strategy — not paraphrases of one query |
| Sweep | scan | one per angle | Located candidates, each with a path or URL and why it is relevant |
| Read | extract | one per surviving candidate | Claims, each with a verbatim quote and its exact source |
| Reconcile | synthesize | 1 | Merged findings, ranked, contradictions kept visible |

Scope and Reconcile are the judgment seats — the angles Scope names bound everything the run can find, and Reconcile decides which claims survive. Sweep and Read are the wide mechanical fans. Run Sweep into Read as a pipeline: each candidate can be read the moment its angle finds it, and the one justified barrier sits before Reconcile, which genuinely needs the whole set.

## Rules

- **Angles must differ in method, not wording.** By-name, by-caller, by-test, by-history, by-config are different angles; three rephrasings of one query is one angle run three times.
- **A claim without a quote is a lead, not a finding.** Require the source and the literal text, and report the count of leads that never became findings.
- **Deduplicate before reading, not after.** Deduplicate on a normalized identity — path, or host plus path for a URL — so one source is not read once per angle.
- **Contradictions survive to the report.** When two sources disagree, say so and name both; collapsing them into whichever sounds more confident destroys the run's most valuable output.
- **Name what you failed to reach.** Blocked networks, unreadable files, and truncated searches are results; a report that omits them reads as exhaustive when it is not.

## Stopping

Stop when a full sweep round adds no source you had not already read. Spawn another searcher because the last round found something new, never because the subject is large.

## Gotchas

- **Symptom:** The report is confident and short, and every finding traces to one or two sources.
  **Action:** Check whether the angles actually differed; re-run with methods, not phrasings.
  **Why:** Similar queries return the same top results, so the fan produced redundancy that reads as corroboration.

- **Symptom:** A cited file path or symbol does not exist.
  **Action:** Treat the whole finding as unverified and re-read the source before keeping it.
  **Why:** A branch that could not reach a source can still produce a plausible path; the verbatim-quote rule is what makes this detectable.
