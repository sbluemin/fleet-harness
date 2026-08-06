---
name: workflow-review
description: Review existing code or a change set by splitting the work into independent dimensions, hunting within each, then adversarially verifying every finding before it is reported. Load before a correctness, security, or quality pass over a diff or subsystem. Skip when you already know the defect and only need it fixed.
---

# Workflow — Review

The output is a **judged finding list, not a fix list**. A reviewer that also repairs what it finds loses the independence that made the finding worth having, and repairs things that were never broken.

Executing this skeleton — the surface it runs on, the wiring between stages, and model and effort assignment — belongs to `workflow`; this skill owns the shape of the run.

## When Not To Use

- The defect is known and only the repair remains. Use `workflow-implementing`.
- Deciding between designs. Use `workflow-architecting`.
- Establishing facts with no standard to judge against. Use `workflow-research`.

## Stage Skeleton

| Stage | Role | Fan | Returns |
|---|---|---|---|
| Split | decompose | 1 | The dimensions this review will cover, each with its own standard |
| Hunt | scan | one per dimension | Candidate findings, each with a file, a line, and a concrete failing scenario |
| Verify | verify | 2-3 per finding, mixed lineage, prompted to refute | Refuted or survived, with the specific evidence |
| Adjudicate | — | **host only** | Confirmed / declined / deferred, with the reason |

Pipeline Hunt into Verify — a dimension's findings can be verified while another dimension is still hunting. Nothing here needs a global barrier.

## Capability Classes

Split is the one fanned judgment seat — the dimensions it names bound everything the run can find — and it is a single call: give it the highest reachable `capabilityClass` (`workflow`, judgment regime). Hunt and Verify are mechanical: a finding is checked against code and a verification refutes a concrete scenario, and the role measurement separated no models on adversarial judgment — so those seats buy quality with distribution and lineage mixing, not class. Adjudicate stays on the host, where the only judgment that outranks a verifier's verdict lives.

## Dimensions Stay Separate

Never combine security auditing with functional or end-to-end review in one hunt. Measured outcome: the combined run drops the functional pass — security findings are more legible, so the agent spends its budget there and reports the run as complete. Give each dimension its own hunter with its own standard.

Typical dimensions, chosen per target rather than run wholesale: correctness, security and input trust, boundary and ownership rules, error and failure handling, test coverage, and convention conformance.

## Verify Is Adversarial

Verifiers are prompted to **refute**, not to confirm. A finding survives only when the refutation attempt fails.

- Default to refuted when uncertain. An unreproduced finding is a hypothesis.
- Require a concrete failing scenario: inputs or state, and the wrong result. "This could break" is not a finding.
- Distinguish three outcomes. Survived, refuted on merit, and **unverifiable because the verifier errored** are different; collapsing the third into "refuted" silently discards real findings when infrastructure fails.
- Mix lineage across a finding's verifiers. Identical models produce correlated verdicts, which reads as agreement.

## Adjudication Stays on the Host

A surviving finding is evidence, not an instruction. For each one the host decides:

- **Confirm** when it occurs on a path a real workflow reaches, is in scope, and the repair costs less than the defect.
- **Decline** when it is hypothetical, overfit to the reviewer's reading, outside scope, or contradicts an intended trade-off. Record the reason; a silent skip is indistinguishable from an oversight.
- **Defer** when it is real but belongs to different work. Say why it is real and why not here.

Severity never decides disposition. A reviewer's P1 on a path nothing reaches is still a decline.

## Stopping

Stop when a hunting round produces no finding that survives verification. Two consecutive dry rounds end the run. A reviewer can always generate another suggestion, so waiting for it to fall silent is an unbounded loop.

## Gotchas

- **Symptom:** The run reports many findings and all of them survived.
  **Action:** Check that verifiers were prompted to refute rather than to assess. A confirming verifier confirms.
  **Why:** Adversarial framing is the entire mechanism; without it the verify stage is a second opinion that agrees by default.

- **Symptom:** Fixing one finding produced the next round's findings.
  **Action:** Roll back the fix rather than widening it. That is evidence the repair was over-scoped.
  **Why:** A repair that breeds findings changed more than the defect required.

- **Symptom:** The security dimension is thorough and the functional one is a sentence.
  **Action:** Re-run the functional dimension on its own hunter.
  **Why:** Combined dimensions do not split budget evenly; the more legible one absorbs it.
