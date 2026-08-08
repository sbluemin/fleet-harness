---
name: workflow
description: Choose the surface a handoff runs on and pin the identity it runs as, then wire a staged run's stages to each other and keep its failures visible. Load before any run leaves the host — one Agent, a named teammate, or a staged workflow — and before executing a stage skeleton from workflow-architecting, workflow-research, workflow-implementing, or workflow-review. Skip only when the work stays on the host.
---

# Workflow

The other gateway skills own the *shape* of a run. This skill turns that shape into an actual run: the surface it executes on, the identity it runs as, and how its stages are wired.

Two gates open before anything leaves the host, in order. Neither decides *whether* to hand work off — Proportionality already did. Nothing here is a reason to create a run you would not otherwise have made, and avoiding these gates is not a reason to absorb a run you would have made.

## Gate 1 — Execution Surface

Three surfaces, and they are not interchangeable.

| Surface | What it buys | Reach for it when |
|---|---|---|
| **One Agent** | one result, returned whole | **the default** — parts need no wiring between them |
| **A named teammate** | an Agent addressable again with its context intact | one worker must carry several exchanges |
| **The staged workflow surface** | wiring: data between stages, barriers, fan-out, and a fleet of different models working the same problem at once | that wiring is the point |

- **Wiring is the only thing the staged surface buys.** A skeleton never executed as stages is one reader doing every job in one context — the failure the skeleton exists to prevent. A staged run for work that needed one Agent pays the coordination cost and collects none of it back.
- **A surface gated behind user opt-in is unavailable until that opt-in exists.** As of this writing the staged surface wants `ultracode` or a standing session opt-in. That trigger belongs to the harness, not to Fleet — read the live tool description for what it accepts now. It is a session opt-in and never a reasoning-effort rung; requesting it as one is clamped upstream without a signal.
- **A closed gate is not a defect.** Report the gate, say what the staged run would cost and buy, and wait. Do not quietly do the work yourself in one context instead.
- **Call mechanics stay out of this skill on purpose.** Argument names, script syntax, and accepted values live in the live tool description — read them there every time, and inspect the live surface before concluding anything, since tools may be lazy-loaded.

## Gate 2 — Model Pin Gate

Every run that leaves the host carries a pinned identity. **An unpinned run is not the neutral choice** — it inherits the session's own model and spends the session's own allowance, reached by omission rather than by selection.

**Call `gateway_models` first, every time.** Not once per session: allowances move while work is in flight, and a gate cleared against a remembered roster is not cleared.

### Two axes, never collapsed

| Axis | What it reads | What it decides |
|---|---|---|
| **Lineage** | `homolineage: true` marks a Claude-family model, derived from the model id alone and silent about what this session runs on | This axis decides independence, never cost. |
| **Allowance** | the provider entry a model sits under — whose subscription the run bills to | This axis decides cost, never independence. |

They come apart: an identity can carry Claude lineage while billing elsewhere, which is a legitimate way to move spend. The rule below binds the allowance axis only.

### The session's own allowance is the last one to spend

Identify which allowance that is first, because the roster cannot tell you — it reports what this session exposes, never what this session itself runs on. Read your own model id and find the provider that bills it. Both cases below are visible; every provider's allowance is reported, the parent subscription included. What differs is what you can do about it.

| This session runs on | The failure to avoid |
|---|---|
| a built-in Claude model | It spends the `claude` entry, which reports a window but serves no roster model, so **it can never be selected, only inherited** — spare it by pinning away, not by choosing it. |
| a gateway default | **A session launched on a gateway default spends an entry that both reports *and* serves**, so routing more runs there **drains one allowance twice** while the rest sit idle. |

`isSessionDefault` does not settle which case you are in: it reflects Settings as they stand now, not what an already-running session launched with. Prefer any other provider with room — whatever this session runs on is the most expensive way to obtain what any identity produces equally well.

### Four exceptions, and only these four.

Each is recorded by its label in the split record.

- **E1 — cross-lineage verification.** All three must hold: the role is `verify`, `judge`, or `adjudicate`; disagreement is that stage's actual product; and the lineage this run would inherit differs from the subject's. That last one is a check, never an assumption — an unpinned run takes whatever this session launched on, and the flag describes a model, not this session. **Cap the session's lineage at one verifier seat per verify stage**, fixed by the stage's need before you read the roster. Among the *other* lineages one lineage must not hold a majority of the quorum; when too few remain, shrink the quorum rather than add session-lineage seats. The seat is a verification exception, not a scarcity response.
- **E2 — last resort.** Every candidate's own window reads `critical`, or runs keep returning empty after a retry. A provider the user listed in `providerPriority` never opens E2 on its forecast — the owner ordered it drained, so for a listed provider only observed failure counts. An allowance that could not be read is **not** evidence of exhaustion, so it can neither open this exception nor close it. When E2 opens, run one alternative identity alongside and compare — a last resort nobody checked is an unpinned run with a label on it.
- **E3 — empty roster.** No model is exposed at all.
- **E4 — judgment floor.** All three must hold: the seat's role is a judgment role; no identity of the quality band that role requires is reachable on a readable, non-`critical` provider (a `providerPriority` listing overrides the forecast); and the session's model takes **at most one seat per stage**, with the rest of the fan shrunk or repeat-seated under the assignment rules rather than filled from below the band. E4 buys capability, never convenience — one reachable band-eligible identity, however busy its provider short of `critical`, closes it.

An unclassed entry opens no exception of its own: a model the catalog can neither class nor measure (a routing alias) simply takes no judgment seat, and a mechanical seat still falls to allowance — never back to this session's model.

## Reading a Stage Skeleton

Every gateway skeleton is a table of `Stage | Role | Fan | Returns`.

- **Role** — the one-word job: decompose, map, scan, extract, transform, implement, verify, propose, decide, judge, synthesize. It is the input to model assignment, which first sorts it into a regime — judgment or mechanical — below.
- **Fan** — parallel branches. `one per <item>` is sized by the previous stage's output, not by a number you pick. **`host only` is not a stage you hand off** — it is a barrier where you do the work yourself.
- **Returns** — the contract. Declare a schema rather than parsing prose: a stage that must fill a shape retries against it, while a stage asked for prose improvises.

## Pipeline by Default

**Pipeline unless stage N+1 genuinely needs the whole set at once** — deduplicating before expensive downstream work, deciding literals every branch shares, early-exit on zero, or comparing one result against the others.

A barrier is **not** justified by needing to flatten, map, or filter between stages (do that inside a stage), by stages feeling conceptually separate, or by the script reading cleaner. Each unjustified barrier costs the gap between slowest and fastest branch, on every item, for nothing. The barriers a skeleton already names — `workflow-implementing`'s Decide, `workflow-review`'s Adjudicate — are load-bearing; do not optimize them away.

## Failures Must Be Loud

A fan-out helper turns a failed branch into an empty result, so a run that lost three of eight branches reads as a thorough run over a quiet subject.

- Have each stage **return its failure as a value**, not throw into the helper.
- Check the branch count against what you started before synthesizing. A missing branch is a finding.
- Never report coverage you did not verify. Say so when the run capped, sampled, or dropped anything.

## Model and Effort Assignment

Every role belongs to one of two regimes, and the regime decides what its seats optimize for:

| Regime | Roles | The test | What fills a seat |
|---|---|---|---|
| **Judgment** | decompose, propose, decide, judge, synthesize | the output is an opinion the run commits to, with no external answer key | quality evidence first: `benchmark` where measured, the `capabilityClass` prior where not; seats keep to the top band reachable on a readable, non-`critical` provider (a `providerPriority` listing overrides the forecast), and allowance decides only among band peers |
| **Mechanical** | map, scan, extract, transform, implement, verify | the output is checkable — against the codebase, the sent literals, or a concrete failing scenario | allowance, by the distribution rules below |

Distribution is the default for mechanical roles; for judgment roles the top reachable quality band is the default. The two defaults never trade, and their costs differ by construction: mechanical fans are wide and absorb distribution, judgment fans are a handful of seats, so holding them to class costs little. Quality lost at a judgment seat is unrecoverable downstream — a judge only selects among what was proposed, a synthesis only composes what exists.

`verify` is mechanical deliberately: refuting a concrete finding is closed work the measurements below separated no models on, and what a verifier seat buys quality with is lineage mixing, not class. Scoring an open artifact on axes is not verify — that is `judge`, and it is judgment.

The session's own allowance is the last one to spend in both regimes, and its first-priority use is orchestration on the host itself, never bulk fan-out. Concentrating a run on this session's model is the exception, and the exception carries the burden of proof — Gate 2 above is where that burden is discharged.

1. **Name the role.** Take it from the Role column. If you cannot name it in one word, fix the stage split first.
2. **Name the regime and the dominant risk.** The regime comes from the table above; the risk is one word, not a list: too little context, unreliable tool use, correlated judgment, convention drift, or incomplete coverage.
3. **Fill judgment seats before spreading anything.** Rank the reachable identities — readable provider, not `critical` unless the user listed it in `providerPriority` — by the quality-evidence rules below and seat every judgment role in the top band. When band-eligible identities number fewer than the fan wants, repeat-seat one as independent runs or shrink the fan — a judgment seat is never filled from below the band to make a count. Two seats on one identity lose lineage spread between them and keep blind independence, the cheaper loss. When no identity of the required band is reachable at all, E4 above is the only door — one session-model seat, recorded.
4. **Spread the mechanical rest by allowance**, using the two subsections below.
5. **Re-pick effort for the model you chose.** A level a model does not advertise is clamped down with no signal and refused when nothing is below. Take a rung the target's `effortLadder` actually lists — it reports what this session registered, not the catalog — and check the stage's input against its `contextWindow`. Where the model carries `benchmark` rungs, read the score delta between candidate rungs: a gap inside `noiseBandPoints` buys nothing — take the cheaper rung — while a real drop at a judgment seat is capability given away.
6. **Diversify where disagreement is the product.** A verifier sharing its subject's lineage inherits the same blind spots. Judge that against the **subject**, not against this session: a Claude-family identity billed elsewhere is useful for moving spend, useless for independence from a Claude-family session, and silent about independence from a subject that ran elsewhere. An unpinned stage has no lineage of its own. Diversity sizes the quorum, never the bulk fan-out — and in a judgment stage it works within the band the regime sets, never below it.
7. **Confirm the name exists on both sides.** The roster resolves live; Agent names were fixed at session start. `400 unknown model` means re-read the roster. Reaching a newly enabled model requires a new session.
8. **Record the split.** Which identities carried which stages, what decided it, and the `E1` / `E2` / `E3` / `E4` label wherever the session's model carried one. An unlabelled exception is indistinguishable from a lapse.

### Reading quality evidence

- **Measurement outranks the claim.** `benchmark` on a model's constraints is third-party measured evidence about the vendor model; `capabilityClass` is the provider's claim about its own lineup. Where figures exist at the rung you would request, rank by them — a measured `standard` model above the band beats an unmeasured `flagship` claim, and a `flagship` label with weak figures earns no seat the numbers refuse it. Where no figures exist, the class prior stands.
- **Scores compare only within one source.** `source` names the harness behind the figures; different sources measure different task sets on different scales, so a number from one never orders against a number from another. Read a cross-source candidate by its standing among its own source's comparators — top-of-source beats claim-only, whatever the absolute numbers — and where standing cannot separate two candidates, the class prior breaks the tie. Token figures are source-relative too: a `tokensPerTask` from one harness never prices against another's.
- **Scores within `noiseBandPoints` are one band, not an ordering.** Within a band prefer the lower `tokensPerTask`, then let allowance decide. Reading a one-point gap as a ranking abandons a cheaper identity for nothing.
- **Read `caveat` before trusting a standout.** A caveat travels with its figures because it changes what they are evidence of — a contaminated score, an unknown serving rung.
- **An effortless identity's rung map is a range.** With no effort control, which measured rung the serving path reaches is unknown — read the spread, not the best row. `overall` figures carry no rung at all and compare across identities, not across efforts.

### Reading an allowance

- **Read the window that belongs to the model** — the one whose `scope` matches `constraints.quotaScope` when the model declares one, and the provider's scope-less window when it does not.
- **The roster's verdict outranks arithmetic of your own.** Prefer `pressure: "ok"`, treat `"elevated"` as a reason to rebalance toward a lighter provider rather than a prohibition, and send nothing to `"critical"` unless every alternative is worse. A window the roster calls `ok` is usable at any percentage; re-deriving risk from `usedPercent` or `paceRatio` to overrule it is how a healthy provider gets abandoned — one payload can carry a 35% window marked `elevated` beside a 64% window marked `ok`.
- **`providerPriority` is the user's standing order on this axis.** When the payload carries it, listed providers spend first, in order, everywhere allowance decides — mechanical fans concentrate there, and ties between band peers in judgment seats break there. It outranks the pressure forecast, `critical` included: the owner chose to drain that allowance, so leave a listed provider only on observation — runs returning empty after a retry — never on the forecast alone. A listed provider's identities stay eligible for judgment seats at any forecast. It never lifts an identity across a quality band, never touches the lineage rules, and an absent field changes nothing.
- **Percentages compare only within one clock.** Break a tie between windows that share a `cadence` by the lower `usedPercent`, and never compare percentages across cadences — a weekly window at 49% early in its week burns hotter than a monthly one at 78% near its reset, and `paceRatio` above 1.0 says so directly.
- **On an older reading with no derived fields**, treat percentages as comparable only within a single provider's windows — a shared id like `cycle` does not mean a shared length — and across providers trust only the extreme: a window near 100 is spent whatever its clock.
- **A scope is declared only where one subscription splits into pools.** There the scope-less figure is marked `isAggregate` — a sum that can read healthy while the model's own pool is spent, and one that stays out of headroom math.

### Sizing a bulk fan-out

- **This subsection sizes mechanical fans only.** A judgment fan is sized in step 3 above — band availability may shrink it; allowance still never does.
- **The task sets the branch count and an allowance reading never trims it.** A window still called `ok` is not a reason to run fewer branches than the work needs.
- **A `providerPriority` list displaces the even split for the providers it names.** Concentrate the fan on the first listed provider and spill down the list on observed failure; providers the list omits share the remainder evenly under the rules below, the `critical` exclusion included.
- **Split evenly across eligible non-session providers** — those whose applicable window is readable and not `critical` — no provider more than one branch above another.
- **Count providers, not identities.** A provider exposing two models does not draw twice the share.
- **One eligible provider left carries the whole fan-out**, however high its `usedPercent` reads and whether its pressure is `ok` or `elevated`. A sole remaining provider is where "rebalance off elevated" stops applying, because the only place left to move is the session's own allowance.
- **An unreadable allowance joins no even split** — absence is not headroom — but it is not exhausted either: give it a bounded share and promote it once runs return. When the even split comes out empty those bounded shares *are* the fan-out; an unreadable allowance never opens E2.

## What Measurement Actually Showed

Two measurements, both on 2026-08-02.

| Measurement | Result | What it means |
|---|---|---|
| Three models against seven stage roles | **indistinguishable on five of them** — structured output, repository search, adversarial judgment, mechanical transformation, a small implementation task | quality parity is the prior on closed roles |
| Twelve identities, one identical 12-file mapping task | **all twelve answered it perfectly**, trap entry included; cheapest **176k total tokens over 5 tool calls**, dearest **5.20M over 29**; output alone 1.7k–20.3k, so **not a cache-read artifact** | what separated them was measured efficiency, not provider quota |

Parity is exactly why a mechanical seat needs no quality justification — the cheaper distribution buys the same answer. **Indistinguishable never meant "inherit"; it means the less efficient choice buys nothing.** Quota pressure remains a separate roster verdict, never inferred from token counts.

**Both measurements were closed tasks** — work with a single correct answer, where spend can be compared at held quality. Parity measured there licenses nothing about open-ended generation: a proposal, a synthesis, or an axis-scored judgment has no answer key, and a model that spends less there may be answering less. On judgment roles the quality evidence stands as the prior — bench figures where measured, the capability class where not.

Three rules the same measurements refuted:

- **A larger context window does not mean better reading.** Mapping a 22-file subsystem, the 1M-window model opened 16 files and a 372k-window model opened all 22. Use the window as a floor, not a ranking.
- **Raising effort does not reliably improve judgment.** The same verification task at the lowest and highest rungs produced the same verdict. Effort pays only once a task is hard enough to need it.
- **A local, well-precedented edit does not need the session model.** Every model tested landed it in the right files and matched the surrounding conventions. This does **not** generalize to sweeping or multi-package work.

The roster now carries a second body of evidence beside these: third-party `benchmark` figures on a model's constraints, measured on open-ended agentic work Fleet did not run. The two compose rather than compete — Fleet's parity holds on closed roles, and the bench separates identities exactly where judgment is the product; its reading rules live above.

## Handing Work to a Different Model

Decisions must travel as literal values, not descriptions: name the exact token, path, setting key, or constant, and never write "match the existing style". On return, check the artifacts against the literals you sent — an equivalent-looking substitution is a defect, not a variation.

## Gotchas

- **Symptom:** A run left the host on the session's own model and nothing in the report says why.
  **Action:** Treat it as a gate that never opened rather than as a choice. Re-read Gate 2, name the exception that applied, and if none did, repeat the run pinned.
  **Why:** The session's allowance is reached by omission rather than by selection, so this failure leaves no trace of its own — an unlabelled inheritance and a deliberate `E1` look identical afterwards.

- **Symptom:** A run that pinned several models produced uniform-looking results, or one stage's output is missing with no error.
  **Action:** Check whether that branch failed rather than ran. Confirm each pinned id is still in the roster and return branch failures as values instead of letting the helper collapse them.
  **Why:** A de-selected or mistyped id fails at the gateway, but the fan-out helper turns a failed branch into an empty slot, so a heterogeneous run silently becomes a partial one.

- **Symptom:** A stage ran at a different reasoning level than the one requested.
  **Action:** Read that model's ladder from the roster and request a level it actually advertises.
  **Why:** Ladders are not uniform — some models have no `medium`, others no effort control at all — and an off-ladder level is clamped upstream without any signal.

- **Symptom:** A provider looked like it had room, but its requests began failing.
  **Action:** Read the window whose `scope` matches the model's `quotaScope`, not the provider's combined figure.
  **Why:** One subscription can bill through separate pools; the sum can read comfortable while the pool a given model draws from is nearly spent.

- **Symptom:** A stage returned nothing at all — no result, no error you can quote — while other stages on the same provider succeeded.
  **Action:** Treat a `"critical"` pressure — or a `usedPercent` near 100 — on that model's own window as the explanation and move those stages to another provider. Do not wait for a message that says exhausted.
  **Why:** There is no exhaustion status. `status` distinguishes *reading* failures — not connected, signed out, expired, no subscription, stale, error — and a spent pool is visible only in its own window's figures. A stage dying after retries with an empty return is what exhaustion actually looks like from here.

- **Symptom:** A provider the user listed first in `providerPriority` reads `critical`, and the fan was quietly rebalanced away from it.
  **Action:** Put the work back. Pressure is a forecast and the priority is the owner's standing order over it; leave a listed provider only on observed failure — empty returns after a retry — and record the spill.
  **Why:** The owner opted into draining that allowance knowing its window. Substituting the forecast for their order is a silent policy reversal no run report shows.

- **Symptom:** A model you just enabled is in `gateway_models` but every attempt to run a stage on it fails as an unknown Agent.
  **Action:** Use only names present in both the live roster and the Agent names this session started with. Reaching a newly enabled model requires a new session.
  **Why:** The roster re-reads the user's selection on every call, but Agent names were serialized once at session start. The two drift apart the moment settings change mid-session.

- **Symptom:** The run took as long as doing it yourself, with the same total cost.
  **Action:** Count the barriers. Each one that no stage actually needed becomes wall-clock spent waiting for the slowest branch.
  **Why:** Staging buys overlap; a skeleton executed as a sequence of barriers pays the coordination cost and collects none of it back.

- **Symptom:** A stage came back asking what to do, or made a choice the skeleton reserved for the host.
  **Action:** Move that decision to the preceding host-only barrier and run the stage again with the value spelled out.
  **Why:** A stage handed an open decision always closes it, differently in each branch — which is the failure the barrier was placed there to prevent.

- **Symptom:** A judgment stage — a proposal, a synthesis, an axis-scored judgment — ran on an identity below the top reachable quality band.
  **Action:** Treat it as a mis-assigned seat, not a quota win. Re-run that seat in the top band — bench figures first, class where unmeasured — and keep the cheap identity for the mechanical fans where distribution earns its keep.
  **Why:** Downstream stages only select among and compose what the judgment seats produced, and the allowance axis cannot see what a weak seat silently cost — the run reads complete either way.
