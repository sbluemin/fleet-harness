---
name: workflow
description: Choose the surface a handoff runs on and pin the identity it runs as, then wire a staged run's stages to each other and keep its failures visible. Load before any run leaves the host — one Agent, a named teammate, or a staged workflow — and before executing a stage skeleton from architecture-review, codebase-research, implementation-run, or quality-review. Skip only when the work stays on the host.
---

# Workflow

The other gateway skills each own the *shape* of a run — which stages exist, what each returns, where the judgment stays on the host. This skill owns **turning that shape into an actual run**: the surface it executes on, the identity it runs as, how stages are wired to each other, and what each stage runs on.

Two gates open before anything leaves the host, in order. Neither decides *whether* to hand work off — that is the Orchestration Policy Standing Order's Proportionality call, already made before you arrive here. Work that belongs on the host stays on the host, and nothing in this skill is a reason to create a run you would not otherwise have made. Equally, avoiding these gates is not a reason to absorb a run you would have made.

## Gate 1 — Execution Surface

Three surfaces, and they are not interchangeable.

- **One Agent** — a single run whose result comes back whole. This is the default. Work whose parts need no wiring between them belongs here.
- **A named teammate** — an Agent you can address again later with its context intact. Reach for it when the same worker must carry several exchanges rather than one.
- **The staged workflow surface** — a script of stages wired to each other, with data flowing between them, barriers, fan-out, and a fleet of different models working the same problem at once. That wiring is the only thing it buys, and it is what the user asks for on top of the default.

Reach past the default only when the wiring is the point. A skeleton that is never executed as stages is not a cheaper version of the run — it is a single reader doing every job in one context, which is the failure mode the skeleton exists to prevent. The inverse is equally wrong: a staged run for work that needed one Agent pays the coordination cost and collects none of it back.

**A surface gated behind user opt-in is unavailable until that opt-in exists.** The staged workflow surface refuses to run unless the user explicitly asked for a multi-model run — as of this writing by naming `ultracode`, or through a standing session-level opt-in the harness confirms. That trigger belongs to the harness, not to Fleet: read the live tool description for what it accepts now, and treat the keyword named here as the last thing anyone checked rather than as the contract. It is a session opt-in and never a reasoning-effort rung — requesting it as one is off-ladder and clamped upstream without a signal.

When the gate is closed, that refusal is not a defect. Report the gate, say what the staged run would cost and what it would buy, and wait — the same way you would report any unavailable surface. Do not quietly do the work yourself in one context instead.

Inspect the live tool surface before concluding anything about any of the three; tools may be lazy-loaded.

**Call mechanics stay out of this skill on purpose.** Argument names, script syntax, return shapes, and which values a field accepts live in the live tool description. Read them there every time. Anything restated here would be a copy that goes stale silently.

One narrow exception, and it exists because the rule above cannot reach: **an option the live description does not carry cannot be read there.** Where Fleet depends on such an option, this skill states it, says how it was verified and when, and warns that it can disappear without an error. `stallMs` is the only entry today. Nothing else earns the exception — if the live description carries a field, read it there.

## Gate 2 — Model Pin Gate

Every run that leaves the host carries a pinned identity. An unpinned run is not the neutral choice: it inherits the session's own model and spends the session's own allowance, reached by omission rather than by selection. Closing that omission is this gate's whole job.

Two fields can carry that pin, and **exactly one of them appears on any run.** A roster identity name already carries its model *and* its rung, so nothing goes beside it; a raw model id carries neither, so it needs the rung named separately. **Never both.** Passing an identity name and a model id together is not a syntax error and produces no warning — the explicit model overrides the identity's own, so the run reports one identity and bills another. That is this gate's own failure arriving through a field you filled in rather than one you left blank.

**Call `gateway_models` first, every time.** Not once per session: allowances move while work is in flight, and a roster entry can be enabled or disabled between two runs. A gate cleared against a remembered roster is not cleared.

Read the response on two axes and never collapse them.

- **Lineage** — whose blind spots an identity inherits. `homolineage: true` marks a Claude-family model, derived from the model id alone and silent about what this session runs on; it is a "same as me" flag only when this session is itself Claude-family. This axis decides independence, never cost.
- **Allowance** — whose subscription a run bills to. Every model sits under the provider entry it spends. This axis decides cost, never independence.

The two come apart. An identity can carry Claude lineage while billing to another provider's subscription, and that combination is a legitimate way to move spend. The rule below binds the allowance axis only.

**The parent session's own allowance is the last one to spend, not the first.** Identify which allowance that is before applying the rule, because the roster cannot tell you: it reports what this session exposes, never what this session itself runs on. Read your own model id and find the provider that bills it.

Two cases, and they differ in what you can do about it, not in what you can see — every provider's allowance is reported, the parent subscription included. A session running a built-in Claude model spends the `claude` entry, which reports its window like any other but serves no roster model by design, so it can never be selected, only inherited: read its pressure to know where you stand, and spare it by pinning away from it rather than by choosing it. A session launched on a gateway default spends an entry that both reports *and* serves; there the failure is recursion — routing more runs to the entry already carrying this session drains one allowance twice while the rest sit idle. `isSessionDefault` does not settle which case you are in: it reflects Settings as they stand now, not what an already-running session launched with.

Prefer any other provider with room: whatever this session runs on is the most expensive way to obtain what any identity produces equally well.

Three exceptions, and only these three. Each is recorded by its label in the split record.

- **E1 — cross-lineage verification.** All three must hold: the role is `verify`, `judge`, or `adjudicate`; disagreement is that stage's actual product; and the lineage this run would inherit differs from the subject's. That last one is a check, never an assumption — an unpinned run takes whatever this session was launched on, and a session launched on a non-Claude gateway default inherits *that* lineage, which can be the subject's own. Reading `homolineage` off the roster does not answer it either: the flag describes a model, not this session. When the condition does hold, the voice you already are is the independent one and pinning elsewhere to obtain the same lineage is ceremony. Cap it there — one lineage must not hold a majority of the quorum, or the independence it was admitted for is gone.
- **E2 — last resort.** Every candidate identity's own window reads `critical`, or runs against them keep returning empty after a retry. A provider whose allowance could not be read is **not** evidence of exhaustion — absence is never safety — so it can neither open this exception nor close it. When E2 opens, run one alternative identity alongside and compare the two results; a last resort nobody checked is an unpinned run with a label on it.
- **E3 — empty roster.** No model is exposed at all, so there is nothing to pin to.

When none of the three applies, the session's own model is out and the choice falls to the procedure below. `roleFit: null` is not a fourth exception: unmeasured means quality gave no reason to prefer anyone, so the choice falls to allowance and never back to this session's model.

## Reading a Stage Skeleton

Every gateway skeleton is a table of `Stage | Role | Fan | Returns`. Read it as an execution plan:

- **Role** is the one-word job — map, propose, implement, verify, synthesize, transform. It is also the input to model assignment below.
- **Fan** is how many parallel branches that stage runs. `1` is one branch. `one per <item>` is a fan-out sized by the previous stage's output, not by a number you pick. **`host only` is not a stage you hand off** — it is a barrier where you do the work yourself, and handing it off defeats the skeleton.
- **Returns** is the contract. When a stage returns structured data, declare the schema rather than parsing prose; a stage that must fill a shape will retry against it, while a stage asked to write prose will improvise.

## Pipeline by Default

Between two stages, the choice is pipeline or barrier, and **pipeline is the default**.

A barrier — waiting for every branch of stage N before starting stage N+1 — is correct only when stage N+1 genuinely needs the whole set at once: deduplicating across all results before expensive downstream work, deciding literals every later branch must share, early-exit when the total is zero, or a prompt that compares one result against the others.

A barrier is **not** justified by needing to flatten, map, or filter between stages — do that inside a stage — nor by the stages feeling conceptually separate, nor by the script reading more cleanly. Each unjustified barrier costs the difference between the slowest branch and the fastest, on every item, for nothing.

Each skill's skeleton already names its own barriers, and they are the load-bearing part of that shape. `implementation-run`'s Decide barrier and `quality-review`'s Adjudicate barrier are the two places the run stops being parallel because a single decision must exist before anything downstream. Do not optimize them away.

## Failures Must Be Loud

Fan-out helpers routinely turn a failed branch into an empty result rather than an error. A run that lost three of eight branches then looks like a run that found less, which is indistinguishable from a thorough run over a quiet subject.

- Have each stage **return its failure as a value** — a result that says it failed and why — instead of throwing into the helper.
- Before synthesizing, check the branch count against what you started. A missing branch is a finding.
- Never report coverage you did not verify. If the run capped, sampled, or dropped anything, say so in the report; silent truncation reads as completeness.

## Stall Budget

**Every `agent()` call in a staged run declares `stallMs: 900000`.** Fifteen minutes, the same on every stage. It is not tuned per stage, because what it bounds — how long an identity can go quiet — is a property of the identity and its rung, not of the work you handed it.

What the option bounds is the **longest silent gap, never total runtime.** The watchdog re-arms on every progress signal and is cleared outright while a tool call is in flight, so a stage that streams for an hour never trips it and a stage that thinks in silence trips it on the default at three minutes. Reason about the silence, not the duration.

That silence is real and it is not small. Measured 2026-08-05: a gateway reasoning identity at `high`, given a no-tool reasoning task, emitted **no progress signal at all for two consecutive ten-second stretches**. Nothing bounds that gap at the upper rungs, and the 180000 default cuts the run at three minutes of it.

A trip is not one lost stage. The run is aborted and **respawned from the start, up to five times**, and only then does the call throw. An identity that goes quiet therefore spends the whole budget six times before the script sees an error — which is also the arithmetic against lowering the value: fifteen minutes against six attempts is up to ninety minutes before a genuinely hung run gives up. That is the deliberate trade. A late abort costs wall-clock on a run that was already lost; a premature one destroys a slow reasoning stage that was working, and the two are indistinguishable in the report.

**`stallMs` is absent from the live tool description.** It is read — verified 2026-08-05 on `claude` 2.1.222, where `stallMs: 10000` cut two attempts at 10.017s and 10.027s and respawned between them — but an option no schema carries can be dropped by an upgrade with no error. The failure mode is silent reversion to 180000, never a rejection. Declare the value; never assume it took.

## Model and Effort Assignment

Distribution is the default. Concentrating a run on the model this session happens to run on is the exception, and the exception carries the burden of proof — Gate 2 above is where that burden is discharged, and it names the only three forms the proof can take. What follows is how the remaining choice is made once the gate is clear.

Work through these in order.

1. **Name the role.** Take it from the skeleton's Role column. If you cannot name it in one word, the stage boundary is wrong; fix the split before choosing a model.
2. **Name the dominant risk.** What would ruin *this* stage: too little context, unreliable tool use, correlated judgment, drift from repository convention, or incomplete coverage. One risk, not a list.
3. **Look for a measured fit.** Read `roleFit` for that risk. A declared `fit` is a reason to prefer an identity and a declared `unfit` a reason to avoid it. `null` means unmeasured: it says nothing about quality, and it is never a reason to fall back to the session model.
4. **Spread the rest by allowance.** For every stage with no measured fit, choose by cost. Read the window that belongs to the model — the one whose `scope` matches `constraints.quotaScope` when the model declares one, and the provider's scope-less window when it does not — and let the roster's own verdict lead: prefer windows at `pressure: "ok"`, treat `"elevated"` as a reason to route elsewhere, and send nothing to `"critical"` unless every alternative is worse. Break a tie between windows that share a `cadence` by the lower `usedPercent`, and never compare percentages across cadences — a weekly window at 49% early in its week burns hotter than a monthly one at 78% near its reset, and `paceRatio` above 1.0 says so directly. On an older reading that carries none of the derived fields, treat percentages as comparable only within a single provider's windows — a shared id like `cycle` does not mean a shared length — and across providers trust only the extreme: a window near 100 is spent whatever its clock. A scope is declared only where one subscription splits into pools; there the scope-less figure is marked `isAggregate` — a sum that can read healthy while the model's own pool is spent, and one that stays out of headroom math. Move off a provider as its windows go elevated instead of discovering exhaustion mid-run.
5. **Re-pick effort for the model you chose.** Ladders differ between identities. A level a model does not advertise is clamped down to the next rung below it with no signal to you, and rejected outright when nothing is below. Take a rung the target's `effortLadder` actually lists — the user can expose a model at fewer levels than it supports, and the ladder reports what this session registered, not the catalog — and check the stage's input against the target's `contextWindow`.
6. **Diversify where disagreement is the product.** A majority-vote or judging stage wants different lineages — a verifier sharing its subject's lineage inherits the same blind spots. Judge that against the **subject**, not against this session: a Claude-family identity billed to another provider is useful for moving spend, useless for independence from a Claude-family session, and silent about independence from a subject that ran elsewhere. An unpinned stage has no lineage of its own — it takes whatever this session was launched on — so its independence from the subject is knowable only once you have read your own model id, which is what Gate 2's E1 makes you check.
7. **Confirm the name exists on both sides.** Roster membership resolves live, but Agent names were fixed when the session started. Pick only a name present in both; a model enabled mid-session is unreachable until restart. `400 unknown model` means re-read the roster.
8. **Do not choose the load-bearing stage by allowance alone.** When everything downstream rests on one stage — the contract survey, the final synthesis, the integrating judgment — let measured fit and lineage independence decide it, and let cost break ties only after those.
9. **Record the split.** One line per run: which identities carried which stages, what decided it, and the `E1` / `E2` / `E3` label wherever the session's own model carried one. A distribution nobody can audit is indistinguishable from a random one, and an exception nobody labelled is indistinguishable from a lapse.

### What Measurement Actually Showed

Two measurements, both on 2026-08-02.

Three models against seven stage roles were **indistinguishable on five of them**: structured output, repository search, adversarial judgment, mechanical transformation, and a small implementation task.

Twelve identities were then given one identical mapping task — twelve files, exact line counts, exact export symbols. **All twelve answered it perfectly**: full coverage, no fabricated file, and every one caught the trap entry whose correct answer was an empty list. What separated them was spend. The cheapest finished on 176k total tokens over 5 tool calls; the most expensive spent 5.20M over 29 for the same answer. Output tokens alone ran 1.7k to 20.3k, so this is not a cache-read artifact.

Read the two together. Quality parity is the prior — and parity is exactly what makes cost the deciding axis. **Indistinguishable never meant "inherit"; it means the expensive choice buys nothing.** The roster declares fit only where a measurement separated the models, and reports `null` everywhere else — `null` means unmeasured, never unsuitable.

### Rules That Measurement Refuted

- **A larger context window does not mean better reading.** Asked to map a 22-file subsystem, the 1M-window model opened 16 files and a 372k-window model opened all 22. What separated them was thoroughness in tool use, which no catalog field predicts. Use the window as a floor — can this model hold the input at all — not as a ranking.
- **Raising effort does not reliably improve judgment.** The same verification task at the lowest and highest rungs produced the same verdict with equal reasoning quality. Effort pays only once a task is hard enough to need it; raising it by habit buys nothing and costs throughput.
- **A local, well-precedented edit does not need the session model.** Every model tested landed the change in the right files, found the package's existing export pattern instead of inventing one, and matched the surrounding comment language. This does **not** generalize to sweeping or multi-package work, where convention drift compounds and goes unseen.

### Handing Work to a Different Model

A stage running on another model has no feel for this repository's conventions, so decisions must travel as literal values, not as descriptions. Name the exact token, path, setting key, or constant; never write "match the existing style" or "pick something consistent". On return, check the artifacts against the literals you sent — an equivalent-looking substitution is a defect, not a variation.

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

- **Symptom:** A model you just enabled is in `gateway_models` but every attempt to run a stage on it fails as an unknown Agent.
  **Action:** Use only names present in both the live roster and the Agent names this session started with. Reaching a newly enabled model requires a new session.
  **Why:** The roster re-reads the user's selection on every call, but Agent names were serialized once at session start. The two drift apart the moment settings change mid-session.

- **Symptom:** The run took as long as doing it yourself, with the same total cost.
  **Action:** Count the barriers. Each one that no stage actually needed becomes wall-clock spent waiting for the slowest branch.
  **Why:** Staging buys overlap; a skeleton executed as a sequence of barriers pays the coordination cost and collects none of it back.

- **Symptom:** A stage on a high reasoning rung restarted several times and then threw, or the same stage appears repeatedly in the progress tree with a `(retry N)` label.
  **Action:** Read that stage's `stallMs`. A stage that restarts on a near-round interval was cut by the watchdog, not by the work; confirm the declared value and treat a missing one as the 180000 default.
  **Why:** The watchdog measures silence, and a top-rung identity can think without emitting anything. Each trip respawns the stage from the start rather than resuming it, so one silent identity looks like five separate failures before the call finally throws.

- **Symptom:** The progress tree named one identity, but the spend landed on another provider's allowance.
  **Action:** Check whether that call carried both `agentType` and `model`. Remove the one you did not mean; the pin is exactly one field.
  **Why:** The two are not validated against each other — the explicit `model` overrides the identity's own with no error and no warning, so the label keeps naming the identity you chose while the request goes elsewhere.

- **Symptom:** A stage came back asking what to do, or made a choice the skeleton reserved for the host.
  **Action:** Move that decision to the preceding host-only barrier and run the stage again with the value spelled out.
  **Why:** A stage handed an open decision always closes it, differently in each branch — which is the failure the barrier was placed there to prevent.
