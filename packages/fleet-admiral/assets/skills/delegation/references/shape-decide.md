# Shape — deciding between approaches

A decision procedure, not a survey. The run must end with **one committed approach and a stated cost**, because an even-handed list of options leaves the judgment undone. The final choice stays on the host — the delegation skill's propose-branch rule — and this shape is how the material for that choice gets built. `references/seat-assignment.md` owns the seats; `references/surfaces-and-flight.md` owns the surface and wiring.

## When not to use

- The approach is settled and only the work remains — that is implementation, normally the host's own work.
- Judging code that exists against a standard — see `references/shape-review.md`.
- Gathering facts with no decision attached — see `references/shape-research.md`.

## Skeleton

| Stage | Role | Fan | Returns |
|---|---|---|---|
| Ground | map | 1–3 | The constraints that actually bind: ownership boundaries, existing precedents, invariants the codebase already enforces |
| Propose | propose | 3–5, independent | One committed approach each: mechanism, where each piece lives and why, the cost it accepts, the way it most likely fails |
| Judge | judge | one per approach, mixed lineage | A score per axis with the reason, not a verdict alone |
| Commit | synthesize | 1 | The chosen approach, runner-up ideas grafted onto it, and what the choice gives up |

Propose runs blind: each proposer sees the constraints, never the other proposals. Sharing them collapses the panel into one opinion with variations. Propose is the ceiling of the whole run — Judge only selects among what was proposed, and Commit only grafts what exists — so Propose, Judge, and Commit are all judgment seats; Ground is mechanical.

## Fixed judging axes

Score every approach on the same axes, decided before the proposals arrive:

- **Boundary fit** — does each piece live where that layer's ownership rule says it belongs?
- **Reversibility** — how expensive is undoing this once it ships?
- **Blast radius** — how many surfaces must change together?
- **Failure mode** — when it breaks, is the breakage loud or silent?
- **Carrying cost** — what must be maintained forever, including things that must stay in step manually?

Do not add an axis after seeing the proposals. An axis invented mid-run is usually a rationalization for a favorite.

## Rules

- **Ground first, and cite it.** A proposer that has not been told the binding constraints will invent a clean design that violates one. The constraints go into every proposer's prompt verbatim.
- **Mixed lineage in Judge.** Judges that share a lineage with each other, or with the session model, share blind spots — and diversity works within the band the judgment regime sets, never below it.
- **A proposal that hedges is disqualified.** "Either A or B depending on…" is a proposer refusing to decide. Send it back or drop it; do not let the synthesis inherit the hedge.
- **Name the cost, not just the choice.** A committed approach with no stated cost was not judged, only preferred.
- **Silent-failure modes lose.** Between approaches of similar merit, prefer the one whose breakage raises an error over the one that degrades quietly.

## Stopping

Stop after one judging pass unless the scores are genuinely tied on the deciding axis. A second round of proposals is warranted only when every approach failed the same constraint — which means Ground was incomplete, not that more proposals are needed.

## Gotchas

- **Symptom:** All proposals look alike.
  **Action:** Check whether the proposers saw each other's output, or whether Ground over-specified the solution instead of the constraints.
  **Why:** Independence is the only thing a panel buys; a leaked proposal or a leading prompt spends the cost without the benefit.

- **Symptom:** The synthesis reads as a compromise between approaches.
  **Action:** Re-commit to one and graft specific ideas from the others, naming each graft.
  **Why:** Merged architectures inherit every approach's cost and none of their coherence.
