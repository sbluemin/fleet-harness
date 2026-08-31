# Seat assignment — which identity, what effort, how wide

The delegation skill decides whether a dispatch leaves the host and that its identity is chosen deliberately; this file owns the choice itself when the roster exposes more than one model. Read the payload semantics in `references/loadout-reading.md` first — the two files split reading from choosing.

## Two regimes

Every seat's role belongs to one of two regimes, and the regime decides what fills it.

| Regime | Roles | The test | What fills a seat |
|---|---|---|---|
| **Judgment** | decompose, propose, judge, synthesize | the output is an opinion the run commits to, with no external answer key | the top quality band reachable — benchmark evidence first, the capability-class prior where unmeasured |
| **Mechanical** | map, scan, extract, transform, implement, verify | the output is checkable — against the codebase, the sent literals, or a concrete failing scenario | allowance, by the distribution rules below |

A judgment seat returns a committed opinion **as evidence** — a proposal, a scored verdict, a merged draft. No seat carries decision authority: the final choice, trade-off arbitration, and the user-facing synthesis stay on the host, as the delegation skill's own rules state, which is why deciding is not a delegable role at all.

`verify` is mechanical deliberately: refuting a concrete finding is closed work that measurement separated no models on, and a verifier seat buys quality with lineage mixing, not rank. Scoring an open artifact on axes is not verify — that is `judge`, and it is judgment.

The two defaults never trade. Mechanical fans are wide and absorb distribution; judgment fans are a handful of seats, so holding them to class costs little — and quality lost at a judgment seat is unrecoverable downstream, because a judge only selects among what was proposed and a synthesis only composes what exists.

## The procedure

1. **Name each seat's role in one word.** If you cannot, fix the stage split first.
2. **Name the regime and the dominant risk** — one word: too little context, unreliable tool use, correlated judgment, convention drift, or incomplete coverage.
3. **Fill judgment seats first.** Rank the reachable identities — readable provider, not `critical` unless the user's spend priority lists it — by quality evidence, and seat every judgment role in the top band. When band-eligible identities number fewer than the fan wants, repeat-seat one as independent runs or shrink the fan; a judgment seat is never filled from below the band to make a count.
4. **Spread the mechanical rest by allowance**, using the fan rules below.
5. **Re-pick effort for the model chosen.** Take a rung the target's `effortLadder` actually lists — an off-ladder level is clamped down with no signal and refused when nothing is below. Where the model carries benchmark rungs, read the score delta between candidate rungs: a gap inside the tie band buys nothing — take the cheaper rung — while a real drop at a judgment seat is capability given away. Check the stage's input against `contextWindow`.
6. **Diversify where disagreement is the product.** A verifier sharing its subject's lineage inherits the same blind spots — judge lineage against the subject, never against this session. Diversity sizes the quorum, not the bulk fan, and works within the band the regime sets.
7. **Confirm each name resolves.** Names register at session start; the reading may carry names this session cannot reach.
8. **Say what carried what.** When provenance matters, the user-facing synthesis names which identities ran which branches and why — the delegation skill's synthesis rules own the wording.

## Seats for the session's own model

An unnamed dispatch inherits the session's model and spends the session's own allowance — the one allowance that can never be selected, only spared. Inheritance chosen for a reason is legitimate; these are the reasons that recur, and each deserves a stated why when it fills a seat, because an unlabelled inheritance and a deliberate one look identical afterwards:

- **Continuity** — the run needs the host's capability class or its conversational context.
- **Cross-lineage verification seat** — a verify quorum wants the session's lineage represented against a subject of a different lineage. Cap it at one such seat per verify stage, and check that the lineage actually differs from the subject's rather than assuming it.
- **Judgment floor** — no band-eligible identity is reachable on a readable, non-`critical` provider (a spend-priority listing overrides the forecast). One seat, with the rest of the fan shrunk or repeat-seated rather than filled from below the band; this buys capability, never convenience.
- **Empty roster** — nothing is exposed; the delegation skill already treats this as keeping the work on the host or stating the handoff is blocked.

Bulk fan-out on the session's model is the pattern with no case: it concentrates spend on the allowance the host itself runs on and collects nothing the roster could not provide.

## Sizing a mechanical fan

- **The task sets the branch count.** An allowance reading never trims it below what the work needs, and a window still called `ok` is not a reason to run fewer branches.
- **A spend priority displaces the even split for the providers it names.** Concentrate on the first listed provider and spill down the list on observed failure; unlisted providers share the remainder evenly.
- **Split evenly across eligible providers** — readable window, not `critical` — with no provider more than one branch above another, counting providers rather than identities: a provider exposing two models does not draw twice the share.
- **One eligible provider left carries the whole fan**, whatever its percentage reads; the only place left to move is the session's own allowance, which the rules above already price.
- **An unreadable allowance joins no even split** — absence is not headroom — but it is not exhausted either: give it a bounded share and promote it once runs return.

## What measurement showed (2026-08-02)

- **Three models against seven stage roles: indistinguishable on five** — structured output, repository search, adversarial judgment, mechanical transformation, and a small well-precedented implementation. Quality parity is the prior on closed roles; the less efficient choice buys nothing.
- **Twelve identities, one identical 12-file mapping task: all twelve answered perfectly**, trap entry included — cheapest 176k total tokens over 5 tool calls, dearest 5.20M over 29. What separated them was measured efficiency, never quota; quota stays a roster verdict, never inferred from token counts.
- **Both measurements were closed tasks.** Parity there licenses nothing about open-ended generation — a proposal or synthesis has no answer key, and a model that spends less there may be answering less. On judgment roles the quality evidence stands.

Three rules the same measurements refuted:

- **A larger context window does not mean better reading.** Mapping a 22-file subsystem, the 1M-window model opened 16 files and a 372k-window model opened all 22. Use the window as a floor, not a ranking.
- **Raising effort does not reliably improve judgment.** The same verification at the lowest and highest rungs produced the same verdict. Effort pays only once a task is hard enough to need it.
- **A local, well-precedented edit does not need the session model.** Every model tested landed it in the right files and matched the surrounding conventions. This does not generalize to sweeping or multi-package work.

## Gotchas

- **Symptom:** A run that fanned across several identities produced uniform-looking results, or one branch's output is missing with no error.
  **Action:** Check whether that branch failed rather than ran — confirm each identity still resolves, and have branches return failures as values.
  **Why:** A de-selected or mistyped identity fails at the gateway, and a fan-out helper that swallows the failure turns a heterogeneous run into a quietly partial one.

- **Symptom:** A judgment seat — a proposal, a synthesis, an axis-scored judgment — ran below the top reachable band.
  **Action:** Treat it as a mis-assigned seat, not a quota win; re-run that seat in the band and keep the cheap identity for the mechanical fans where distribution earns its keep.
  **Why:** Downstream stages only select among and compose what the judgment seats produced, and the run reads complete either way.

- **Symptom:** A stage ran at a different reasoning level than the one requested.
  **Action:** Take a rung that model's ladder actually lists.
  **Why:** Ladders are not uniform, and an off-ladder level is clamped upstream without any signal.
