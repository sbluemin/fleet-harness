---
name: workflow
description: Run a staged multi-agent operation — map a stage skeleton onto the workflow execution surface, choose pipeline or barrier between stages, keep failures visible, and assign each stage its model and reasoning effort. Load before executing any skeleton from architecture-review, codebase-research, implementation-run, or quality-review, and before pinning a model or effort anywhere. Skip when the work is one stage you will perform directly.
---

# Workflow

The other gateway skills each own the *shape* of a run — which stages exist, what each returns, where the judgment stays on the host. This skill owns **turning that shape into an actual run**: the surface it executes on, how stages are wired to each other, and what each stage runs on.

A skeleton that is never executed as stages is not a cheaper version of the run. It is a single reader doing every job in one context, which is the failure mode the skeleton exists to prevent.

## Execution Surface

Staged execution requires the workflow execution surface — the one that runs a script of stages, wires them together, and lets each stage carry its own model and effort. Inspect the live tool surface before concluding anything about it; tools may be lazy-loaded.

This skill covers that surface only, and that surface is not the default. An Agent — one run, or a named teammate you can continue — carries work that needs no wiring between its parts, and the Orchestration Policy Standing Order makes it the default for exactly that reason. A staged run is what the user asks for on top of it, and what it buys is the wiring: data flowing between stages, barriers, fan-out, and a fleet of different models working the same problem at once. Model and effort assignment below applies to both surfaces.

**A surface gated behind user opt-in is unavailable until that opt-in exists.** Some workflow surfaces refuse to run unless the user explicitly asked for a multi-agent run. That refusal is not a defect and it is not a reason to quietly do the whole thing yourself in one context. Report the gate, say what the staged run would cost and what it would buy, and wait — the same way you would report any unavailable surface.

Two things stay out of this skill on purpose:

- **Call mechanics.** Argument names, script syntax, return shapes, and which values a field accepts live in the live tool description. Read them there every time. Anything restated here would be a copy that goes stale silently.
- **Whether to run at all.** That is the Orchestration Policy Standing Order's call, not this skill's.

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

## Model and Effort Assignment

Distribution is the default. Concentrating a run on the model this session happens to run on is the exception, and the exception carries the burden of proof — the binding rule is in the Orchestration Policy Standing Order. This is the procedure that discharges it.

**Call `gateway_models` first, every time.** Not once per session: allowances move while work is in flight, and a roster entry can be enabled or disabled between two runs.

Work through these in order.

1. **Name the role.** Take it from the skeleton's Role column. If you cannot name it in one word, the stage boundary is wrong; fix the split before choosing a model.
2. **Name the dominant risk.** What would ruin *this* stage: too little context, unreliable tool use, correlated judgment, drift from repository convention, or incomplete coverage. One risk, not a list.
3. **Look for a measured fit.** Read `roleFit` for that risk. A declared `fit` is a reason to prefer an identity and a declared `unfit` a reason to avoid it. `null` means unmeasured: it says nothing about quality, and it is never a reason to fall back to the session model.
4. **Spread the rest by allowance.** For every stage with no measured fit, choose by cost. Read the window that belongs to the model — the one whose `scope` matches `constraints.quotaScope` when the model declares one, and the provider's scope-less window when it does not — then send stages toward the lower `usedPercent`. A scope is declared only where one subscription splits into pools; there, and only there, the scope-less figure is a sum that can read healthy while the model's own pool is spent. Move off a provider as it approaches exhaustion instead of discovering it mid-run.
5. **Re-pick effort for the model you chose.** Ladders differ between identities. A level a model does not advertise is clamped down to the next rung below it with no signal to you, and rejected outright when nothing is below. Take a rung the target's `effortLadder` actually lists, and check the stage's input against the target's `contextWindow`.
6. **Diversify where disagreement is the product.** A majority-vote or judging stage wants different lineages — a verifier sharing its subject's lineage inherits the same blind spots. `homolineage: true` marks an identity sharing the parent Claude session's lineage: useful for moving spend, useless for independence.
7. **Confirm the name exists on both sides.** Roster membership resolves live, but Agent names were fixed when the session started. Pick only a name present in both; a model enabled mid-session is unreachable until restart. `400 unknown model` means re-read the roster.
8. **Do not choose the load-bearing stage by allowance alone.** When everything downstream rests on one stage — the contract survey, the final synthesis, the integrating judgment — let measured fit and lineage independence decide it, and let cost break ties only after those.
9. **Record the split.** One line per run: which identities carried which stages, and what decided it. A distribution nobody can audit is indistinguishable from a random one.

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
  **Action:** Treat a high `usedPercent` on that model's own window as the explanation and move those stages to another provider. Do not wait for a message that says exhausted.
  **Why:** There is no exhaustion status. `status` distinguishes *reading* failures — not connected, signed out, expired, no subscription, stale, error — and a spent pool is visible only as `usedPercent` near 100. A stage dying after retries with an empty return is what exhaustion actually looks like from here.

- **Symptom:** A model you just enabled is in `gateway_models` but every attempt to run a stage on it fails as an unknown Agent.
  **Action:** Use only names present in both the live roster and the Agent names this session started with. Reaching a newly enabled model requires a new session.
  **Why:** The roster re-reads the user's selection on every call, but Agent names were serialized once at session start. The two drift apart the moment settings change mid-session.

- **Symptom:** The run took as long as doing it yourself, with the same total cost.
  **Action:** Count the barriers. Each one that no stage actually needed becomes wall-clock spent waiting for the slowest branch.
  **Why:** Staging buys overlap; a skeleton executed as a sequence of barriers pays the coordination cost and collects none of it back.

- **Symptom:** A stage came back asking what to do, or made a choice the skeleton reserved for the host.
  **Action:** Move that decision to the preceding host-only barrier and run the stage again with the value spelled out.
  **Why:** A stage handed an open decision always closes it, differently in each branch — which is the failure the barrier was placed there to prevent.
