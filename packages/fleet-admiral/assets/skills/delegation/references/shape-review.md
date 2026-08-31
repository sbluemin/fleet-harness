# Shape — reviewing what exists

The output is a judged finding list, not a fix list. A reviewer that also repairs what it finds loses the independence that made the finding worth having, and repairs things that were never broken. The delegation skill owns whether to fan out at all; `references/seat-assignment.md` owns the seats; `references/surfaces-and-flight.md` owns the surface and wiring.

## When not to use

- The defect is known and only the repair remains — that is implementation, normally the host's own work.
- Deciding between designs — see `references/shape-decide.md`.
- Establishing facts with no standard to judge against — see `references/shape-research.md`.

## Skeleton

| Stage | Role | Fan | Returns |
|---|---|---|---|
| Split | decompose | 1 | The dimensions this review covers, each with its own standard |
| Hunt | scan | one per dimension | Candidate findings, each with a file, a line, and a concrete failing scenario |
| Verify | verify | 2–3 per finding, mixed lineage, prompted to refute | Refuted or survived, with the specific evidence |
| Adjudicate | — | **host only** | Confirmed / declined / deferred, with the reason |

Split is the one judgment seat — the dimensions it names bound everything the run can find — and it is a single call. Hunt and Verify are mechanical: a finding is checked against code, and measurement separated no models on adversarial judgment, so those seats buy quality with distribution and lineage mixing, not rank. Pipeline Hunt into Verify — a dimension's findings can be verified while another dimension is still hunting.

## Dimensions stay separate

Never combine security auditing with functional or end-to-end review in one hunt. Measured outcome: the combined run drops the functional pass — security findings are more legible, so the hunter spends its budget there and reports the run as complete. Typical dimensions, chosen per target rather than run wholesale: correctness, security and input trust, boundary and ownership rules, error and failure handling, test coverage, convention conformance.

## Verify is adversarial

Verifiers are prompted to **refute**, not to confirm; a finding survives only when the refutation attempt fails.

- Default to refuted when uncertain — an unreproduced finding is a hypothesis.
- Require a concrete failing scenario: inputs or state, and the wrong result. "This could break" is not a finding.
- Distinguish three outcomes. Survived, refuted on merit, and **unverifiable because the verifier errored** are different; collapsing the third into "refuted" silently discards real findings when infrastructure fails.
- Mix lineage across a finding's verifiers — identical models produce correlated verdicts, which reads as agreement.

## Adjudication stays on the host

A surviving finding is evidence, not an instruction. For each one the host decides:

- **Confirm** when it occurs on a path a real workflow reaches, is in scope, and the repair costs less than the defect.
- **Decline** when it is hypothetical, overfit to the reviewer's reading, outside scope, or contradicts an intended trade-off. Record the reason; a silent skip is indistinguishable from an oversight.
- **Defer** when it is real but belongs to different work. Say why it is real and why not here.

Severity never decides disposition. A reviewer's P1 on a path nothing reaches is still a decline.

## Stopping

Stop when a full hunting round produces no finding that survives verification — one dry round ends the run. A reviewer can always generate another suggestion, so waiting for it to fall silent is an unbounded loop.

## Gotchas

- **Symptom:** The run reports many findings and all of them survived.
  **Action:** Check that verifiers were prompted to refute rather than to assess.
  **Why:** Adversarial framing is the entire mechanism; without it the verify stage is a second opinion that agrees by default.

- **Symptom:** Fixing one finding produced the next round's findings.
  **Action:** Roll back the fix rather than widening it.
  **Why:** A repair that breeds findings changed more than the defect required.

- **Symptom:** The security dimension is thorough and the functional one is a sentence.
  **Action:** Re-run the functional dimension on its own hunter.
  **Why:** Combined dimensions do not split budget evenly; the more legible one absorbs it.
